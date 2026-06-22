const express = require("express");
const mongoose = require("mongoose");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const pino = require("pino");

let latestQR = null;

// ─── Process-level safety net ──────────────────────────────────────────────────
// Without these, a single stray error anywhere (a bad API response, a Mongo
// blip, etc.) can crash the whole Node process. Since the reminder cron lives
// in this same process, a crash = missed reminders until something restarts it.
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught Exception:", err);
});

// ─── MongoDB ───────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => { console.error("❌ MongoDB Error:", err.message); process.exit(1); });

const AuthState = mongoose.model("AuthState",
  new mongoose.Schema({ _id: String, data: mongoose.Schema.Types.Mixed }));

const CFData = mongoose.model("CFData",
  new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    members: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastContestAnnounced: { type: Number, default: 0 },
    lastRatingAnnounced: { type: Number, default: 0 },
    reminders: { type: mongoose.Schema.Types.Mixed, default: {} },
  }));

// One document per CF handle (not per group) — the same handle can be
// registered in multiple groups and we never want to fetch/store its
// submissions twice. `// delta7` reads only from this collection.
const SolveHistory = mongoose.model("SolveHistory",
  new mongoose.Schema({
    handle: { type: String, required: true, unique: true },
    solves: {
      type: [{
        key: String,        // `${contestId}-${index}`, same dedupe key getDelta7 uses
        rating: Number,
        points: Number,
        solvedAt: Number,   // submission's real creationTimeSeconds, not discovery time
      }],
      default: [],
    },
    lastSynced: { type: Date, default: null },
  }));

// ─── MongoDB Auth State ────────────────────────────────────────────────────────
async function useMongoAuthState() {
  const writeData = async (key, data) => {
    await AuthState.findByIdAndUpdate(key,
      { data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) },
      { upsert: true });
  };
  const readData = async (key) => {
    const item = await AuthState.findById(key).lean();
    if (!item?.data) return null;
    return JSON.parse(JSON.stringify(item.data), BufferJSON.reviver);
  };
  const removeData = async (key) => { await AuthState.findByIdAndDelete(key); };
  const creds = (await readData("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === "app-state-sync-key" && value)
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data))
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              tasks.push(value ? writeData(`${category}-${id}`, value) : removeData(`${category}-${id}`));
            }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}

// ─── Group Data ────────────────────────────────────────────────────────────────
async function getGroupData(chatId) {
  const group = await CFData.findOne({ chatId }).lean();
  if (!group) return { members: {}, lastContestAnnounced: 0, lastRatingAnnounced: 0, reminders: {} };
  return {
    members: group.members || {},
    lastContestAnnounced: group.lastContestAnnounced || 0,
    lastRatingAnnounced: group.lastRatingAnnounced || 0,
    reminders: group.reminders || {},
  };
}

async function saveGroupData(chatId, groupData) {
  await CFData.findOneAndUpdate({ chatId },
    { $set: {
      members: groupData.members,
      lastContestAnnounced: groupData.lastContestAnnounced,
      lastRatingAnnounced: groupData.lastRatingAnnounced || 0,
      reminders: groupData.reminders || {},
    }},
    { upsert: true });
}

function getAllHandles(groupData) {
  const all = [];
  for (const handles of Object.values(groupData?.members || {}))
    for (const h of handles)
      if (!all.includes(h)) all.push(h);
  return all;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Codeforces Rate Limiter + 429 Auto-Retry ────────────────────────────────
let lastCFRequestAt = 0;
const CF_MIN_GAP_MS = 350;

axios.interceptors.request.use(async (config) => {
  if (config.url && config.url.includes("codeforces.com")) {
    const wait = lastCFRequestAt + CF_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCFRequestAt = Date.now();
  }
  return config;
});

axios.interceptors.response.use(
  (res) => res,
  async (error) => {
    const config = error.config;
    const isCF = config?.url?.includes("codeforces.com");
    const is429 = error.response?.status === 429;
    if (isCF && is429) {
      config.__cfRetryCount = (config.__cfRetryCount || 0) + 1;
      if (config.__cfRetryCount <= 3) {
        const delay = [2000, 4000, 8000][config.__cfRetryCount - 1];
        console.log(`⏳ CF 429 rate-limited — retry ${config.__cfRetryCount}/3 in ${delay / 1000}s: ${config.url}`);
        await sleep(delay);
        return axios(config);
      }
    }
    return Promise.reject(error);
  }
);

// ─── Rank order for promotion detection ──────────────────────────────────────
const RANK_ORDER = [
  "Unrated", "Newbie", "Pupil", "Specialist",
  "Expert", "Candidate Master", "Master",
  "International Master", "Grandmaster",
  "International Grandmaster", "Legendary Grandmaster"
];

function getRankIndex(rank) {
  const idx = RANK_ORDER.indexOf(rank);
  return idx === -1 ? 0 : idx;
}

// ─── Rating → Points Mapping ──────────────────────────────────────────────────
const RATING_TO_POINTS = {
  800: 10,  900: 12,  1000: 14, 1100: 16, 1200: 18,
  1300: 21, 1400: 25, 1500: 29,
  1600: 33, 1700: 39, 1800: 45,
  1900: 52, 2000: 60, 2100: 70,
  2200: 81, 2300: 95, 2400: 110,
  2500: 128, 2600: 149, 2700: 173,
  2800: 201, 2900: 233, 3000: 271,
};

function calculatePointsForRating(rating) {
  if (!rating) return 17;
  const rounded = Math.min(3000, Math.max(800, Math.round(rating / 100) * 100));
  return RATING_TO_POINTS[rounded] || 17;
}

function getRankFromRating(rating) {
  if (rating === undefined || rating === null) return "Unrated";
  if (rating >= 3000) return "Legendary Grandmaster";
  if (rating >= 2600) return "International Grandmaster";
  if (rating >= 2400) return "Grandmaster";
  if (rating >= 2300) return "International Master";
  if (rating >= 2100) return "Master";
  if (rating >= 1900) return "Candidate Master";
  if (rating >= 1600) return "Expert";
  if (rating >= 1400) return "Specialist";
  if (rating >= 1200) return "Pupil";
  return "Newbie";
}

// ─── Codeforces API ───────────────────────────────────────────────────────────
async function getCFUser(handle) {
  try {
    const res = await axios.get(`https://codeforces.com/api/user.info?handles=${handle}`, { timeout: 8000 });
    const u = res.data.result[0];
    return { handle: u.handle, rating: u.rating ?? null, maxRating: u.maxRating ?? null, rank: u.rank ?? "newbie", maxRank: u.maxRank ?? "newbie" };
  } catch { return null; }
}

async function getCFUsers(handles) {
  if (!handles.length) return [];
  try {
    const res = await axios.get(`https://codeforces.com/api/user.info?handles=${handles.join(";")}`, { timeout: 10000 });
    return res.data.result.map((u) => ({ handle: u.handle, rating: u.rating ?? null, maxRating: u.maxRating ?? null, rank: u.rank ?? "newbie", maxRank: u.maxRank ?? "newbie" }));
  } catch { return []; }
}

// ─── Problem Suggestion ────────────────────────────────────────────────────────
// The full CF problemset is large (~10k problems) but barely changes, so it's
// cached in memory for an hour instead of re-fetched on every `// suggest`.
let problemSetCache = { data: null, fetchedAt: 0 };
const PROBLEMSET_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getCFProblemSet() {
  const now = Date.now();
  if (problemSetCache.data && now - problemSetCache.fetchedAt < PROBLEMSET_CACHE_TTL) {
    return problemSetCache.data;
  }
  try {
    const res = await axios.get("https://codeforces.com/api/problemset.problems", { timeout: 15000 });
    if (res.data?.status !== "OK") return problemSetCache.data || [];
    const problems = res.data.result?.problems || [];
    problemSetCache = { data: problems, fetchedAt: now };
    return problems;
  } catch (e) {
    console.error("Error fetching CF problemset:", e.message);
    return problemSetCache.data || []; // serve stale cache rather than nothing, if we have one
  }
}

// A handful of contests (old Technocup/educational rounds aimed at a
// Russian-speaking audience) were never translated, so CF's API returns
// their name in Cyrillic instead of English. Exclude those from suggestions.
function hasNonEnglishName(name) {
  return /[\u0400-\u04FF]/.test(name || ""); // Cyrillic Unicode block
}

// Picks a random problem at the exact requested rating. If none exist at that
// exact rating, falls back to the closest available rating within ±200 so the
// command still returns something useful instead of a flat "not found".
async function getRandomProblemByRating(rating) {
  const problems = await getCFProblemSet();
  const rated = problems.filter((p) => p.rating && p.contestId && p.index && !hasNonEnglishName(p.name));
  if (!rated.length) return null;

  let pool = rated.filter((p) => p.rating === rating);
  if (!pool.length) {
    const withDiff = rated
      .map((p) => ({ p, diff: Math.abs(p.rating - rating) }))
      .filter((x) => x.diff <= 200)
      .sort((a, b) => a.diff - b.diff);
    if (!withDiff.length) return null;
    const closestDiff = withDiff[0].diff;
    pool = withDiff.filter((x) => x.diff === closestDiff).map((x) => x.p);
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Streak ──────────────────────────────────────────────────────────────────
function toISTDateStr(unixSeconds) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const d = new Date(unixSeconds * 1000 + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

async function getCFStreak(handle) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`,
      { timeout: 20000 }
    );
    const subs = res.data.result || [];
    const acDays = new Set();
    for (const s of subs) {
      if (s.verdict === "OK")
        acDays.add(toISTDateStr(s.creationTimeSeconds));
    }
    if (acDays.size === 0) return { current: 0, max: 0 };
    const sortedAsc = [...acDays].sort();
    let maxS = 1, curS = 1;
    for (let i = 1; i < sortedAsc.length; i++) {
      const prev = new Date(sortedAsc[i - 1] + "T00:00:00Z");
      const curr = new Date(sortedAsc[i] + "T00:00:00Z");
      const diffDays = Math.round((curr - prev) / 86400000);
      if (diffDays === 1) { curS++; maxS = Math.max(maxS, curS); }
      else if (diffDays > 1) curS = 1;
    }
    const nowIST = toISTDateStr(Math.floor(Date.now() / 1000));
    let current = 0;
    let cursor = new Date(nowIST + "T00:00:00Z");
    if (!acDays.has(nowIST)) {
      cursor = new Date(cursor.getTime() - 86400000);
    }
    while (true) {
      const dStr = cursor.toISOString().slice(0, 10);
      if (acDays.has(dStr)) {
        current++;
        cursor = new Date(cursor.getTime() - 86400000);
      } else {
        break;
      }
    }
    return { current, max: maxS };
  } catch (e) {
    console.error("getCFStreak error:", e.message);
    return null;
  }
}

// ─── CF User Info Q ──────────────────────────────────────────────────────────
const RATING_RANGES = [
  [800, 1100], [1200, 1300], [1400, 1500], [1600, 1800],
  [1900, 2000], [2100, 2200], [2300, Infinity],
];

function rangeLabel([lo, hi]) {
  return hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
}

async function getCFUserInfoQ(handle) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`,
      { timeout: 20000 }
    );
    const subs = res.data.result || [];
    const solved = new Set();
    const buckets = {};
    for (const range of RATING_RANGES) buckets[rangeLabel(range)] = 0;
    for (const s of subs) {
      if (s.verdict === "OK" && s.problem) {
        const key = `${s.problem.contestId}-${s.problem.index}`;
        if (!solved.has(key)) {
          solved.add(key);
          const r = s.problem.rating;
          if (r) {
            for (const range of RATING_RANGES) {
              if (r >= range[0] && r < range[1]) { buckets[rangeLabel(range)]++; break; }
            }
          }
        }
      }
    }
    return { total: solved.size, buckets };
  } catch { return null; }
}

// ─── CF User Info (scrapes profile) ──────────────────────────────────────────
async function getCFUserInfo(handle) {
  try {
    const [userRes, ratingRes, profileRes] = await Promise.all([
      axios.get(`https://codeforces.com/api/user.info?handles=${handle}`, { timeout: 8000 }),
      axios.get(`https://codeforces.com/api/user.rating?handle=${handle}`, { timeout: 8000 }),
      axios.get(`https://codeforces.com/profile/${handle}`, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" },
      }),
    ]);
    const u = userRes.data.result[0];
    const contests = ratingRes.data.result?.length ?? 0;
    const html = profileRes.data;
    let totalSolved = 0;
    const solvedPatterns = [
      /(\d+)\s*problems?\s*solved/i,
      /solved\s*:\s*(\d+)/i,
      /"problemsSolved"[^>]*>(\d+)/i,
      /Problems solved[^<]*<[^>]+>(\d+)/i,
      /_UserActivityFrame_[^>]*>[\s\S]*?(\d+)\s*problems/i,
    ];
    for (const p of solvedPatterns) {
      const m = html.match(p);
      if (m) { totalSolved = parseInt(m[1]); break; }
    }
    if (!totalSolved) {
      const section = html.match(/solved[\s\S]{0,200}/i)?.[0] || "";
      const num = section.match(/(\d+)/)?.[1];
      if (num) totalSolved = parseInt(num);
    }
    return {
      handle: u.handle,
      rating: u.rating ?? null,
      maxRating: u.maxRating ?? null,
      rank: u.rank ?? "newbie",
      maxRank: u.maxRank ?? "newbie",
      totalSolved,
      ratingBuckets: {},
      contests,
    };
  } catch { return null; }
}

// ─── Compare Helper ─────────────────────────────────────────────────────────
async function getCFUserForCompare(handle) {
  try {
    const userRes = await axios.get(
      `https://codeforces.com/api/user.info?handles=${handle}`,
      { timeout: 8000 }
    );
    const u = userRes.data.result[0];
    const ratingRes = await axios.get(
      `https://codeforces.com/api/user.rating?handle=${handle}`,
      { timeout: 8000 }
    );
    const contests = ratingRes.data.result?.length ?? 0;
    const subRes = await axios.get(
      `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`,
      { timeout: 20000 }
    );
    const subs = subRes.data.result || [];
    const solved = new Set();
    for (const s of subs)
      if (s.verdict === "OK" && s.problem)
        solved.add(`${s.problem.contestId}-${s.problem.index}`);
    return {
      handle: u.handle,
      rating: u.rating ?? null,
      maxRating: u.maxRating ?? null,
      rank: u.rank ?? "newbie",
      maxRank: u.maxRank ?? "newbie",
      totalSolved: solved.size,
      contests,
    };
  } catch (e) {
    console.error(`getCFUserForCompare error for ${handle}:`, e.message);
    return null;
  }
}

// ─── Contest Helpers ──────────────────────────────────────────────────────────
async function getCFContestList() {
  try {
    const res = await axios.get("https://codeforces.com/api/contest.list?gym=false", { timeout: 10000 });
    return res.data.result || [];
  } catch { return []; }
}

async function getContestInfo(contestId) {
  try {
    // IMPORTANT: contestId must be the ONLY query parameter for regular
    // contests. Adding from/count/showUnofficial causes CF to reject with
    // "Only gym and mashup contests are available to non-admin users".
    const response = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}`,
      { timeout: 15000 }
    );
    if (response.data.status === 'OK') {
      const contest = response.data.result.contest;
      const problems = response.data.result.problems || [];
      contest.problems = problems.length;
      contest.problemList = problems.map(p => p.index);
      console.log(`📝 Contest ${contestId} has ${contest.problems} problems:`, contest.problemList.join(' '));
      return contest;
    }
    console.warn(`⚠️ getContestInfo: API rejected — comment: "${response.data.comment}"`);
    return null;
  } catch (error) {
    console.error('Error fetching contest info:', error.message);
    return null;
  }
}

// ─── Upcoming Contests ──────────────────────────────────────────────────────────
async function getCFUpcoming() {
  try {
    const list = await getCFContestList();
    return list
      .filter((c) => c.phase === "BEFORE")
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
      .slice(0, 10)
      .map((c) => ({
        id: `cf-${c.id}`,
        platform: "Codeforces",
        name: c.name,
        startTimeSeconds: c.startTimeSeconds,
        durationSeconds: c.durationSeconds,
        url: `https://codeforces.com/contest/${c.id}`,
      }));
  } catch { return []; }
}

async function getCodeChefUpcoming() {
  try {
    const res = await axios.get("https://competeapi.vercel.app/contests/upcoming/", { timeout: 10000 });
    const now = Date.now();
    return (res.data || [])
      .filter((c) => c.site === "codechef" && c.startTime > now)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, 10)
      .map((c) => ({
        id: `cc-${c.title.replace(/[^a-zA-Z0-9]/g, '-')}`,
        platform: "CodeChef",
        name: c.title,
        startTimeSeconds: Math.floor(c.startTime / 1000),
        durationSeconds: Math.floor(c.duration / 1000),
        url: `https://www.codechef.com/${c.title}`,
      }));
  } catch { return []; }
}

async function getAtCoderUpcoming() {
  try {
    const CLIST_API_KEY = process.env.CLIST_API_KEY || "fddfa6592cd15f600f7abadeb8c74b36836322b2";
    const CLIST_USERNAME = "jenis854cpy";

    const res = await axios.get(
      "https://clist.by/api/v4/contest/",
      {
        params: {
          resource: "atcoder.jp",
          start__gt: new Date().toISOString(),
          order_by: "start",
          limit: 10,
          format: "json",
        },
        headers: {
          Authorization: `ApiKey ${CLIST_USERNAME}:${CLIST_API_KEY}`,
        },
        timeout: 15000,
      }
    );

    const data = res.data?.objects || [];
    if (!data.length) {
      console.log("[AtCoder] No upcoming contests found via Clist.");
      return [];
    }

    console.log(`[AtCoder] Found ${data.length} upcoming contests via Clist.`);
    return data.map((c) => ({
      id: `at-${c.id}`,
      platform: "AtCoder",
      name: c.event,
      startTimeSeconds: Math.floor(new Date(c.start).getTime() / 1000),
      durationSeconds: c.duration,
      url: c.href,
    }));
  } catch (error) {
    console.error("[AtCoder] Clist error:", error.message);
    return [];
  }
}

async function getLeetCodeUpcoming() {
  try {
    const res = await axios.post(
      "https://leetcode.com/graphql",
      { query: `{ allContests { title startTime duration } }` },
      { timeout: 8000, headers: { "Content-Type": "application/json" } }
    );
    const now = Math.floor(Date.now() / 1000);
    return (res.data.data.allContests || [])
      .filter((c) => c.startTime > now)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, 10)
      .map((c) => ({
        id: `lc-${c.title.replace(/[^a-zA-Z0-9]/g, '-')}`,
        platform: "LeetCode",
        name: c.title,
        startTimeSeconds: c.startTime,
        durationSeconds: c.duration,
        url: `https://leetcode.com/contest/${c.title.toLowerCase().replace(/\s/g, '-')}`,
      }));
  } catch { return []; }
}

// ─── Reminder System ──────────────────────────────────────────────────────────
async function checkAndSendReminders(sock) {
  try {
    console.log(`🔄 Running reminder check at ${new Date().toISOString()}`);
    
    const results = await Promise.allSettled([
      getCFUpcoming(),
      getCodeChefUpcoming(),
      getLeetCodeUpcoming(),
      getAtCoderUpcoming(),
    ]);

    const allContests = results
      .filter(result => result.status === 'fulfilled')
      .flatMap(result => result.value);

    if (!allContests.length) {
      console.log("⚠️ No upcoming contests found.");
      return;
    }

    console.log(`🔍 Found ${allContests.length} upcoming contests`);

    const now = Math.floor(Date.now() / 1000);
    const groups = await CFData.find({}).lean();

    for (const group of groups) {
      const chatId = group.chatId;
      if (!chatId.endsWith("@g.us")) continue;

      try {
        const groupData = await getGroupData(chatId);
        const handles = getAllHandles(groupData);
        if (!handles.length) {
          console.log(`⏭️ Skipping ${chatId} – no members.`);
          continue;
        }

        const reminders = groupData.reminders || {};
        let changed = false;

        for (const contest of allContests) {
          const diff = contest.startTimeSeconds - now;
          const minsLeft = Math.round(diff / 60);
          const hoursLeft = Math.round(diff / 3600);

          console.log(`⏰ ${contest.platform} - ${contest.name}: ${hoursLeft}h ${minsLeft % 60}m left`);

          // Day-before reminder. Window widened to (1h, 24h] — previously this
          // was a narrow 22-26h slot, so any downtime/slow API call during
          // that exact 4h window meant the reminder was lost forever. Now,
          // as long as the bot is up *at any point* in that 23h span, it'll
          // catch up on the next 10-min check.
          if (diff > 1 * 3600 && diff <= 24 * 3600 && !reminders[contest.id]?.daySent) {
            const ok = await sendReminder(sock, chatId, contest, "day");
            if (ok) {
              if (!reminders[contest.id]) reminders[contest.id] = { startTimeSeconds: contest.startTimeSeconds };
              reminders[contest.id].daySent = true;
              changed = true;
              console.log(`✅ Day reminder sent for ${contest.id} (${contest.name}) to ${chatId}`);
            } else {
              console.log(`⚠️ Day reminder FAILED to send for ${contest.id} — will retry next cycle`);
            }
          }

          // Hour-before reminder. Window widened to (0, 60min] for the same
          // catch-up reason. Crucially: the flag is ONLY set when sendReminder
          // actually confirms delivery — a failed sock.sendMessage() no longer
          // gets silently recorded as "sent".
          if (diff > 0 && diff <= 60 * 60 && !reminders[contest.id]?.hourSent) {
            const ok = await sendReminder(sock, chatId, contest, "hour");
            if (ok) {
              if (!reminders[contest.id]) reminders[contest.id] = { startTimeSeconds: contest.startTimeSeconds };
              reminders[contest.id].hourSent = true;
              changed = true;
              console.log(`✅ Hour reminder sent for ${contest.id} (${contest.name}) to ${chatId}`);
            } else {
              console.log(`⚠️ Hour reminder FAILED to send for ${contest.id} — will retry next cycle`);
            }
          }
        }

        // Garbage-collect flags for contests that started 2+ days ago so the
        // `reminders` object doesn't grow forever. Based on stored timestamp,
        // not on whether the contest is still in this cycle's fetch result —
        // a single platform's API hiccup (returns []) must never cause us to
        // wipe and resend reminders for contests that are still upcoming.
        for (const [id, r] of Object.entries(reminders)) {
          if (r?.startTimeSeconds && now - r.startTimeSeconds > 2 * 86400) {
            delete reminders[id];
            changed = true;
          }
        }

        if (changed) {
          groupData.reminders = reminders;
          await saveGroupData(chatId, groupData);
        }
      } catch (groupErr) {
        // Isolated per group: one bad group/DB hiccup must not abort the
        // entire cycle and skip every other group's reminders too.
        console.error(`❌ Reminder error for group ${chatId}:`, groupErr.message);
      }
    }
    
    console.log(`✅ Reminder check completed at ${new Date().toISOString()}`);
    
  } catch (error) {
    console.error("❌ checkAndSendReminders error:", error.message);
  }
}

async function sendReminder(sock, chatId, contest, type) {
  const diff = contest.startTimeSeconds - Math.floor(Date.now() / 1000);
  let timeLeft = "";
  if (type === "day") {
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    timeLeft = `${days} day${days>1?'s':''} ${hours} hour${hours>1?'s':''}`;
  } else {
    const hours = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    timeLeft = `${hours}h ${mins}m`;
  }

  const emoji = contest.platform === "Codeforces" ? "🔵" :
                contest.platform === "CodeChef" ? "🟤" :
                contest.platform === "LeetCode" ? "🟡" :
                contest.platform === "AtCoder" ? "🟣" : "⚪";

  let message = `📢 *${contest.platform} Contest Reminder!*\n`;
  message += `${"─".repeat(28)}\n\n`;
  message += `${emoji} *${contest.name}*\n`;
  message += `🕐 Starts in: *${timeLeft}*\n`;
  message += `📅 ${formatIST(contest.startTimeSeconds)}\n`;
  message += `⏱ Duration: ${formatDuration(contest.durationSeconds)}\n`;
  message += `🔗 ${contest.url}\n\n`;
  message += `💪 Good luck, everyone!`;

  try {
    await sock.sendMessage(chatId, { text: message });
    console.log(`✅ Reminder sent for ${contest.id} (${type}) to ${chatId}`);
    return true;
  } catch (e) {
    console.error(`Failed to send reminder to ${chatId}:`, e.message);
    return false;
  }
}

// ─── Helper functions ──────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds || seconds < 0 || isNaN(seconds)) return 'N/A';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return '0m';
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatIST(unixSeconds) {
  if (!unixSeconds) return 'N/A';
  return new Date(unixSeconds * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " IST";
}

// ─── HELPER: getProblemLabels ────────────────────────────────────────────
function getProblemLabels(count) {
  if (!count || count < 1) return '';
  const labels = [];
  for (let i = 0; i < count; i++) {
    let label = '';
    let n = i;
    let safety = 0;
    while (n >= 0 && safety < 10) {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
      safety++;
    }
    labels.push(label);
  }
  return labels.join(' ');
}

// ─── HYBRID STANDINGS SYSTEM ──────────────────────────────────────────────────

// Cache
const standingsCache = new Map();
const CACHE_TTL = {
  CODING: 15000,    // 15s for live
  FINISHED: 60000,  // 60s for finished
  DEFAULT: 30000    // 30s default
};

function getCacheKey(contestId, handles) {
  const sorted = [...handles].sort().join(',');
  return `${contestId}:${sorted}`;
}

function getCached(key) {
  const entry = standingsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > entry.ttl) {
    standingsCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, phase) {
  const ttl = CACHE_TTL[phase] || CACHE_TTL.DEFAULT;
  standingsCache.set(key, { data, timestamp: Date.now(), ttl });
}

// ─── Batched validation ──────────────────────────────────────────────────────
async function validateHandlesBatched(handles, batchSize = 50) {
  console.log(`🔍 Validating ${handles.length} handles in batches of ${batchSize}`);
  const valid = [];
  const invalid = [];

  for (let i = 0; i < handles.length; i += batchSize) {
    const batch = handles.slice(i, i + batchSize);
    const handlesParam = batch.join(';');
    try {
      const res = await axios.get(
        `https://codeforces.com/api/user.info?handles=${handlesParam}`,
        { timeout: 8000 }
      );
      if (res.data.status === 'OK') {
        const found = res.data.result.map(u => u.handle);
        valid.push(...found);
        const missing = batch.filter(h => !found.includes(h));
        invalid.push(...missing);
      } else {
        invalid.push(...batch);
      }
    } catch (e) {
      console.warn(`Batch validation failed: ${e.message}`);
      invalid.push(...batch);
    }
    await sleep(200);
  }

  console.log(`✅ Valid: ${valid.length}, Invalid: ${invalid.length}`);
  return { valid, invalid };
}

// ─── TIER 1: Compliant standings fetch ───────────────────────────────────────
// IMPORTANT: As of CF's current API restrictions, regular (non-gym/mashup)
// contests can ONLY be queried with contestId as the SOLE query parameter.
// Adding handles=, from=, count=, or showUnofficial= causes CF to reject the
// request entirely with: "Only gym and mashup contests are available to
// non-admin users in this method" — even though status looks like a normal
// API error. So we fetch the FULL standings (contestId only) and filter our
// tracked handles out of the complete row list client-side.
async function tier1DirectAPI(contestId, handles) {
  console.log(`🚀 Tier 1: Compliant fetch (contestId-only) for ${handles.length} handles`);
  try {
    const url = `https://codeforces.com/api/contest.standings?contestId=${contestId}`;
    const response = await axios.get(url, { timeout: 20000 });
    const data = response.data;

    if (data.status !== 'OK') {
      console.warn(`⚠️ Tier 1 API rejected request — comment: "${data.comment}"`);
      return { success: false, error: data.comment || 'API error' };
    }

    const result = data.result;
    const problems = result.problems || [];
    const totalProblems = problems.length;
    const contest = result.contest;
    const phase = contest?.phase || 'FINISHED';
    const rows = result.rows || [];

    console.log(`📝 Found ${totalProblems} problems, ${rows.length} total ranklist rows via Tier 1`);

    const handleSet = new Set(handles.map(h => h.toLowerCase()));
    const matchedResults = [];

    rows.forEach(row => {
      const members = row.party.members || [];
      const handle = members[0]?.handle || 'unknown';
      if (!handleSet.has(handle.toLowerCase())) return; // only keep our tracked members

      let solved = 0;
      const problemResults = row.problemResults || [];
      problemResults.forEach(pr => {
        if (pr.points > 0) solved++;
      });
      const rank = row.rank ?? null;
      const penalty = row.penalty ?? 0;
      matchedResults.push({ handle, rank, solved, penalty, totalProblems });
    });

    const found = new Set(matchedResults.map(r => r.handle.toLowerCase()));
    const missing = handles.filter(h => !found.has(h.toLowerCase()));
    missing.forEach(h => {
      matchedResults.push({ handle: h, rank: null, solved: 0, penalty: 0, totalProblems });
    });

    console.log(`✅ Tier 1: matched ${matchedResults.length - missing.length}/${handles.length} tracked handles in standings`);
    return { success: true, results: matchedResults, totalProblems, phase, contest, source: 'direct' };
  } catch (e) {
    console.warn(`⚠️ Tier 1 error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ─── TIER 2: Retry with backoff (same compliant call, CF may be settling) ───
// Right after a contest finishes (or for very fresh contests), CF's
// standings can be briefly unstable. This tier just retries the SAME
// contestId-only compliant call from Tier 1 with exponential backoff,
// rather than trying different (now-broken) parameter combinations.
async function tier2RetryWithBackoff(contestId, handles, maxRetries = 3) {
  console.log(`🚀 Tier 2: Retry-with-backoff for contest ${contestId}`);
  const delays = [3000, 6000, 12000];
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await sleep(delays[attempt - 1] || 12000);
    console.log(`   Retry attempt ${attempt}/${maxRetries}...`);
    const result = await tier1DirectAPI(contestId, handles);
    if (result.success) {
      console.log(`✅ Tier 2: succeeded on retry attempt ${attempt}`);
      return { ...result, source: 'full' };
    }
    console.log(`⚠️ Tier 2 retry ${attempt} failed: ${result.error}`);
  }
  return { success: false, error: 'All Tier 2 retries failed' };
}

// ─── TIER 5: Submission scan ─────────────────────────────────────────────────
async function tier5SubmissionScan(contestId, handles, contestInfo) {
  console.log(`🐢 Tier 5: Submission scan (${handles.length} handles)`);
  const results = [];
  const meta = contestInfo || await getContestInfo(contestId);
  
  if (!meta) {
    return {
      success: false,
      error: 'Cannot fetch contest metadata',
      results: handles.map(h => ({ handle: h, rank: null, solved: 0, penalty: 0, totalProblems: 0 })),
      totalProblems: 0,
      phase: 'UNKNOWN',
      contest: null,
      source: 'submission'
    };
  }

  const startTime = meta.startTimeSeconds;
  const endTime = meta.phase === 'CODING' ? Math.floor(Date.now() / 1000) : startTime + meta.durationSeconds;

  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    try {
      const response = await axios.get(
        `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`,
        { timeout: 15000 }
      );
      const subs = response.data.result || [];
      const contestSubs = subs.filter(s =>
        s.contestId === parseInt(contestId) &&
        s.creationTimeSeconds >= startTime &&
        s.creationTimeSeconds <= endTime
      );
      const solvedSet = new Set();
      let penalty = 0;
      const attempts = {};
      const sorted = contestSubs.sort((a, b) => a.creationTimeSeconds - b.creationTimeSeconds);
      for (const sub of sorted) {
        const problemId = sub.problem.index;
        if (sub.verdict === 'OK' && !solvedSet.has(problemId)) {
          solvedSet.add(problemId);
          const wrong = attempts[problemId] || 0;
          penalty += Math.floor((sub.creationTimeSeconds - startTime) / 60) + wrong * 20;
        } else if (sub.verdict !== 'OK' && !solvedSet.has(problemId)) {
          attempts[problemId] = (attempts[problemId] || 0) + 1;
        }
      }
      results.push({
        handle,
        rank: null,
        solved: solvedSet.size,
        penalty,
        totalProblems: meta.problems || 0
      });
    } catch (e) {
      console.warn(`   ${handle} scan error: ${e.message}`);
      results.push({ handle, rank: null, solved: 0, penalty: 0, totalProblems: meta.problems || 0 });
    }
    if (i < handles.length - 1) await sleep(400);
  }

  console.log(`✅ Tier 5 completed with ${results.length} results`);
  return { success: true, results, totalProblems: meta.problems || 0, phase: meta.phase || 'FINISHED', contest: meta, source: 'submission' };
}

// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────
async function getContestStandings(contestId, handles) {
  console.log(`📊 Hybrid standings for contest ${contestId} (${handles.length} handles)`);

  const cacheKey = getCacheKey(contestId, handles);
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`✅ Cache hit for ${contestId}`);
    return cached;
  }

  let validHandles = handles;
  if (handles.length > 50) {
    const { valid, invalid } = await validateHandlesBatched(handles, 50);
    if (invalid.length) {
      console.log(`⚠️ ${invalid.length} invalid handles will be ignored`);
    }
    validHandles = valid;
  }
  
  if (!validHandles.length) {
    return {
      success: false,
      error: 'No valid handles',
      results: handles.map(h => ({ handle: h, rank: null, solved: 0, penalty: 0, totalProblems: 0 })),
      totalProblems: 0,
      phase: 'UNKNOWN',
      contest: null,
      source: 'none'
    };
  }

  console.log('📌 Using Tier 1 (compliant standings fetch)');
  let result = await tier1DirectAPI(contestId, validHandles);

  if (result.success) {
    console.log('✅ Tier 1 succeeded');
    result.results.sort(compareContestEntries);
    setCache(cacheKey, result, result.phase);
    return result;
  }
  console.log(`⚠️ Tier 1 failed: ${result.error}`);

  console.log('📌 Using Tier 2 (retry with backoff — CF standings may be settling)');
  result = await tier2RetryWithBackoff(contestId, validHandles);

  if (result.success) {
    console.log('✅ Tier 2 succeeded');
    result.results.sort(compareContestEntries);
    setCache(cacheKey, result, result.phase);
    return result;
  }
  console.log(`⚠️ Tier 2 failed: ${result.error}`);

  console.log('📌 Using Tier 3 (submission scan — last resort, no rank)');
  const contestInfo = await getContestInfo(contestId);
  result = await tier5SubmissionScan(contestId, validHandles, contestInfo);
  if (result.success) {
    console.log('✅ Tier 3 succeeded');
    result.results.sort(compareContestEntries);
    setCache(cacheKey, result, result.phase);
    return result;
  }

  console.log('❌ All tiers failed');
  return {
    success: false,
    error: 'All tiers failed',
    results: validHandles.map(h => ({ handle: h, rank: null, solved: 0, penalty: 0, totalProblems: 0 })),
    totalProblems: 0,
    phase: 'UNKNOWN',
    contest: null,
    source: 'none'
  };
}

// ─── COMPARISON FUNCTION ──────────────────────────────────────────────────────
function compareContestEntries(a, b) {
  if (a.solved !== b.solved) return b.solved - a.solved;
  if (a.rank != null && b.rank != null) return a.rank - b.rank;
  if (a.rank != null && b.rank == null) return -1;
  if (a.rank == null && b.rank != null) return 1;
  if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  return a.handle.localeCompare(b.handle);
}

// ─── FORMAT FUNCTION ──────────────────────────────────────────────────────────
function formatContestStandings(results, totalProblems, isLive, contestInfo) {
  // Fallback if totalProblems is 0
  if (totalProblems === 0) {
    console.log('⚠️ totalProblems is 0, trying to get from contestInfo');
    if (contestInfo && contestInfo.problems) {
      totalProblems = contestInfo.problems;
    }
  }
  
  let text = '';
  if (isLive) {
    text += `🟢 *LIVE* ${contestInfo?.name || `Contest #${contestInfo?.id}`}\n`;
  } else {
    text += `🏁 *${contestInfo?.name || `Contest #${contestInfo?.id}`}*\n`;
  }
  
  if (contestInfo?.startTimeSeconds) {
    text += `📅 ${formatIST(contestInfo.startTimeSeconds)}\n`;
  }
  if (contestInfo?.durationSeconds) {
    text += `⏱ Duration: ${formatDuration(contestInfo.durationSeconds)}\n`;
  }
  text += `📝 Problems: ${totalProblems || 0}\n`;
  
  if (totalProblems > 0) {
    const labels = getProblemLabels(totalProblems);
    text += `📋 ${labels}\n`;
  }
  text += `${"─".repeat(28)}\n\n`;

  const active = results.filter(r => r.solved > 0).sort(compareContestEntries);

  // Removed the "zero solves" section entirely – members with 0 solves are not listed.

  if (active.length === 0) {
    text += `😴 No group members have participated yet.\n\n`;
  } else {
    const medals = ['🥇', '🥈', '🥉'];
    active.forEach((r, i) => {
      const medal = i < 3 ? medals[i] : '';
      const rankDisplay = isLive ? 'Unrated' : (r.rank != null ? `#${r.rank}` : 'N/A');
      text += `${medal} ${ordinal(i + 1)} *${r.handle}* (${r.solved}/${totalProblems} Q) | Rank ${rankDisplay}\n`;
    });
    text += '\n';
  }

  return text.trim();
}

// ─── Winner Announcement ──────────────────────────────────────────────────────
async function checkAndAnnounceWinner(sock) {
  const groups = await CFData.find({}).lean();
  for (const group of groups) {
    const chatId = group.chatId;
    if (!chatId.endsWith("@g.us")) continue;
    const groupData = await getGroupData(chatId);
    const handles = getAllHandles(groupData);
    if (!handles.length) continue;

    try {
      const lastContest = await getRecentFinishedContest();
      if (!lastContest) continue;
      const lastId = lastContest.id;

      if (groupData.lastContestAnnounced !== lastId) {
        const finishedAt = lastContest.startTimeSeconds + lastContest.durationSeconds;
        const now = Math.floor(Date.now() / 1000);
        if (now - finishedAt <= 7200) {
          const standingsResult = await getContestStandings(lastId, handles);
          if (standingsResult.success) {
            const results = standingsResult.results || [];
            const entries = results.filter(r => r.solved > 0).sort(compareContestEntries);
            if (entries.length) {
              const [winner] = entries;
              let text = `🏁 *Contest Over!*\n📋 *${lastContest.name}*\n${"─".repeat(28)}\n\n`;
              text += `🏆 *Group Winner: ${winner.handle}* with *${winner.solved}* solved${winner.rank ? ` (Rank #${winner.rank})` : ''}!\n\n📊 *Group Performance:*\n`;
              entries.forEach((r, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
                const rankStr = r.rank ? ` | Rank #${r.rank}` : ' | N/A';
                text += `${medal} *${r.handle}* — ✅ ${r.solved} solved${rankStr}\n`;
              });
              await sock.sendMessage(chatId, { text });
            }
          }
        }
        await saveGroupData(chatId, { ...groupData, lastContestAnnounced: lastId });
      }

      if (groupData.lastRatingAnnounced === lastId) continue;

      const endTime = lastContest.startTimeSeconds + lastContest.durationSeconds;
      const now = Math.floor(Date.now() / 1000);
      if (now - endTime < 1800) {
        console.log(`⏳ Waiting for rating changes for contest ${lastId}`);
        continue;
      }

      const { ready, promoted } = await getContestPromotions(lastId, handles);

      if (!ready) {
        // Big Div2/3/4 rounds can take well over 30 min for CF to finish
        // computing ratings, so keep retrying for up to 3 hours. After that,
        // assume it's a genuinely unrated contest and stop checking it
        // (otherwise this would retry every 5 min forever).
        if (now - endTime < 3 * 3600) {
          console.log(`⏳ Ratings not published yet for contest ${lastId}, will retry`);
          continue;
        }
        console.log(`ℹ️ No rating changes 3h+ after contest ${lastId} — assuming unrated, won't retry further`);
        await saveGroupData(chatId, { ...groupData, lastRatingAnnounced: lastId });
        continue;
      }

      if (promoted.length) {
        let msg = `🎉 *Promotion Alerts!* 🎉\n\n`;
        for (const p of promoted) {
          msg += `@${p.handle} — Congratulations! Promoted from *${p.oldRank}* to *${p.newRank}*! 🚀\n`;
          msg += `📊 Rating: ${p.oldRating} → ${p.newRating} (${p.delta >= 0 ? '+' : ''}${p.delta})\n`;
          msg += `🏅 New Rank: ${p.newRank}\n\n`;
        }
        msg += `🔥 Keep up the great work! 💪`;
        try {
          await sock.sendMessage(chatId, { text: msg });
        } catch (e) {
          console.error(`Failed to send promotion message to ${chatId}:`, e.message);
        }
      } else {
        const msg = `📊 Rating changes processed for ${lastContest.name}.\n😴 No rank promotions this time. Keep practicing! 💪`;
        try {
          await sock.sendMessage(chatId, { text: msg });
        } catch (e) {}
      }

      await saveGroupData(chatId, { ...groupData, lastRatingAnnounced: lastId });

    } catch (e) {
      console.error(`Winner/Promotion check error for ${chatId}:`, e.message);
    }
  }
}

async function getRecentFinishedContest() {
  try {
    const list = await getCFContestList();
    const finished = list.filter((c) => c.phase === "FINISHED");
    return finished.length ? finished[0] : null;
  } catch { return null; }
}

// ─── Promotions (rank-up) Helper ──────────────────────────────────────────────
// Shared by the automatic post-contest announcer AND the `// solved` command,
// so both report rank-ups the same way instead of duplicating the logic.
// Returns:
//   { ready: true,  promoted: [...] }   if CF has published rating changes
//   { ready: false, promoted: [] }      if CF hasn't processed ratings yet
async function getContestPromotions(contestId, handles) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/contest.ratingChanges?contestId=${contestId}`,
      { timeout: 15000 }
    );
    const changes = (res.data?.status === "OK" && res.data.result) ? res.data.result : [];
    if (!changes.length) return { ready: false, promoted: [] };

    const changeMap = {};
    for (const entry of changes) changeMap[entry.handle.toLowerCase()] = entry;

    const promoted = [];
    for (const handle of handles) {
      const entry = changeMap[handle.toLowerCase()];
      if (!entry) continue;
      const oldRank = entry.oldRating === 0 ? "Unrated" : getRankFromRating(entry.oldRating);
      const newRank = getRankFromRating(entry.newRating);
      if (getRankIndex(newRank) > getRankIndex(oldRank)) {
        promoted.push({
          handle,
          oldRank,
          newRank,
          oldRating: entry.oldRating,
          newRating: entry.newRating,
          delta: entry.newRating - entry.oldRating,
        });
      }
    }
    return { ready: true, promoted };
  } catch (e) {
    // Codeforces returns an error (not just empty data) for a contest whose
    // ratings haven't been processed yet — treat that the same as "not ready".
    console.log(`Rating changes not available yet for contest ${contestId}: ${e.message}`);
    return { ready: false, promoted: [] };
  }
}

// ─── Delta7 ──────────────────────────────────────────────────────────────────
async function getDelta7(handles) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = Date.now() + IST_OFFSET_MS;
  const weekAgoIST = nowIST - 7 * 24 * 60 * 60 * 1000;

  const results = [];

  for (let i = 0; i < handles.length; i += 2) {
    const batch = handles.slice(i, i + 2);
    const batchResults = await Promise.all(batch.map(async (handle) => {
      try {
        const res = await axios.get(
          `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=100`,
          { timeout: 10000 }
        );
        const subs = res.data.result || [];

        const solvedMap = {};
        let totalPoints = 0;

        for (const s of subs) {
          if (s.verdict === "OK" && s.problem) {
            const subTimeIST = s.creationTimeSeconds * 1000 + IST_OFFSET_MS;
            if (subTimeIST >= weekAgoIST) {
              const key = `${s.problem.contestId}-${s.problem.index}`;
              if (!solvedMap[key]) {
                const rating = s.problem.rating || 0;
                solvedMap[key] = rating;
                totalPoints += calculatePointsForRating(rating);
              }
            }
          }
        }
        const problemCount = Object.keys(solvedMap).length;
        return { handle, points: totalPoints, count: problemCount };
      } catch (e) {
        console.error(`Error fetching for ${handle}:`, e.message);
        return { handle, points: 0, count: 0 };
      }
    }));
    results.push(...batchResults);
    if (i + 2 < handles.length) await sleep(1500);
  }

  return results.sort((a, b) => b.points - a.points || b.count - a.count);
}

// ─── Background Solve-History Sync ─────────────────────────────────────────────
// Keeps SolveHistory (one doc per handle) up to date so `// delta7` can read
// straight from MongoDB with zero CF API calls in the command path.
//
// Always walks handles in batches of 2 with a 1.5s gap between batches —
// same pacing as the old live getDelta7 — whether this is the full periodic
// sweep, the one-off startup sweep, or a single-handle sync triggered by
// `// add`. Nothing here is incremental: every call re-fetches each handle's
// latest 100 submissions from CF and re-derives the 7-day window from their
// real `creationTimeSeconds`, so it's never "only what happened since the
// bot started watching" — it's always their true last 7 days.
async function syncSolveHistory(specificHandles) {
  const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;

  let handles;
  if (specificHandles && specificHandles.length) {
    handles = specificHandles;
  } else {
    const groups = await CFData.find({}).lean();
    handles = [];
    for (const g of groups)
      for (const list of Object.values(g.members || {}))
        for (const h of list)
          if (!handles.includes(h)) handles.push(h);
  }

  if (!handles.length) return;
  console.log(`🔄 syncSolveHistory: syncing ${handles.length} handle(s)...`);

  for (let i = 0; i < handles.length; i += 2) {
    const batch = handles.slice(i, i + 2);
    await Promise.all(batch.map(async (handle) => {
      try {
        const res = await axios.get(
          `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=100`,
          { timeout: 10000 }
        );
        const subs = res.data.result || [];

        let doc = await SolveHistory.findOne({ handle });
        if (!doc) doc = new SolveHistory({ handle, solves: [] });

        const existingKeys = new Set(doc.solves.map((s) => s.key));
        for (const s of subs) {
          if (s.verdict !== "OK" || !s.problem) continue;
          const key = `${s.problem.contestId}-${s.problem.index}`;
          if (existingKeys.has(key)) continue; // already recorded, even if CF shows repeat attempts
          existingKeys.add(key);
          const rating = s.problem.rating || 0;
          doc.solves.push({
            key,
            rating,
            points: calculatePointsForRating(rating),
            solvedAt: s.creationTimeSeconds,
          });
        }

        // Auto-expiry: this is the only place old entries get dropped —
        // happens as a side effect of every sync write, no separate cleanup job.
        const nowSec = Math.floor(Date.now() / 1000);
        doc.solves = doc.solves.filter((s) => nowSec - s.solvedAt <= SEVEN_DAYS_SEC);

        doc.lastSynced = new Date();
        await doc.save();
      } catch (e) {
        // One bad handle (network hiccup, invalid handle) must not wipe its
        // existing stored data or abort the rest of the batch.
        console.error(`⚠️ syncSolveHistory failed for ${handle}:`, e.message);
      }
    }));
    if (i + 2 < handles.length) await sleep(1500);
  }

  console.log(`✅ syncSolveHistory: done (${handles.length} handle(s))`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rankEmoji(rank) {
  if (!rank) return "⚫";
  const r = rank.toLowerCase();
  if (r.includes("legendary"))                                   return "👑";
  if (r.includes("international") && r.includes("grandmaster")) return "🔴";
  if (r.includes("grandmaster"))                                 return "🔴";
  if (r.includes("international") && r.includes("master"))      return "🟠";
  if (r.includes("candidate"))                                   return "🟣";
  if (r.includes("master"))                                      return "🟠";
  if (r.includes("expert"))                                      return "🔵";
  if (r.includes("specialist"))                                  return "🩵";
  if (r.includes("pupil"))                                       return "🟢";
  return "⚫";
}

function streakFire(days) {
  if (days >= 30) return "🔥🔥🔥🔥";
  if (days >= 15) return "🔥🔥🔥";
  if (days >= 8)  return "🔥🔥";
  if (days >= 1)  return "🔥";
  return "💤";
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("✅ CF WhatsApp Bot is running!"));
app.get("/ping", (req, res) => res.send("🏓 Pong!"));
app.get("/qr", async (req, res) => {
  if (!latestQR)
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff"><h2>✅ Bot is connected!</h2></body></html>`);
  try {
    const qrImg = await QRCode.toDataURL(latestQR);
    res.send(`<html><head><meta http-equiv="refresh" content="20"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:40px">
    <h2 style="color:#0f0">📱 Scan with WhatsApp</h2>
    <img src="${qrImg}" style="width:280px;height:280px;border:8px solid #fff;border-radius:12px"/>
    <p style="color:#aaa">WhatsApp → Linked Devices → Link a Device</p>
    <p style="color:#555;font-size:12px">Auto-refreshes every 20s</p></body></html>`);
  } catch (e) { res.status(500).send("QR Error: " + e.message); }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Express server on port ${PORT}`));

// ─── Bot ──────────────────────────────────────────────────────────────────────
// `activeSock` always points at the CURRENT live connection. Cron jobs read
// from this instead of closing over a specific `sock` instance, so a
// reconnect can never leave a duplicate, dead-socket interval running.
let activeSock = null;
let cronJobsStarted = false;

function startCronJobs() {
  if (cronJobsStarted) return; // guarantees these intervals are created exactly once for the process lifetime
  cronJobsStarted = true;
  console.log("✅ Cron jobs started (single instance — survives reconnects)");
  setInterval(() => { if (activeSock) checkAndSendReminders(activeSock); }, 10 * 60 * 1000);
  setInterval(() => { if (activeSock) checkAndAnnounceWinner(activeSock); }, 5 * 60 * 1000);
  setInterval(() => { syncSolveHistory(); }, 12 * 60 * 1000); // full sweep, batch-of-2 pacing, no sock needed
}

async function startBot() {
  const { state, saveCreds } = await useMongoAuthState();
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: "silent" }) });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      qrcode.generate(qr, { small: true });
      console.log("📱 QR ready! Visit /qr on your Render URL.");
    }
    if (connection === "close") {
      if (activeSock === sock) activeSock = null; // this socket is dead, stop routing cron jobs to it
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startBot, 3000);
      else console.log("Logged out. Clear AuthState from MongoDB.");
    }
    if (connection === "open") {
      latestQR = null;
      activeSock = sock;
      console.log("✅ CF Bot is ready!");

      console.log("🚀 Running immediate reminder check...");
      checkAndSendReminders(sock);

      console.log("🚀 Running immediate solve-history sync (batch-of-2 pacing)...");
      syncSolveHistory();

      setTimeout(() => {
        if (activeSock !== sock) return; // a newer connection has since taken over
        console.log("🔄 Running startup reminder check (delayed)...");
        checkAndSendReminders(sock);
      }, 30000);

      startCronJobs();
      setTimeout(() => { if (activeSock) checkAndAnnounceWinner(activeSock); }, 2 * 60 * 1000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const chatId = msg.key.remoteJid;
      if (!chatId?.endsWith("@g.us")) continue;
      const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
      if (!body.startsWith("//")) continue;
      const senderId = msg.key.participant || msg.key.remoteJid;
      const command = body.toLowerCase();
      const reply = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
      const groupData = await getGroupData(chatId);
      if (!groupData.members) groupData.members = {};

      try {

        // ── // add ───────────────────────────────────────────────────────────
        if (command.startsWith("// add ")) {
          const args = body.slice(7).trim().split(/\s+/).filter(Boolean);
          if (!args.length) { await reply("❌ Usage: `// add <cf_handle>`\nOr multiple: `// add h1 h2 h3`"); continue; }
          await reply(`🔍 Verifying ${args.length} handle(s)...`);
          if (!groupData.members[senderId]) groupData.members[senderId] = [];
          const results = [];
          const newlyAdded = [];
          let added = 0, failed = 0;
          for (const h of args) {
            await sleep(300);
            const userInfo = await getCFUser(h);
            if (!userInfo) { results.push(`❌ *${h}* — not found`); failed++; continue; }
            if (groupData.members[senderId].includes(userInfo.handle)) {
              results.push(`ℹ️ *${userInfo.handle}* — already added`); continue;
            }
            groupData.members[senderId].push(userInfo.handle);
            results.push(`✅ ${rankEmoji(userInfo.rank)} *${userInfo.handle}* — ${userInfo.rating ?? "Unrated"} (${userInfo.rank})`);
            newlyAdded.push(userInfo.handle);
            added++;
          }
          await saveGroupData(chatId, groupData);
          // Fire-and-forget: don't make the registration reply wait on CF's
          // submissions endpoint. Same batch-of-2 pacing as every other sync,
          // it just runs against a 1-3 handle list here instead of the whole group.
          if (newlyAdded.length) syncSolveHistory(newlyAdded);
          let text = `*Registration Results:*\n\n` + results.join("\n");
          if (args.length > 1) text += `\n\n👥 ${added} added${failed ? `, ${failed} failed` : ""}`;
          if (newlyAdded.length) text += `\n\n⏳ _Fetching last 7 days of solves for ${newlyAdded.length > 1 ? "these handles" : "this handle"} — ready for \`// delta7\` shortly._`;
          await reply(text);
        }

        // ── // remove ──────────────────────────────────────────────────────
        else if (command.startsWith("// remove")) {
          const myHandles = groupData.members[senderId] || [];
          if (!myHandles.length) { await reply("❌ You haven't registered any CF handles."); continue; }
          const arg = body.slice(9).trim();
          if (!arg) {
            delete groupData.members[senderId];
            await saveGroupData(chatId, groupData);
            await reply(`✅ Removed all your handles: *${myHandles.join(", ")}*`);
          } else {
            const idx = myHandles.findIndex((h) => h.toLowerCase() === arg.toLowerCase());
            if (idx === -1) { await reply(`❌ *${arg}* not found.\nYour handles: ${myHandles.join(", ")}`); continue; }
            myHandles.splice(idx, 1);
            if (!myHandles.length) delete groupData.members[senderId];
            else groupData.members[senderId] = myHandles;
            await saveGroupData(chatId, groupData);
            await reply(`✅ Removed *${arg}* from your handles.`);
          }
        }

        // ── // rating ──────────────────────────────────────────────────────
        else if (command === "// rating") {
          const handles = getAllHandles(groupData);
          if (!handles.length) { await reply("📭 No one registered yet!\nUse `// add your_cf_id` to join."); continue; }
          await reply(`⏳ Fetching ratings for ${handles.length} member(s)...`);
          const users = await getCFUsers(handles);
          if (!users.length) { await reply("❌ Failed to fetch. Try again."); continue; }
          users.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
          let text = `🏆 *CF Leaderboard*\n${"─".repeat(28)}\n`;
          users.forEach((u, i) => {
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
            text += `${medal} ${rankEmoji(u.rank)} *${u.handle}* — ${u.rating ?? "Unrated"}\n`;
          });
          text += `${"─".repeat(28)}\n👥 Total: ${users.length} members`;
          await reply(text);
        }

        // ── // myrating ──────────────────────────────────────────────────
        else if (command === "// myrating") {
          const myHandles = groupData.members[senderId] || [];
          if (!myHandles.length) { await reply("❌ Not registered!\nUse `// add your_cf_id` first."); continue; }
          const users = await getCFUsers(myHandles);
          if (!users.length) { await reply("❌ Failed to fetch. Try again."); continue; }
          let text = `👤 *Your CF Profiles:*\n\n`;
          for (const u of users)
            text += `${rankEmoji(u.rank)} *${u.handle}*\n   📊 Rating: *${u.rating ?? "Unrated"}*\n   🏅 Rank: ${u.rank}\n   🚀 Max: ${u.maxRating ?? "N/A"} (${u.maxRank})\n\n`;
          await reply(text.trim());
        }

        // ── // upcoming ──────────────────────────────────────────────────
        else if (command === "// upcoming") {
          await reply("⏳ Fetching upcoming contests from all platforms...");
          const [cf, lc, cc, at] = await Promise.all([
            getCFUpcoming(),
            getLeetCodeUpcoming(),
            getCodeChefUpcoming(),
            getAtCoderUpcoming(),
          ]);

          const grouped = {};
          const all = [...cf, ...lc, ...cc, ...at];
          for (const c of all) {
            if (!grouped[c.platform]) grouped[c.platform] = [];
            grouped[c.platform].push(c);
          }
          for (const platform of Object.keys(grouped)) {
            grouped[platform].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
          }

          const platformOrder = ["Codeforces", "LeetCode", "CodeChef", "AtCoder"];
          let text = `📅 *Upcoming Contests*\n${"─".repeat(28)}\n\n`;
          let anyContest = false;
          for (const platform of platformOrder) {
            const contests = grouped[platform] || [];
            if (contests.length === 0) continue;
            anyContest = true;
            const emoji = platform === "Codeforces" ? "🔵" :
                          platform === "CodeChef" ? "🟤" :
                          platform === "LeetCode" ? "🟡" :
                          platform === "AtCoder" ? "🟣" : "⚪";
            text += `${emoji} *${platform}*\n`;
            contests.slice(0, 8).forEach((c) => {
              text += `  • *${c.name}*\n    🕐 ${formatIST(c.startTimeSeconds)}\n    ⏱ ${formatDuration(c.durationSeconds)}\n    🔗 ${c.url}\n\n`;
            });
          }
          if (!anyContest) text += `😴 No upcoming contests right now.`;
          await reply(text.trim());
        }

        // ── // solved ──────────────────────────────────────────────────
        else if (command === "// solved") {
          const handles = getAllHandles(groupData);
          if (!handles.length) {
            await reply("📭 No members registered.\nUse `// add your_cf_id` to join.");
            continue;
          }

          let contest = null;
          let isLive = false;
          try {
            const list = await getCFContestList();
            const sorted = list.sort((a, b) => b.startTimeSeconds - a.startTimeSeconds);
            const running = sorted.find(c => c.phase === "CODING");
            if (running) {
              contest = running;
              isLive = true;
            } else {
              const finished = sorted.find(c => c.phase === "FINISHED");
              if (finished) contest = finished;
            }
          } catch (e) {
            console.error("Error fetching contest list:", e.message);
          }

          if (!contest) {
            await reply(`⚠️ Could not detect the latest contest automatically.\nPlease use \`// contest <id>\` manually.`);
            continue;
          }

          await reply(`⏳ Fetching standings for *${contest.name}*...`);

          const result = await getContestStandings(contest.id, handles);
          if (!result.success) {
            await reply(`❌ Failed to fetch standings: ${result.error}`);
            continue;
          }

          const isLiveContest = result.phase === 'CODING';
          const output = formatContestStandings(result.results, result.totalProblems, isLiveContest, contest);

          let promoText = "";
          if (!isLiveContest) {
            // Contest is over — check if any of our members ranked up
            // (e.g. Pupil → Specialist) because of this contest.
            const { ready, promoted } = await getContestPromotions(contest.id, handles);
            if (ready && promoted.length) {
              promoText += `\n\n🎉 *Rank-Ups!*\n${"─".repeat(28)}\n`;
              for (const p of promoted) {
                promoText += `${rankEmoji(p.newRank)} *${p.handle}*: ${p.oldRank} → *${p.newRank}* (${p.oldRating}→${p.newRating}, ${p.delta >= 0 ? '+' : ''}${p.delta}) 🚀\n`;
              }
            } else if (!ready) {
              promoText += `\n\n⏳ _Ratings not finalized by Codeforces yet — rank-ups, if any, will show once they're published._`;
            }
          }

          // Append contest link
          await reply(output + promoText + `\n\n🔗 https://codeforces.com/contest/${contest.id}`);
        }

        // ── // suggest ─────────────────────────────────────────────────────
        else if (command.startsWith("// suggest")) {
          const arg = body.slice(10).trim();
          const rating = parseInt(arg, 10);

          if (!arg || isNaN(rating) || rating < 800 || rating > 3500 || rating % 100 !== 0) {
            await reply(
              "❌ Usage: `// suggest <rating>`\n" +
              "Rating must be a multiple of 100, between 800 and 3500.\n" +
              "Example: `// suggest 1800`"
            );
            continue;
          }

          await reply(`🔎 Finding a ${rating}-rated problem...`);

          const problem = await getRandomProblemByRating(rating);
          if (!problem) {
            await reply(`❌ Couldn't find any problem near rating ${rating}. Try a different value.`);
            continue;
          }

          const link = `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`;
          const tags = problem.tags?.length ? `\n🏷️ ${problem.tags.slice(0, 5).join(", ")}` : "";
          const note = problem.rating !== rating ? `\n_(closest match — exact ${rating} not found right now)_` : "";

          await reply(
            `🎯 *${problem.name}*\n` +
            `⭐ Rating: ${problem.rating}${tags}\n` +
            `🔗 ${link}${note}`
          );
        }

        // ── // contest ──────────────────────────────────────────────────
        else if (command.startsWith("// contest ")) {
          const input = body.slice(10).trim();
          if (!input) {
            await reply("❌ Usage: `// contest <contest_id>` or `// contest <contest_url>`\nExample: `// contest 1790` or `// contest https://codeforces.com/contest/1790`");
            continue;
          }
          let contestId = null;
          const urlMatch = input.match(/codeforces\.com\/contest\/(\d+)/i);
          if (urlMatch) {
            contestId = urlMatch[1];
          } else if (/^\d+$/.test(input)) {
            contestId = input;
          } else {
            await reply("❌ Invalid format. Provide a contest ID (e.g., `1790`) or a Codeforces contest URL.");
            continue;
          }

          const handles = getAllHandles(groupData);
          if (!handles.length) {
            await reply("📭 No members registered.\nUse `// add your_cf_id` to join.");
            continue;
          }

          let contestInfo = null;
          try {
            const list = await getCFContestList();
            const found = list.find(c => c.id == contestId);
            if (found) contestInfo = found;
          } catch (e) {
            console.error("Error fetching contest list:", e.message);
          }

          if (!contestInfo) {
            contestInfo = await getContestInfo(contestId);
            if (!contestInfo || !contestInfo.startTimeSeconds) {
              await reply(`❌ Could not fetch contest ${contestId}. Codeforces API may be down or contest does not exist.\nPlease try again later.`);
              continue;
            }
          }

          await reply(`⏳ Fetching standings for *${contestInfo.name}*...`);

          const result = await getContestStandings(contestId, handles);
          if (!result.success) {
            await reply(`❌ Failed to fetch standings: ${result.error}`);
            continue;
          }

          const isLiveContest = result.phase === 'CODING';
          const output = formatContestStandings(result.results, result.totalProblems, isLiveContest, contestInfo);
          await reply(`${output}\n\n🔗 https://codeforces.com/contest/${contestId}`);
        }

        // ── // today ─────────────────────────────────────────────────────
        else if (command.startsWith("// today ")) {
          const url = body.slice(9).trim();
          if (!url) {
            await reply("❌ Usage: `// today <problem_url>`\nExample: `// today https://codeforces.com/contest/1790/problem/D`");
            continue;
          }
          const match = url.match(/codeforces\.com\/(?:contest|problemset\/problem)\/(\d+)\/problem?\/([A-Z0-9]+)/i);
          if (!match) {
            await reply("❌ Invalid Codeforces problem URL.\nExamples:\n`https://codeforces.com/contest/1790/problem/D`\n`https://codeforces.com/problemset/problem/1790/D`");
            continue;
          }
          const contestId = match[1];
          const problemIndex = match[2].toUpperCase();
          const handles = getAllHandles(groupData);
          if (!handles.length) {
            await reply("📭 No members registered.\nUse `// add your_cf_id` to join.");
            continue;
          }
          await reply(`🔍 Checking who solved *${contestId}${problemIndex}* today...\n_Checking ${handles.length} member(s) — few seconds_`);
          const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
          const todayIST = new Date(Date.now() + IST_OFFSET_MS);
          todayIST.setHours(0, 0, 0, 0);
          const todayStartIST = todayIST.getTime();
          const solvedToday = [];
          for (let i = 0; i < handles.length; i += 2) {
            const batch = handles.slice(i, i + 2);
            const batchResults = await Promise.all(batch.map(async (handle) => {
              try {
                const res = await axios.get(
                  `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=100`,
                  { timeout: 10000 }
                );
                const subs = res.data.result || [];
                let solved = false;
                for (const s of subs) {
                  if (s.verdict === "OK" && s.problem) {
                    const subTimeIST = s.creationTimeSeconds * 1000 + IST_OFFSET_MS;
                    if (subTimeIST >= todayStartIST) {
                      if (s.problem.contestId == contestId && s.problem.index.toUpperCase() === problemIndex) {
                        solved = true;
                        break;
                      }
                    }
                  }
                }
                return { handle, solved };
              } catch {
                return { handle, solved: false };
              }
            }));
            for (const result of batchResults) {
              if (result.solved) {
                solvedToday.push(result.handle);
              }
            }
            if (i + 2 < handles.length) await sleep(1500);
          }
          let text = `📊 *Problem: ${contestId}${problemIndex}*\n`;
          text += `📅 Today's Solves (IST)\n`;
          text += `${"─".repeat(28)}\n\n`;
          if (solvedToday.length === 0) {
            text += `😴 No one solved this problem today.`;
          } else {
            text += `✅ *Solved today:*\n`;
            solvedToday.forEach((h, i) => {
              text += `  ${i + 1}. *${h}*\n`;
            });
          }
          text += `\n🔗 ${url}`;
          await reply(text.trim());
        }

        // ── // streak ──────────────────────────────────────────────────
        else if (command.startsWith("// streak")) {
          const arg = body.slice(9).trim();
          if (!arg) { await reply("❌ Usage: `// streak <cf_handle>`\nExample: `// streak tourist`"); continue; }
          await reply(`⏳ Fetching streak for *${arg}*... _few seconds_`);
          const streak = await getCFStreak(arg);
          if (!streak) { await reply(`❌ Could not fetch *${arg}*. Check handle and try again.`); continue; }
          const curFire = streakFire(streak.current);
          const maxFire = streakFire(streak.max);
          let text = `🔥 *Streak — ${arg}*\n${"─".repeat(28)}\n\n`;
          text += `${curFire} Current Streak: *${streak.current} days*\n`;
          text += `🏆 Max Streak Ever: *${streak.max} days* ${maxFire}\n`;
          if (streak.current === 0) text += `\n💤 No active streak.\n💪 Solve a problem today to start one!`;
          else if (streak.current >= 30) text += `\n🚀 Incredible! Keep it going!`;
          else if (streak.current >= 15) text += `\n💪 Great streak! Don't break it!`;
          else if (streak.current >= 7) text += `\n⭐ One week+ streak!`;
          else text += `\n📈 Good start! Keep solving daily!`;
          await reply(text);
        }

        // ── // info ──────────────────────────────────────────────────
        else if (command.startsWith("// info")) {
          const arg = body.slice(7).trim();
          if (!arg) { await reply("❌ Usage: `// info <cf_handle>`\nExample: `// info tourist`"); continue; }
          await reply(`⏳ Fetching info for *${arg}*...\n_few seconds_`);
          const [info, qData] = await Promise.all([
            getCFUserInfo(arg),
            getCFUserInfoQ(arg),
          ]);
          if (!info) { await reply(`❌ Could not fetch *${arg}*. Check handle and try again.`); continue; }
          let text = `👤 *${info.handle}*\n${"─".repeat(28)}\n\n`;
          text += `${rankEmoji(info.rank)} Rank: *${info.rank}*\n`;
          text += `📊 Rating: *${info.rating ?? "Unrated"}*\n`;
          text += `🚀 Max Rating: *${info.maxRating ?? "N/A"}* (${info.maxRank})\n`;
          text += `🏁 Contests: *${info.contests}*\n\n`;
          text += `✅ Total Solved: *${info.totalSolved || "N/A"}*\n\n`;
          if (qData) {
            const b = qData.buckets;
            const maxCount = Math.max(...Object.values(b), 1);
            const bar = (n) => "█".repeat(Math.round((n / maxCount) * 12)) + "░".repeat(12 - Math.round((n / maxCount) * 12));
            text += `📈 *By Rating:*\n`;
            for (const range of RATING_RANGES) {
              const label = rangeLabel(range);
              const count = b[label] || 0;
              const padded = label.padEnd(9, " ");
              text += `  ${padded}: ${bar(count)} *${count}*\n`;
            }
          }
          await reply(text.trim());
        }

        // ── // compare ──────────────────────────────────────────────────
        else if (command.startsWith("// compare")) {
          const args = body.slice(10).trim().split(/\s+/).filter(Boolean);
          if (args.length !== 2) { await reply("❌ Usage: `// compare <cf_id1> <cf_id2>`\nExample: `// compare tourist jiangly`"); continue; }
          const [h1, h2] = args;
          await reply(`⏳ Comparing *${h1}* vs *${h2}*...\n_few seconds_`);
          const info1 = await getCFUserForCompare(h1);
          if (!info1) { await reply(`❌ Could not fetch *${h1}*. Check the handle and try again.`); continue; }
          await sleep(500);
          const info2 = await getCFUserForCompare(h2);
          if (!info2) { await reply(`❌ Could not fetch *${h2}*. Check the handle and try again.`); continue; }
          await sleep(500);
          const streak1 = await getCFStreak(h1);
          await sleep(500);
          const streak2 = await getCFStreak(h2);
          const r1 = info1.rating ?? -1;
          const r2 = info2.rating ?? -1;
          const s1 = info1.totalSolved || 0;
          const s2 = info2.totalSolved || 0;
          const c1 = info1.contests || 0;
          const c2 = info2.contests || 0;
          const m1 = streak1?.max ?? 0;
          const m2 = streak2?.max ?? 0;
          let text = `⚔️ *${info1.handle}* vs *${info2.handle}*\n${"─".repeat(28)}\n\n`;
          text += `📊 *Rating*\n`;
          text += `  ${rankEmoji(info1.rank)} ${info1.handle}: *${info1.rating ?? "Unrated"}* (${info1.rank})\n`;
          text += `  ${rankEmoji(info2.rank)} ${info2.handle}: *${info2.rating ?? "Unrated"}* (${info2.rank})\n`;
          text += `  ${r1 === r2 ? "🤝 Tie" : r1 > r2 ? `🏆 ${info1.handle}` : `🏆 ${info2.handle}`}\n\n`;
          text += `✅ *Total Solved*\n`;
          text += `  ${info1.handle}: *${s1}*\n`;
          text += `  ${info2.handle}: *${s2}*\n`;
          text += `  ${s1 === s2 ? "🤝 Tie" : s1 > s2 ? `🏆 ${info1.handle}` : `🏆 ${info2.handle}`}\n\n`;
          text += `🏁 *Contests Participated*\n`;
          text += `  ${info1.handle}: *${c1}*\n`;
          text += `  ${info2.handle}: *${c2}*\n`;
          text += `  ${c1 === c2 ? "🤝 Tie" : c1 > c2 ? `🏆 ${info1.handle}` : `🏆 ${info2.handle}`}\n\n`;
          text += `🔥 *Max Streak*\n`;
          text += `  ${info1.handle}: *${m1} days*\n`;
          text += `  ${info2.handle}: *${m2} days*\n`;
          text += `  ${m1 === m2 ? "🤝 Tie" : m1 > m2 ? `🏆 ${info1.handle}` : `🏆 ${info2.handle}`}`;
          await reply(text.trim());
        }

        // ── // delta7 ──────────────────────────────────────────────────
        else if (command === "// delta7") {
          const handles = getAllHandles(groupData);
          if (!handles.length) { await reply("📭 No members registered.\nUse `// add your_cf_id` to join."); continue; }

          // Zero axios calls, zero sleep() here — all CF fetching happens in
          // the background sync. This is a single in-memory MongoDB read.
          const docs = await SolveHistory.find({ handle: { $in: handles } }).lean();
          const docByHandle = new Map(docs.map((d) => [d.handle, d]));

          const nowSec = Math.floor(Date.now() / 1000);
          const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
          const unsynced = [];
          const results = handles.map((handle) => {
            const doc = docByHandle.get(handle);
            if (!doc) { unsynced.push(handle); return { handle, points: 0, count: 0 }; }
            // Re-filter at read time as a cheap safety net in case the last
            // sync is a few minutes stale — pure in-memory filter, no network.
            const fresh = doc.solves.filter((s) => nowSec - s.solvedAt <= SEVEN_DAYS_SEC);
            const points = fresh.reduce((sum, s) => sum + s.points, 0);
            return { handle, points, count: fresh.length };
          }).sort((a, b) => b.points - a.points || b.count - a.count);

          const active = results.filter((r) => r.points > 0);

          let text = `📈 *Delta7 (Last 7 Days)*\n${"─".repeat(28)}\n📅 Rolling 7-day points\n\n`;

          if (!active.length) {
            text += `😴 No one solved any problems this week!\nStart grinding! 💪`;
          } else {
            active.forEach((r, i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
              text += `${medal} *${r.handle}* — ${r.points} pts, ${r.count} Q\n`;
            });
          }

          if (unsynced.length) {
            text += `\n⏳ _New member${unsynced.length > 1 ? "s" : ""} (${unsynced.join(", ")}) will appear after the next sync._`;
          }

          await reply(text.trim());
        }

        // ── // help ──────────────────────────────────────────────────────
        else if (command === "// help") {
          await reply(
            `⚡ *CF GROUP BOT* ⚡\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
            `🏷 *[ 01 ]  HANDLE MANAGEMENT*\n` +
            `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n` +
            `➕ \`// add <cf_id>\`\n   _Register your CF handle_\n\n` +
            `➕ \`// add h1 h2 h3\`\n   _Add multiple handles at once_\n\n` +
            `➖ \`// remove\`\n   _Delete all your handles_\n\n` +
            `➖ \`// remove <cf_id>\`\n   _Delete a specific handle_\n\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
            `🏷 *[ 02 ]  LEADERBOARDS & STATS*\n` +
            `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n` +
            `📊 \`// rating\`\n   _Group ranking by CF rating_\n\n` +
            `📈 \`// delta7\`\n   _Rolling 7-day points (Δ7)_\n\n` +
            `🎯 \`// myrating\`\n   _Your current rating & rank_\n\n` +
            `🔥 \`// streak <cf_id>\`\n   _Current & max daily streak_\n\n` +
            `🧠 \`// info <cf_id>\`\n   _Full profile & solve stats_\n\n` +
            `⚔️ \`// compare <id1> <id2>\`\n   _Head-to-head comparison_\n\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
            `🏷 *[ 03 ]  CONTESTS*\n` +
            `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n` +
            `📅 \`// upcoming\`\n   _Next CF, LC, CC & AtCoder contests_\n\n` +
            `🧩 \`// solved\`\n   _Who solved what in last contest_\n\n` +
            `🏁 \`// contest <id>\`\n   _Group standings for any contest_\n   _eg. // contest 1790_\n\n` +
            `🎲 \`// suggest <rating>\`\n   _Random CF problem at that rating_\n   _eg. // suggest 1800_\n\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
            `🏷 *[ 04 ]  DAILY TRACKING*\n` +
            `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n` +
            `✅ \`// today <url>\`\n   _Who solved a problem today (IST)_\n\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
            `🏷 *[ 05 ]  HELP*\n` +
            `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n` +
            `📖 \`// help\`\n   _Show this menu anytime_\n\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
            `✦ *AUTO FEATURES*\n` +
            `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n` +
            `🥇 *Winner Alert*\n   _Announced live right after_\n   _every CF contest — automatic!_\n\n` +
            `🎉 *Promotion Alert*\n   _Congrats when you rank up!_\n\n` +
            `⏰ *Contest Reminder*\n   _Auto sent 24h & 1h before_\n   _every contest. Never miss one!_\n\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n` +
            `✦  *Code hard. Rank higher.* 🚀\n` +
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰`
          );
        }

      } catch (err) {
        console.error("Command error:", err.message);
        await reply("❌ Something went wrong. Try again.");
      }
    }
  });
}

startBot().catch(console.error);
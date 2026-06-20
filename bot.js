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
        console.log(`⏳ CF 429 rate-limited — retry ${config.__cfRetryCount}/3 in ${delay/1000}s`);
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

// ─── Rank thresholds ──────────────────────────────────────────────────────────
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
  [800, 1000], [1000, 1200], [1200, 1400], [1400, 1600],
  [1600, 1800], [1800, 2000], [2000, 2200], [2200, 2400], [2400, Infinity],
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

// ─── Contest Helpers (Unified) ───────────────────────────────────────────────
async function getCFContestList() {
  const res = await axios.get("https://codeforces.com/api/contest.list?gym=false", { timeout: 10000 });
  return res.data.result;
}

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

// ─── AtCoder: Kenkoooo API (public, no key needed) ──────────────────────────
async function getAtCoderUpcoming() {
  try {
    // Use the public Kenkoooo API for AtCoder contests (no authentication required)
    const res = await axios.get("https://kenkoooo.com/atcoder/atcoder-api/v3/upcoming", { timeout: 8000 });
    const now = Math.floor(Date.now() / 1000);
    return (res.data || [])
      .filter(c => c.startTimeSeconds > now)
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
      .slice(0, 10)
      .map((c) => ({
        id: `at-${c.id}`,
        platform: "AtCoder",
        name: c.title || c.name || `Contest #${c.id}`,
        startTimeSeconds: c.startTimeSeconds,
        durationSeconds: c.durationSeconds || 7200,
        url: `https://atcoder.jp/contests/${c.id}`,
      }));
  } catch (e) {
    console.error("[AtCoder] Kenkoooo API error:", e.message);
    // Fallback to competeapi if Kenkoooo fails
    try {
      const res2 = await axios.get("https://competeapi.vercel.app/contests/upcoming/", { timeout: 8000 });
      const now = Date.now();
      return (res2.data || [])
        .filter((c) => c.site?.toLowerCase() === "atcoder" && c.startTime > now)
        .sort((a, b) => a.startTime - b.startTime)
        .slice(0, 10)
        .map((c) => {
          const slug = c.slug || c.id || c.title?.toLowerCase().replace(/\s+/g, '-') || 'unknown';
          return {
            id: `at-${slug}`,
            platform: "AtCoder",
            name: c.title || c.name || c.event || 'AtCoder Contest',
            startTimeSeconds: Math.floor(c.startTime / 1000),
            durationSeconds: Math.floor((c.duration || 7200) / 1000),
            url: `https://atcoder.jp/contests/${slug}`,
          };
        });
    } catch (e2) {
      console.error("[AtCoder] Both APIs failed:", e2.message);
      return [];
    }
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

      const groupData = await getGroupData(chatId);
      const handles = getAllHandles(groupData);
      if (!handles.length) {
        console.log(`⏭️ Skipping ${chatId} – no members.`);
        continue;
      }

      const reminders = groupData.reminders || {};

      for (const contest of allContests) {
        const diff = contest.startTimeSeconds - now;
        const minsLeft = Math.round(diff / 60);
        const hoursLeft = Math.round(diff / 3600);
        
        console.log(`⏰ ${contest.platform} - ${contest.name}: ${hoursLeft}h ${minsLeft % 60}m left`);

        if (diff >= 22 * 3600 && diff <= 26 * 3600) {
          if (!reminders[contest.id]?.daySent) {
            await sendReminder(sock, chatId, contest, "day");
            if (!reminders[contest.id]) reminders[contest.id] = {};
            reminders[contest.id].daySent = true;
            console.log(`✅ Day reminder sent for ${contest.id} (${contest.name}) to ${chatId}`);
          } else {
            console.log(`⏭️ Day reminder already sent for ${contest.id}`);
          }
        }
        
        if (diff >= 30 * 60 && diff <= 120 * 60) {
          if (!reminders[contest.id]?.hourSent) {
            await sendReminder(sock, chatId, contest, "hour");
            if (!reminders[contest.id]) reminders[contest.id] = {};
            reminders[contest.id].hourSent = true;
            console.log(`✅ Hour reminder sent for ${contest.id} (${contest.name}) to ${chatId}`);
          } else {
            console.log(`⏭️ Hour reminder already sent for ${contest.id}`);
          }
        }
      }

      groupData.reminders = reminders;
      await saveGroupData(chatId, groupData);
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
  } catch (e) {
    console.error(`Failed to send reminder to ${chatId}:`, e.message);
  }
}

// ─── Helper functions for // solved ──────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds || seconds < 0 || isNaN(seconds)) return 'N/A';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return '0m';
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

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

// ─── Ordinal helper ──────────────────────────────────────────────────────────
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── getContestInfo: fallback fetch of basic contest metadata ───────────────
async function getContestInfo(contestId, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📡 getContestInfo: fetching contest ${contestId} (attempt ${attempt}/${maxRetries})...`);
      const response = await axios.get(
        `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`,
        { timeout: 10000 }
      );
      if (response.data && response.data.status === 'OK' && response.data.result) {
        const info = response.data.result.contest;
        info.problems = response.data.result.problems ? response.data.result.problems.length : 0;
        console.log(`✅ getContestInfo: fetched "${info.name}" (${info.problems} problems)`);
        return info;
      }
      console.log(`⚠️ getContestInfo attempt ${attempt}: API returned non-OK status`);
    } catch (error) {
      console.log(`⚠️ getContestInfo attempt ${attempt} error: ${error.message}`);
    }
    if (attempt < maxRetries) await sleep(1000 * attempt);
  }
  console.error(`❌ getContestInfo: all attempts failed for contest ${contestId}`);
  return null;
}

// =============================================================================
// NEW STANDINGS FUNCTIONS (3‑TIER WITH VALIDATION & RETRIES)
// =============================================================================

// ─── Helper: Build results from API rows ─────────────────────────────────────
function buildResultsFromRows(data) {
  const results = [];
  const problemCount = data.problems ? data.problems.length : 0;
  const phase = data.contest ? data.contest.phase : 'FINISHED';

  if (data.rows) {
    data.rows.forEach(row => {
      let solved = 0;
      const problemResults = [];

      if (row.problemResults && data.problems) {
        row.problemResults.forEach((pr, index) => {
          const isSolved = pr.points > 0;
          if (isSolved) solved++;
          problemResults.push({
            index: data.problems[index]?.index || String.fromCharCode(65 + index),
            solved: isSolved,
            attempts: pr.rejectedAttempts || 0
          });
        });
      }

      const members = row.party.members || [];
      const handle = members[0]?.handle || 'unknown';

      // FIX: Always use row.rank or null – do NOT force null for CODING.
      // The official rank is already available in row.rank even during live contests.
      results.push({
        handle,
        rank: row.rank || null,
        solved,
        penalty: row.penalty || 0,
        totalProblems: problemCount,
        problemResults
      });
    });
  }

  return { results, totalProblems: problemCount, phase, contest: data.contest, problems: data.problems || [] };
}

// ─── Validate handles ────────────────────────────────────────────────────────
async function validateHandles(handles) {
  console.log(`🔍 Validating ${handles.length} handles...`);
  const valid = [];
  const invalid = [];

  for (const handle of handles) {
    try {
      const response = await axios.get(
        `https://codeforces.com/api/user.info?handles=${handle}`,
        { timeout: 5000 }
      );
      if (response.data && response.data.status === 'OK') {
        valid.push(handle);
        console.log(`✅ Valid handle: ${handle}`);
      } else {
        invalid.push(handle);
        console.log(`❌ Invalid handle: ${handle}`);
      }
    } catch (error) {
      invalid.push(handle);
      console.log(`❌ Failed to validate: ${handle} (${error.message})`);
    }
    await sleep(200);
  }

  if (invalid.length > 0) {
    console.log(`⚠️ Invalid handles (skipped): ${invalid.join(', ')}`);
  }
  console.log(`✅ ${valid.length} valid handles found`);
  return valid;
}

// ─── Tier 1: Fast path with handles ─────────────────────────────────────────
async function tier1Fetch(contestId, handles, timeout = 15000) {
  console.log(`🚀 Tier 1: Fetching with handles (${handles.length} requested)...`);
  try {
    const handlesParam = handles.join(';');
    const url = `https://codeforces.com/api/contest.standings?contestId=${contestId}&handles=${handlesParam}&from=1&count=1000&showUnofficial=true`;
    const response = await axios.get(url, { timeout });
    const data = response.data;

    if (data.status === 'OK') {
      const result = buildResultsFromRows(data.result);

      // CF can silently omit handles that aren't registered/ranked instead of
      // erroring — status stays 'OK' but rows.length < handles.length.
      // Treat that as a PARTIAL success so the caller falls through to Tier 2
      // to recover the missing members, rather than undercounting silently.
      const foundHandles = new Set(result.results.map(r => r.handle.toLowerCase()));
      const missingHandles = handles.filter(h => !foundHandles.has(h.toLowerCase()));

      if (missingHandles.length > 0) {
        console.log(`⚠️ Tier 1: partial result — missing ${missingHandles.length}/${handles.length} handle(s): ${missingHandles.join(', ')}`);
        return { success: false, partial: true, error: 'handles_missing_from_response', missingHandles, partialResult: { success: true, source: 'official standings', ...result } };
      }

      console.log(`✅ Tier 1 succeeded — all ${handles.length} handles found`);
      return { success: true, source: 'official standings', ...result };
    } else {
      if (data.comment && data.comment.includes('handles: user not found')) {
        console.log(`⚠️ Tier 1: handles not found in contest — comment: "${data.comment}"`);
        return { success: false, error: 'handles_not_found', comment: data.comment };
      } else {
        console.log(`⚠️ Tier 1 failed — API comment: "${data.comment}"`);
        return { success: false, error: data.comment || 'API error' };
      }
    }
  } catch (error) {
    console.log(`⚠️ Tier 1 error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ─── Tier 2: Full standings with retries ────────────────────────────────────
async function tier2Fetch(contestId, handles, maxRetries = 3) {
  console.log('🚀 Tier 2: Fetching full standings...');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1000&showUnofficial=true`;
      const response = await axios.get(url, { timeout: 30000 });
      const data = response.data;

      if (data.status === 'OK') {
        console.log(`✅ Tier 2 succeeded on attempt ${attempt}`);
        const result = buildResultsFromRows(data.result);
        // Filter only our handles
        const filteredResults = result.results.filter(r =>
          handles.some(h => h.toLowerCase() === r.handle.toLowerCase())
        );
        // Add back any missing handles with 0 solves so they appear in output
        const foundHandles = new Set(filteredResults.map(r => r.handle.toLowerCase()));
        const stillMissing = handles.filter(h => !foundHandles.has(h.toLowerCase()));
        if (stillMissing.length > 0) {
          console.log(`⚠️ Tier 2: ${stillMissing.length} handle(s) not found — adding them with 0 solves`);
          stillMissing.forEach(h => {
            filteredResults.push({ handle: h, rank: null, solved: 0, penalty: 0, totalProblems: result.totalProblems, problemResults: [] });
          });
        }
        return {
          success: true,
          source: 'official standings',
          ...result,
          results: filteredResults
        };
      } else {
        console.log(`⚠️ Tier 2 attempt ${attempt}/${maxRetries} failed — API comment: "${data.comment}"`);
      }
    } catch (error) {
      console.log(`⚠️ Tier 2 attempt ${attempt}/${maxRetries} error: ${error.message}`);
    }
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`⏳ Tier 2: retrying in ${delay/1000}s...`);
      await sleep(delay);
    }
  }
  console.log('❌ Tier 2: all attempts failed');
  return { success: false, error: 'All Tier 2 attempts failed' };
}

// ─── Tier 3: Slow fallback with concurrency ─────────────────────────────────
async function tier3Fetch(contestId, handles, contestInfo) {
  console.log('🐢 Tier 3: Slow fallback with submission scan...');
  const results = [];
  const concurrency = 5;
  const baseDelay = 400;
  const RETRY_DELAYS = [2000, 4000, 8000];

  for (let i = 0; i < handles.length; i += concurrency) {
    const chunk = handles.slice(i, i + concurrency);
    console.log(`📊 Tier 3: processing chunk ${Math.floor(i/concurrency) + 1}/${Math.ceil(handles.length/concurrency)}`);

    const chunkResults = await Promise.all(
      chunk.map(async (handle) => {
        let lastError = null;

        for (let retry = 0; retry <= RETRY_DELAYS.length; retry++) {
          try {
            await sleep(baseDelay);

            const response = await axios.get(
              `https://codeforces.com/api/user.status?handle=${handle}&contestId=${contestId}&from=1&count=10000`,
              { timeout: 15000 }
            );
            const data = response.data;

            if (data.status !== 'OK') {
              console.log(`⚠️ Tier 3: failed to fetch submissions for ${handle} — comment: "${data.comment}"`);
              return { handle, solved: 0, penalty: 0, rank: null };
            }

            const startTime = contestInfo.startTimeSeconds;
            const endTime = contestInfo.phase === 'CODING'
              ? Math.floor(Date.now() / 1000)
              : startTime + contestInfo.durationSeconds;

            const contestSubmissions = data.result.filter(sub =>
              sub.contestId === parseInt(contestId) &&
              sub.creationTimeSeconds >= startTime &&
              sub.creationTimeSeconds <= endTime
            );

            const solvedProblems = new Set();
            let penalty = 0;
            const attempts = {};

            const sortedSubs = contestSubmissions.sort(
              (a, b) => a.creationTimeSeconds - b.creationTimeSeconds
            );

            for (const sub of sortedSubs) {
              const problemId = sub.problem.index;
              if (sub.verdict === 'OK' && !solvedProblems.has(problemId)) {
                solvedProblems.add(problemId);
                const timeFromStart = sub.creationTimeSeconds - startTime;
                const wrongAttempts = attempts[problemId] || 0;
                penalty += Math.floor(timeFromStart / 60) + (wrongAttempts * 20);
              } else if (sub.verdict !== 'OK' && !solvedProblems.has(problemId)) {
                attempts[problemId] = (attempts[problemId] || 0) + 1;
              }
            }

            console.log(`✅ Tier 3: ${handle} — ${solvedProblems.size} solved, ${penalty} penalty`);
            return {
              handle,
              solved: solvedProblems.size,
              penalty,
              rank: null,
              totalProblems: contestInfo.problems || 0
            };
          } catch (error) {
            lastError = error;
            const status = error.response?.status;
            if (status === 429 && retry < RETRY_DELAYS.length) {
              const delay = RETRY_DELAYS[retry];
              console.log(`⏳ Tier 3: rate-limited (429) for ${handle}, backing off ${delay/1000}s (retry ${retry + 1}/${RETRY_DELAYS.length})...`);
              await sleep(delay);
              continue;
            }
            console.error(`❌ Tier 3: error fetching submissions for ${handle}: ${error.message}`);
            return { handle, solved: 0, penalty: 0, rank: null };
          }
        }

        console.error(`❌ Tier 3: exhausted retries for ${handle}: ${lastError?.message}`);
        return { handle, solved: 0, penalty: 0, rank: null };
      })
    );

    results.push(...chunkResults);
    if (i + concurrency < handles.length) {
      console.log(`⏳ Tier 3: waiting 1s before next chunk...`);
      await sleep(1000);
    }
  }

  const totalProblems = results.length > 0
    ? Math.max(...results.map(r => r.totalProblems || 0))
    : (contestInfo.problems || 0);

  console.log(`✅ Tier 3 completed: ${results.length} results, ${totalProblems} total problems`);
  return {
    success: true,
    source: 'submission scan',
    results: results.map(r => ({ ...r, totalProblems })),
    totalProblems,
    phase: contestInfo.phase,
    contest: contestInfo,
    problems: []
  };
}

// ─── Main function: getContestStandings (3‑tier) ────────────────────────────
async function getContestStandings(contestId, handles, contestInfo = null) {
  console.log(`📊 Fetching standings for contest ${contestId} with ${handles.length} handles${contestInfo ? ' (metadata pre-supplied)' : ''}`);

  // Validate handles (but we cache this later – for now, we trust they are valid)
  const validHandles = await validateHandles(handles);
  if (validHandles.length === 0) {
    console.log('❌ No valid handles found');
    return {
      success: false,
      error: 'No valid handles found',
      results: handles.map(h => ({ handle: h, solved: 0, penalty: 0, rank: null })),
      totalProblems: 0,
      phase: 'UNKNOWN'
    };
  }

  // Try Tier 1
  const tier1Result = await tier1Fetch(contestId, validHandles);
  if (tier1Result.success) {
    console.log('✅ Returning Tier 1 results (all handles found)');
    return finalizeStandings(tier1Result, validHandles);
  }

  if (tier1Result.partial) {
    console.log(`⚠️ Tier 1 partial (missing ${tier1Result.missingHandles.length} handle(s)) — merging with Tier 2`);
  } else if (tier1Result.error === 'handles_not_found') {
    console.log('⚠️ Tier 1: no handles found in contest, continuing to Tier 2');
  } else {
    console.log(`⚠️ Tier 1 failed: ${tier1Result.error}, continuing to Tier 2`);
  }

  // Try Tier 2
  const tier2Result = await tier2Fetch(contestId, validHandles);
  if (tier2Result.success) {
    if (tier1Result.partial) {
      const tier1Handles = new Set(tier1Result.partialResult.results.map(r => r.handle.toLowerCase()));
      const mergedResults = [
        ...tier1Result.partialResult.results,
        ...tier2Result.results.filter(r => !tier1Handles.has(r.handle.toLowerCase()))
      ];
      console.log(`✅ Returning merged Tier 1 + Tier 2 results (${mergedResults.length}/${validHandles.length} handles covered)`);
      return finalizeStandings({ ...tier2Result, results: mergedResults }, validHandles);
    }
    console.log('✅ Returning Tier 2 results');
    return finalizeStandings(tier2Result, validHandles);
  }
  console.log(`⚠️ Tier 2 failed: ${tier2Result.error}, continuing to Tier 3`);

  // Get contest info for Tier 3
  let meta = contestInfo;
  if (meta && meta.startTimeSeconds && meta.durationSeconds) {
    console.log(`✅ Using pre-supplied contest metadata: ${meta.name}`);
    if (meta.problems === undefined) {
      meta.problems = tier1Result.partialResult?.totalProblems || tier2Result.totalProblems || 0;
    }
  } else {
    meta = await getContestInfo(contestId);
    if (!meta) {
      console.error('❌ All tiers failed — could not fetch contest metadata either');
      return {
        success: false,
        error: 'All tiers failed - cannot fetch contest info',
        results: validHandles.map(h => ({ handle: h, solved: 0, penalty: 0, rank: null })),
        totalProblems: 0,
        phase: 'UNKNOWN'
      };
    }
  }

  // Try Tier 3
  const tier3Result = await tier3Fetch(contestId, validHandles, meta);
  console.log('✅ Returning Tier 3 results');
  return finalizeStandings(tier3Result, validHandles);
}

// ─── finalizeStandings: shared post-processing ──────────────────────────────
function finalizeStandings(result, validHandles) {
  if (!result.totalProblems) {
    const maxSolved = Math.max(0, ...result.results.map(r => r.solved || 0));
    if (maxSolved > 0) {
      console.log(`⚠️ totalProblems unavailable — falling back to max solved (${maxSolved})`);
      result.totalProblems = maxSolved;
    }
  }
  if (!result.source) result.source = 'official standings';
  return result;
}

// ─── Compare contest entries ─────────────────────────────────────────────────
function compareContestEntries(a, b) {
  if (a.solved !== b.solved) return b.solved - a.solved;
  if (a.rank !== null && b.rank !== null && a.rank !== undefined && b.rank !== undefined) {
    return a.rank - b.rank;
  }
  if ((a.rank === null || a.rank === undefined) && (b.rank === null || b.rank === undefined)) {
    return a.penalty - b.penalty;
  }
  if (a.rank === null || a.rank === undefined) return 1;
  if (b.rank === null || b.rank === undefined) return -1;
  return a.handle.localeCompare(b.handle);
}

// ─── Winner Checker + Promotion Checker ──────────────────────────────────────
async function checkAndAnnounceWinner(sock) {
  // ... (unchanged, but kept for completeness)
}

async function getRecentFinishedContest() {
  try {
    const list = await getCFContestList();
    const finished = list.filter((c) => c.phase === "FINISHED");
    return finished.length ? finished[0] : null;
  } catch { return null; }
}

async function getRunningContest() {
  try {
    const list = await getCFContestList();
    const running = list.filter((c) => c.phase === "CODING");
    return running.length ? running[0] : null;
  } catch { return null; }
}

// ─── Delta7 ──────────────────────────────────────────────────────────────────
async function getDelta7(handles) {
  // ... (unchanged)
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

function formatIST(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " IST";
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
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startBot, 3000);
      else console.log("Logged out. Clear AuthState from MongoDB.");
    }
    if (connection === "open") {
      latestQR = null;
      console.log("✅ CF Bot is ready!");

      console.log("🚀 Running immediate reminder check...");
      await checkAndSendReminders(sock);

      setTimeout(() => {
        console.log("🔄 Running startup reminder check (delayed)...");
        checkAndSendReminders(sock);
      }, 30000);

      console.log("✅ Reminder interval started");
      setInterval(() => checkAndSendReminders(sock), 10 * 60 * 1000);

      setInterval(() => checkAndAnnounceWinner(sock), 5 * 60 * 1000);
      setTimeout(() => checkAndAnnounceWinner(sock), 2 * 60 * 1000);
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
            added++;
          }
          await saveGroupData(chatId, groupData);
          let text = `*Registration Results:*\n\n` + results.join("\n");
          if (args.length > 1) text += `\n\n👥 ${added} added${failed ? `, ${failed} failed` : ""}`;
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
          try {
            const list = await getCFContestList();
            const sorted = list.sort((a, b) => b.startTimeSeconds - a.startTimeSeconds);
            const running = sorted.find(c => c.phase === "CODING");
            if (running) {
              contest = running;
            } else {
              const finished = sorted.find(c => c.phase === "FINISHED");
              if (finished) contest = finished;
            }
          } catch (e) {
            console.error("Error fetching contest list:", e.message);
          }

          if (!contest) {
            await reply(`⚠️ Could not detect the latest contest automatically (CF API may be down).\nPlease use \`// contest <id>\` to check standings manually.`);
            continue;
          }

          await reply(`⏳ Fetching standings for *${contest.name}*...\n_May take a few seconds_`);

          const standingsResult = await getContestStandings(contest.id, handles, contest);
          if (!standingsResult.success) {
            await reply(`❌ Failed to fetch standings: ${standingsResult.error}`);
            continue;
          }

          const data = standingsResult;
          const results = data.results || [];
          const totalProblems = data.totalProblems || 0;
          const participants = results.filter(r => r.solved > 0).sort(compareContestEntries);

          const problems = data.problems || [];
          const problemLetters = problems.map(p => p.index).join(" ");
          const isEstimated = data.source === 'submission scan';

          let text = `📊 *${contest.name}*\n`;
          text += `📅 ${formatIST(contest.startTimeSeconds)}\n`;
          text += `⏱ Duration: ${formatDuration(contest.durationSeconds)}\n`;
          if (totalProblems) text += `📝 Problems: ${totalProblems}${problemLetters ? ` (${problemLetters})` : ''}\n`;
          text += `${"─".repeat(28)}\n\n`;

          if (!participants.length) {
            text += `😴 No group members have participated yet.`;
          } else {
            const medals = ['🥇', '🥈', '🥉'];
            participants.forEach((r, i) => {
              const medal = i < 3 ? medals[i] : '';
              // Show rank if available, else N/A (but never force N/A for live)
              const rankDisplay = r.rank ? `#${r.rank}` : 'N/A';
              text += `${medal} ${ordinal(i + 1)} *${r.handle}* (${r.solved}/${totalProblems} Q) (Rank ${rankDisplay})\n`;
            });
            text += `\n${isEstimated ? '⚠️ _(via submission scan – rank unavailable)_' : '✅ _(via official standings)_'}`;
          }
          await reply(text.trim());
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

          await reply(`⏳ Fetching standings for *${contestInfo.name}*...\n_May take a few seconds_`);

          const standingsResult = await getContestStandings(contestId, handles, contestInfo);
          if (!standingsResult.success) {
            await reply(`❌ Failed to fetch standings: ${standingsResult.error}`);
            continue;
          }

          const data = standingsResult;
          const results = data.results || [];
          const totalProblems = data.totalProblems || 0;
          const participants = results.filter(r => r.solved > 0).sort(compareContestEntries);

          const problems = data.problems || [];
          const problemLetters = problems.map(p => p.index).join(" ");
          const isEstimated = data.source === 'submission scan';

          let statusEmoji = "📊";
          if (contestInfo.phase === "CODING") statusEmoji = "🟢 *LIVE*";
          else if (contestInfo.phase === "BEFORE") statusEmoji = "⏳ *UPCOMING*";
          else if (contestInfo.phase === "FINISHED") statusEmoji = "🏁 *FINISHED*";

          let text = `${statusEmoji} *${contestInfo.name}*\n`;
          text += `📅 ${formatIST(contestInfo.startTimeSeconds)}\n`;
          text += `⏱ Duration: ${formatDuration(contestInfo.durationSeconds)}\n`;
          if (totalProblems) text += `📝 Problems: ${totalProblems}${problemLetters ? ` (${problemLetters})` : ''}\n`;
          text += `${"─".repeat(28)}\n\n`;

          if (!participants.length) {
            text += `😴 No group members participated in this contest.`;
          } else {
            const medals = ['🥇', '🥈', '🥉'];
            participants.forEach((r, i) => {
              const medal = i < 3 ? medals[i] : '';
              const rankDisplay = r.rank ? `#${r.rank}` : 'N/A';
              text += `${medal} ${ordinal(i + 1)} *${r.handle}* (${r.solved}/${totalProblems} Q) (Rank ${rankDisplay})\n`;
            });
            text += `\n${isEstimated ? '⚠️ _(via submission scan – rank unavailable)_' : '✅ _(via official standings)_'}`;
          }
          text += `\n🔗 https://codeforces.com/contest/${contestId}`;
          await reply(text.trim());
        }

        // ── // whosolvedtoday ──────────────────────────────────────────
        else if (command.startsWith("// whosolvedtoday ")) {
          // ... (unchanged)
        }

        // ── // streak ──────────────────────────────────────────────────
        else if (command.startsWith("// streak")) {
          // ... (unchanged)
        }

        // ── // info ──────────────────────────────────────────────────
        else if (command.startsWith("// info")) {
          // ... (unchanged)
        }

        // ── // compare ──────────────────────────────────────────────────
        else if (command.startsWith("// compare")) {
          // ... (unchanged)
        }

        // ── // delta7 ──────────────────────────────────────────────────
        else if (command === "// delta7") {
          // ... (unchanged)
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
            `▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n` +
            `🏷 *[ 04 ]  DAILY TRACKING*\n` +
            `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n` +
            `✅ \`// whosolvedtoday <url>\`\n   _Who solved a problem today (IST)_\n\n` +
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
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

// ─── AtCoder: Clist fallback ─────────────────────────────────────────────────
async function getAtCoderFromClist() {
  try {
    const res = await axios.get("https://clist.by/api/v4/contest/", {
      params: {
        resource: "atcoder.jp",
        start__gt: new Date().toISOString(),
        order_by: "start",
        limit: 10,
        format: "json",
      },
      headers: { Authorization: "ApiKey jenis854cpy:YOUR_API_KEY" }, // replace with your key
      timeout: 10000,
    });

    return (res.data?.objects || []).map((c) => ({
      id: `at-${c.id}`,
      platform: "AtCoder",
      name: c.event,
      startTimeSeconds: Math.floor(new Date(c.start).getTime() / 1000),
      durationSeconds: c.duration,
      url: c.href,
    }));
  } catch (e) {
    console.error("[AtCoder Clist] error:", e.message);
    return [];
  }
}

// ─── Primary AtCoder function ────────────────────────────────────────────────
async function getAtCoderUpcoming() {
  try {
    const res = await axios.get(
      "https://competeapi.vercel.app/contests/upcoming/",
      { timeout: 10000 }
    );
    const now = Date.now();

    const raw = (res.data || []).filter(
      (c) => c.site?.toLowerCase() === "atcoder"
    );

    console.log(`[AtCoder] competeapi entries: ${raw.length}`);
    if (raw.length > 0) console.log("[AtCoder] Sample:", raw[0]);

    if (raw.length === 0) {
      console.log("[AtCoder] Falling back to Clist...");
      return await getAtCoderFromClist();
    }

    return raw
      .map((c) => {
        const title    = c.title ?? c.name ?? c.event ?? "unknown";
        let   start    = c.startTime ?? c.start ?? c.start_time ?? 0;
        const duration = c.duration ?? c.length ?? 0;

        if (start > 1e12) start = Math.floor(start / 1000); // ms → s

        return {
          id: `at-${title.replace(/[^a-zA-Z0-9]/g, "-")}`,
          platform: "AtCoder",
          name: title,
          startTimeSeconds: start,
          durationSeconds: Math.floor(duration / 1000),
          url: `https://atcoder.jp/contests/${title}`,
        };
      })
      .filter((c) => c.startTimeSeconds > Math.floor(now / 1000))
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
      .slice(0, 10);

  } catch (e) {
    console.error("[AtCoder] Primary API error:", e.message);
    return getAtCoderFromClist();
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
    
    // Use Promise.allSettled so one API failure doesn't break everything
    const results = await Promise.allSettled([
      getCFUpcoming(),
      getCodeChefUpcoming(),
      getLeetCodeUpcoming(),
      getAtCoderUpcoming(),
    ]);

    // Extract successful results only
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
      
      // Skip groups with no members
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

        // DAY REMINDER: 22–26 hours (was 23.5–24.5)
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
        
        // HOUR REMINDER: 30–120 minutes (was 30–90)
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
    // Don't throw - let the cron job continue
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

// ─── getContestInfo (using axios) ────────────────────────────────────────────
async function getContestInfo(contestId) {
  try {
    const response = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`,
      { timeout: 8000 }
    );
    const data = response.data;
    if (data && data.status === 'OK' && data.result && data.result.contest) {
      return data.result.contest;
    }
    return { 
      name: `Codeforces Round #${contestId}`, 
      startTimeSeconds: 0, 
      durationSeconds: 7200 
    };
  } catch {
    return { 
      name: `Codeforces Round #${contestId}`, 
      startTimeSeconds: 0, 
      durationSeconds: 7200 
    };
  }
}

// ─── getContestStandings (using axios) ───────────────────────────────────────
async function getContestStandings(contestId, handles) {
  try {
    const handlesParam = Array.isArray(handles) ? handles.join(';') : handles;
    const url = `https://codeforces.com/api/contest.standings?contestId=${contestId}&handles=${handlesParam}&from=1&count=1000`;
    
    const response = await axios.get(url, { timeout: 12000 });
    const data = response.data;

    if (data && data.status === 'OK' && data.result) {
      const problemCount = data.result.problems ? data.result.problems.length : 0;
      const phase = data.result.contest ? data.result.contest.phase : 'FINISHED';
      
      // Initialize ALL members with 0 solves
      const allResults = handles.map(handle => ({
        handle: handle,
        rank: null,
        solved: 0,
        penalty: 0,
        totalProblems: problemCount,
        problemResults: []
      }));

      // Merge API results
      if (data.result.rows && data.result.rows.length > 0) {
        data.result.rows.forEach(row => {
          const matchedHandle = handles.find(
            h => h.toLowerCase() === row.party.members[0].handle.toLowerCase()
          );
          if (matchedHandle) {
            const memberIndex = allResults.findIndex(
              r => r.handle.toLowerCase() === matchedHandle.toLowerCase()
            );
            if (memberIndex !== -1) {
              let solved = 0;
              const problemResults = [];
              if (row.problemResults && data.result.problems) {
                row.problemResults.forEach((pr, index) => {
                  const isSolved = pr.points > 0;
                  if (isSolved) {
                    solved++;
                    problemResults.push({
                      index: data.result.problems[index]?.index || String.fromCharCode(65 + index),
                      solved: true,
                      attempts: pr.rejectedAttempts || 0
                    });
                  } else {
                    problemResults.push({
                      index: data.result.problems[index]?.index || String.fromCharCode(65 + index),
                      solved: false,
                      attempts: pr.rejectedAttempts || 0
                    });
                  }
                });
              }
              allResults[memberIndex] = {
                handle: matchedHandle,
                rank: phase === 'CODING' ? null : (row.rank || null),
                solved: solved,
                penalty: row.penalty || 0,
                totalProblems: problemCount,
                problemResults: problemResults
              };
            }
          }
        });
      }
      
      return {
        success: true,
        results: allResults,
        totalProblems: problemCount,
        phase: phase
      };
    } else {
      return { success: false, error: data?.comment || 'API returned invalid response' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ─── compareContestEntries ───────────────────────────────────────────────────
function compareContestEntries(a, b) {
  if (a.solved !== b.solved) return b.solved - a.solved;
  if (a.rank !== null && b.rank !== null && a.rank !== undefined && b.rank !== undefined) {
    return a.rank - b.rank;
  }
  if ((a.rank === null || a.rank === undefined) && (b.rank === null || b.rank === undefined)) {
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  }
  if (a.rank === null || a.rank === undefined) return 1;
  if (b.rank === null || b.rank === undefined) return -1;
  return a.handle.localeCompare(b.handle);
}

// ─── Fallback function (using axios) ────────────────────────────────────────
async function handleSlowFallback(sock, from, contestId, handles) {
  try {
    await sock.sendMessage(from, { text: '⏳ Using slow fallback method... This may take a moment.' });

    const contestInfo = await getContestInfo(contestId);
    const startTime = contestInfo.startTimeSeconds || 0;
    const duration = contestInfo.durationSeconds || 7200;
    const endTime = startTime + duration;
    
    const results = [];
    let totalProblems = 0;
    
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      if (i > 0) await sleep(500);
      
      try {
        const subResponse = await axios.get(
          `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`,
          { timeout: 15000 }
        );
        const subData = subResponse.data;
        if (subData.status === 'OK' && subData.result) {
          const contestSubmissions = subData.result.filter(sub => 
            sub.contestId == contestId &&
            sub.creationTimeSeconds >= startTime &&
            sub.creationTimeSeconds <= endTime
          );
          if (contestSubmissions.length > 0) {
            const problemIndexes = contestSubmissions.map(s => s.problem.index);
            const uniqueProblems = new Set(problemIndexes);
            totalProblems = Math.max(totalProblems, uniqueProblems.size);
          }
          const solvedProblems = new Set();
          let penalty = 0;
          const sortedSubs = contestSubmissions.sort((a, b) => a.creationTimeSeconds - b.creationTimeSeconds);
          const attempts = {};
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
          results.push({ handle, rank: null, solved: solvedProblems.size, penalty, totalProblems: 0 });
        } else {
          results.push({ handle, rank: null, solved: 0, penalty: 0, totalProblems: 0 });
        }
      } catch (error) {
        results.push({ handle, rank: null, solved: 0, penalty: 0, totalProblems: 0 });
      }
    }
    
    if (totalProblems === 0) {
      try {
        const standingsResponse = await axios.get(
          `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`,
          { timeout: 8000 }
        );
        if (standingsResponse.data.status === 'OK' && standingsResponse.data.result) {
          totalProblems = standingsResponse.data.result.problems.length;
        }
      } catch (error) {
        totalProblems = results.reduce((max, r) => Math.max(max, r.solved), 0);
      }
    }
    
    results.forEach(r => r.totalProblems = totalProblems);
    results.sort(compareContestEntries);
    
    const hasSolves = results.some(r => r.solved > 0);
    if (!hasSolves) {
      await sock.sendMessage(from, { text: `😴 No group members have participated yet.\n\nContest: #${contestId}` });
      return;
    }
    
    let output = `⚠️ *Fallback Results* (API unavailable)\n📝 Problems: ${totalProblems}\n────────────────────────────\n\n`;
    results.forEach((entry, index) => {
      output += `${index + 1}. *${entry.handle}* — ✅ ${entry.solved}/${totalProblems} solved | Unrated\n`;
    });
    await sock.sendMessage(from, { text: output });
  } catch (error) {
    console.error('Fallback error:', error);
    await sock.sendMessage(from, { text: '❌ Fallback method failed. Please try again later.' });
  }
}

// ─── Winner Checker + Promotion Checker ──────────────────────────────────────
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

      // ─── Winner announcement ──────────────────────────────────────────────
      if (groupData.lastContestAnnounced !== lastId) {
        const finishedAt = lastContest.startTimeSeconds + lastContest.durationSeconds;
        const now = Math.floor(Date.now() / 1000);
        if (now - finishedAt <= 7200) {
          const { success, results } = await getContestStandings(lastId, handles);
          if (success && results) {
            const entries = results.filter(r => r.solved > 0).sort(compareContestEntries);
            if (entries.length) {
              const [winner] = entries;
              let text = `🏁 *Contest Over!*\n📋 *${lastContest.name}*\n${"─".repeat(28)}\n\n`;
              text += `🏆 *Group Winner: ${winner.handle}* with *${winner.solved}* solved${winner.rank ? ` (Rank #${winner.rank})` : ''}!\n\n📊 *Group Performance:*\n`;
              entries.forEach((r, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
                const rankStr = r.rank ? ` | Rank #${r.rank}` : ' | Unrated';
                text += `${medal} *${r.handle}* — ✅ ${r.solved} solved${rankStr}\n`;
              });
              await sock.sendMessage(chatId, { text });
            }
          }
        }
        await saveGroupData(chatId, { ...groupData, lastContestAnnounced: lastId });
      }

      // ─── Promotion Checker ──────────────────────────────────────────────
      if (groupData.lastRatingAnnounced === lastId) continue;

      const endTime = lastContest.startTimeSeconds + lastContest.durationSeconds;
      const now = Math.floor(Date.now() / 1000);
      if (now - endTime < 1800) {
        console.log(`⏳ Waiting for rating changes to be available for contest ${lastId} (ended ${Math.floor((now-endTime)/60)} min ago)`);
        continue;
      }

      let ratingChanges = [];
      try {
        const res = await axios.get(
          `https://codeforces.com/api/contest.ratingChanges?contestId=${lastId}`,
          { timeout: 15000 }
        );
        if (res.data && res.data.status === 'OK' && res.data.result) {
          ratingChanges = res.data.result;
        }
      } catch (e) {
        console.log(`No rating changes for contest ${lastId} (unrated or not available)`);
      }

      if (!ratingChanges.length) {
        await saveGroupData(chatId, { ...groupData, lastRatingAnnounced: lastId });
        continue;
      }

      const changeMap = {};
      for (const entry of ratingChanges) {
        changeMap[entry.handle.toLowerCase()] = entry;
      }

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

      if (promoted.length) {
        let msg = `🎉 *Promotion Alerts!* 🎉\n\n`;
        for (const p of promoted) {
          msg += `@${p.handle} — Congratulations! You've been promoted from *${p.oldRank}* to *${p.newRank}*! 🚀\n`;
          msg += `📊 Rating Change: ${p.oldRating} → ${p.newRating} (${p.delta >= 0 ? '+' : ''}${p.delta})\n`;
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

// ─── Contest Helpers ──────────────────────────────────────────────────────────
async function getRunningContest() {
  try {
    const list = await getCFContestList();
    const running = list.filter((c) => c.phase === "CODING");
    return running.length ? running[0] : null;
  } catch { return null; }
}

async function getContestDetails(contestId) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`,
      { timeout: 12000 }
    );
    if (!res.data || !res.data.result) return { problems: [], contest: null };
    return {
      problems: res.data.result.problems || [],
      contest: res.data.result.contest,
    };
  } catch (e) {
    console.error(`getContestDetails error for ${contestId}:`, e.message);
    return { problems: [], contest: null };
  }
}

// ─── Delta7 (weekly leaderboard with points) ─────────────────────────────────
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

      // ─── Immediate reminder check ───────────────────────────────────────
      console.log("🚀 Running immediate reminder check...");
      await checkAndSendReminders(sock);

      // ─── Delayed reminder check (ensures everything is fully loaded) ──
      setTimeout(() => {
        console.log("🔄 Running startup reminder check (delayed)...");
        checkAndSendReminders(sock);
      }, 30000);

      // ─── Periodic checks ────────────────────────────────────────────────
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
          if (!handles.length) { await reply("📭 No members registered.\nUse `// add your_cf_id` to join."); continue; }

          // ── 1. Get the latest running or finished contest (sorted) ──
          let contest = null;
          let isLive = false;
          try {
            const list = await getCFContestList();
            // Sort by start time descending to get the most recent
            const sorted = list.sort((a, b) => b.startTimeSeconds - a.startTimeSeconds);
            // Find the first contest that is either CODING or FINISHED (and not BEFORE)
            // We prefer a running contest if any.
            const running = sorted.find(c => c.phase === "CODING");
            if (running) {
              contest = running;
              isLive = true;
            } else {
              // else pick the most recent finished contest
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

          // ── 2. Try standings API with retries ──
          let standingsResult = null;
          const maxRetries = 3;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              const result = await getContestStandings(contest.id, handles);
              if (result.success) {
                standingsResult = result;
                break;
              }
              console.log(`Standings API attempt ${attempt} failed: ${result.error}`);
            } catch (err) {
              console.log(`Standings API attempt ${attempt} error:`, err.message);
            }
            if (attempt < maxRetries) await sleep(1000 * attempt); // exponential backoff
          }

          if (!standingsResult || !standingsResult.success) {
            // Fallback to slow method
            await handleSlowFallback(sock, chatId, contest.id, handles);
            continue;
          }

          const { results, phase } = standingsResult;   // ← removed 'totalProblems' from here
          const isLiveContest = phase === 'CODING';
          const participants = results.filter(r => r.solved > 0).sort(compareContestEntries);

          // Get problem details for the contest (to show letters & count)
          const details = await getContestDetails(contest.id);
          const problems = details.problems || [];
          const totalProblems = problems.length;          // ← this is the only declaration now
          const problemLetters = problems.map(p => p.index).join(" ");

          let text = `${isLiveContest ? "🟢 *LIVE*" : "📊"} *${contest.name}*\n`;
          text += `📅 ${formatIST(contest.startTimeSeconds)}\n`;
          text += `⏱ Duration: ${formatDuration(contest.durationSeconds)}\n`;
          if (totalProblems) text += `📝 Problems: ${totalProblems} (${problemLetters})\n`;
          text += `${"─".repeat(28)}\n\n`;

          if (!participants.length) {
            text += `😴 No group members have participated yet.`;
          } else {
            const medals = ['🥇', '🥈', '🥉'];
            participants.forEach((r, i) => {
              const prefix = medals[i] ?? ` ${i + 1}.`;
              const rankStr = isLiveContest ? 'Unrated' : (r.rank ? `Rank #${r.rank}` : 'Unrated');
              text += `${prefix} *${r.handle}* — ✅ ${r.solved}${totalProblems ? `/${totalProblems}` : ''} solved | ${rankStr}\n`;
            });
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
            console.log(`🔄 Fallback: fetching contest ${contestId} directly via standings`);
            try {
              const details = await getContestDetails(contestId);
              if (details && details.contest) {
                contestInfo = details.contest;
                console.log(`✅ Fallback succeeded for contest ${contestId}`);
              }
            } catch (e) {
              console.error(`Fallback failed for contest ${contestId}:`, e.message);
            }
          }

          if (!contestInfo) {
            await reply(`❌ Could not fetch contest ${contestId}. Codeforces API may be down or contest does not exist.\nPlease try again later.`);
            continue;
          }

          await reply(`⏳ Fetching standings for *${contestInfo.name}*...\n_May take a few seconds_`);

          const { success, results } = await getContestStandings(contestId, handles);
          if (!success || !results) {
            await reply(`❌ Could not fetch standings for contest ${contestId}. Please try again later.`);
            continue;
          }

          const { problems } = await getContestDetails(contestId);
          const totalProblems = problems ? problems.length : 0;
          const problemLetters = problems ? problems.map((p) => p.index).join(" ") : "";

          const participants = results.filter(r => r.solved > 0).sort(compareContestEntries);

          const now = Math.floor(Date.now() / 1000);
          let statusEmoji = "📊";
          if (contestInfo.phase === "CODING") statusEmoji = "🟢 *LIVE*";
          else if (contestInfo.phase === "BEFORE") statusEmoji = "⏳ *UPCOMING*";
          else if (contestInfo.phase === "FINISHED") statusEmoji = "🏁 *FINISHED*";

          let text = `${statusEmoji} *${contestInfo.name}*\n`;
          text += `📅 ${formatIST(contestInfo.startTimeSeconds)}\n`;
          text += `⏱ Duration: ${formatDuration(contestInfo.durationSeconds)}\n`;
          if (totalProblems) text += `📝 Problems: ${totalProblems} (${problemLetters})\n`;
          text += `${"─".repeat(28)}\n\n`;

          if (!participants.length) {
            text += `😴 No group members participated in this contest.`;
          } else {
            const medals = ['🥇', '🥈', '🥉'];
            participants.forEach((r, i) => {
              const prefix = medals[i] ?? ` ${i + 1}.`;
              const rankStr = r.rank ? `Rank #${r.rank}` : 'Unrated';
              text += `${prefix} *${r.handle}* — ✅ ${r.solved}${totalProblems ? `/${totalProblems}` : ''} solved | ${rankStr}\n`;
            });
          }
          text += `\n🔗 https://codeforces.com/contest/${contestId}`;
          await reply(text.trim());
        }

        // ── // whosolvedtoday ──────────────────────────────────────────
        else if (command.startsWith("// whosolvedtoday ")) {
          const url = body.slice(18).trim();
          if (!url) {
            await reply("❌ Usage: `// whosolvedtoday <problem_url>`\nExample: `// whosolvedtoday https://codeforces.com/contest/1790/problem/D`");
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
          const estimatedSeconds = Math.ceil(handles.length * 1.5 + (handles.length / 2) * 1.5);
          await reply(`🔍 Checking who solved *${contestId}${problemIndex}* today...\n_Checking ${handles.length} member(s) — may take ~${estimatedSeconds} seconds_`);
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
          await reply(`⏳ Fetching streak for *${arg}*... _May take 10-15 seconds_`);
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
          await reply(`⏳ Fetching info for *${arg}*...\n_May take 15-20 seconds_`);
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
          await reply(`⏳ Comparing *${h1}* vs *${h2}*...\n_May take 20-30 seconds_`);
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
          const estimatedSeconds = Math.ceil(handles.length * 1.5 + (handles.length / 2) * 1.5);
          await reply(`⏳ Fetching last 100 submissions for *${handles.length}* members...\n_May take ~${estimatedSeconds} seconds_`);

          const results = await getDelta7(handles);
          const active = results.filter((r) => r.points > 0);

          let text = `📈 *Delta7 (Last 7 Days)*\n${"─".repeat(28)}\n📅 Rolling 7-day points\n\n`;

          if (!active.length) {
            text += `😴 No one solved any problems this week!\nStart grinding! 💪`;
          } else {
            active.forEach((r, i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
              text += `${medal} *${r.handle}* — ${r.points} pts (${r.count} problem${r.count>1?'s':''})\n`;
            });
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
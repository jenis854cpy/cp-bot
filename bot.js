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
  if (!group) return { members: {}, lastContestAnnounced: 0, reminders: {} };
  return {
    members: group.members || {},
    lastContestAnnounced: group.lastContestAnnounced || 0,
    reminders: group.reminders || {},
  };
}

async function saveGroupData(chatId, groupData) {
  await CFData.findOneAndUpdate({ chatId },
    { $set: {
      members: groupData.members,
      lastContestAnnounced: groupData.lastContestAnnounced,
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
        id: `cc-${c.title.replace(/\s/g, '-')}`,
        platform: "CodeChef",
        name: c.title,
        startTimeSeconds: Math.floor(c.startTime / 1000),
        durationSeconds: Math.floor(c.duration / 1000),
        url: `https://www.codechef.com/${c.title}`,
      }));
  } catch { return []; }
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
        id: `lc-${c.title.replace(/\s/g, '-')}`,
        platform: "LeetCode",
        name: c.title,
        startTimeSeconds: c.startTime,
        durationSeconds: c.duration,
        url: `https://leetcode.com/contest/${c.title.toLowerCase().replace(/\s/g, '-')}`,
      }));
  } catch { return []; }
}

// ─── Unified Reminder System ─────────────────────────────────────────────────
async function checkAndSendReminders(sock) {
  try {
    const [cf, cc, lc] = await Promise.all([
      getCFUpcoming(),
      getCodeChefUpcoming(),
      getLeetCodeUpcoming(),
    ]);
    const allContests = [...cf, ...cc, ...lc];
    if (!allContests.length) return;

    const now = Math.floor(Date.now() / 1000);
    const groups = await CFData.find({}).lean();

    for (const group of groups) {
      const chatId = group.chatId;
      if (!chatId.endsWith("@g.us")) continue;

      const groupData = await getGroupData(chatId);
      const handles = getAllHandles(groupData);
      if (!handles.length) continue;

      const reminders = groupData.reminders || {};

      for (const contest of allContests) {
        const diff = contest.startTimeSeconds - now;
        if (diff >= 23.5 * 3600 && diff <= 24.5 * 3600) {
          if (!reminders[contest.id]?.daySent) {
            await sendReminder(sock, chatId, contest, "day");
            reminders[contest.id] = reminders[contest.id] || {};
            reminders[contest.id].daySent = true;
          }
        }
        if (diff >= 45 * 60 && diff <= 75 * 60) {
          if (!reminders[contest.id]?.hourSent) {
            await sendReminder(sock, chatId, contest, "hour");
            reminders[contest.id] = reminders[contest.id] || {};
            reminders[contest.id].hourSent = true;
          }
        }
      }

      groupData.reminders = reminders;
      await saveGroupData(chatId, groupData);
    }
  } catch (e) {
    console.error("checkAndSendReminders error:", e.message);
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
                contest.platform === "CodeChef" ? "🟤" : "🟡";

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

// ─── Winner Checker (Codeforces only) ────────────────────────────────────────
async function checkAndAnnounceWinner(sock) {
  const groups = await CFData.find({}).lean();
  for (const group of groups) {
    const chatId = group.chatId;
    if (!chatId.endsWith("@g.us")) continue;
    const groupData = { members: group.members || {}, lastContestAnnounced: group.lastContestAnnounced || 0 };
    const handles = getAllHandles(groupData);
    if (!handles.length) continue;
    try {
      const lastContest = await getRecentFinishedContest();
      if (!lastContest) continue;
      const lastId = lastContest.id;
      if (groupData.lastContestAnnounced === lastId) continue;
      const finishedAt = lastContest.startTimeSeconds + lastContest.durationSeconds;
      const now = Math.floor(Date.now() / 1000);
      if (now - finishedAt > 7200) { await saveGroupData(chatId, { ...groupData, lastContestAnnounced: lastId }); continue; }
      const solvedMap = await getContestStandings(lastId, handles, lastContest);
      if (!solvedMap) continue;
      // filter and sort using .solved
      const entries = Object.entries(solvedMap)
        .filter(([, data]) => data.solved > 0)
        .sort((a, b) => b[1].solved - a[1].solved);
      if (!entries.length) continue;
      const [winner, winnerData] = entries[0];
      const winnerSolved = winnerData.solved;
      const winnerRank = winnerData.rank;
      let text = `🏁 *Contest Over!*\n📋 *${lastContest.name}*\n${"─".repeat(28)}\n\n`;
      text += `🏆 *Group Winner: ${winner}* with *${winnerSolved}* solved${winnerRank ? ` (Rank #${winnerRank})` : ''}!\n\n📊 *Group Performance:*\n`;
      entries.forEach(([h, data], i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
        const rankStr = data.rank ? ` | Rank #${data.rank}` : '';
        text += `${medal} *${h}* — ✅ ${data.solved} solved${rankStr}\n`;
      });
      await sock.sendMessage(chatId, { text });
      await saveGroupData(chatId, { ...groupData, lastContestAnnounced: lastId });
    } catch (e) { console.error(`Winner check error ${chatId}:`, e.message); }
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

// ─── getContestStandings with rank ──────────────────────────────────────────
async function getContestStandings(contestId, handles, contestInfo) {
  if (!handles || handles.length === 0) return {};

  const lowerToOriginal = {};
  for (const h of handles) {
    lowerToOriginal[h.toLowerCase()] = h;
  }

  // Try official standings first
  try {
    const handlesStr = handles.join(';');
    const url = `https://codeforces.com/api/contest.standings?contestId=${contestId}&handles=${handlesStr}&showUnofficial=true`;
    const res = await axios.get(url, { timeout: 25000 });

    if (res.data && res.data.result && res.data.result.rows && res.data.result.rows.length > 0) {
      const rows = res.data.result.rows;
      const solvedMap = {};
      for (const h of handles) {
        solvedMap[h] = { solved: 0, rank: null };
      }

      for (const row of rows) {
        const memberHandles = row.party.members.map(m => m.handle);
        const acceptedCount = row.problemResults.filter(
          p => p.bestSubmissionTimeSeconds !== undefined && p.bestSubmissionTimeSeconds > 0
        ).length;
        const rank = row.rank;
        for (const apiHandle of memberHandles) {
          const lower = apiHandle.toLowerCase();
          const original = lowerToOriginal[lower];
          if (original) {
            solvedMap[original].solved = acceptedCount;
            solvedMap[original].rank = rank;
          }
        }
      }
      return solvedMap;
    }
  } catch (e) {
    console.error(`Standings API failed for ${contestId}:`, e.message);
  }

  // Fallback: per‑member submissions (no rank)
  console.log(`🔄 Falling back to per‑user submission check for contest ${contestId}`);
  let problemSet = new Set();
  let contestStart = 0;
  let contestEnd = Infinity;

  if (contestInfo && contestInfo.startTimeSeconds && contestInfo.durationSeconds) {
    contestStart = contestInfo.startTimeSeconds;
    contestEnd = contestInfo.startTimeSeconds + contestInfo.durationSeconds;
  } else {
    try {
      const details = await getContestDetails(contestId);
      if (details && details.contest) {
        contestStart = details.contest.startTimeSeconds || 0;
        contestEnd = contestStart + (details.contest.durationSeconds || 0);
        if (details.problems) {
          problemSet = new Set(details.problems.map(p => p.index.toUpperCase()));
        }
      }
    } catch (e) {
      console.error('Failed to fetch contest details for fallback:', e.message);
    }
  }

  if (problemSet.size === 0) {
    try {
      const details = await getContestDetails(contestId);
      if (details && details.problems) {
        problemSet = new Set(details.problems.map(p => p.index.toUpperCase()));
      }
    } catch (e) {
      console.error('Failed to fetch problem set for fallback:', e.message);
    }
  }

  const solvedMap = {};
  for (const h of handles) {
    solvedMap[h] = { solved: 0, rank: null };
  }

  for (let i = 0; i < handles.length; i += 2) {
    const batch = handles.slice(i, i + 2);
    const batchResults = await Promise.all(batch.map(async (handle) => {
      try {
        const res = await axios.get(
          `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`,
          { timeout: 20000 }
        );
        const subs = res.data.result || [];
        const solved = new Set();
        for (const s of subs) {
          if (s.verdict === "OK" && s.problem && s.problem.contestId == contestId) {
            const subTime = s.creationTimeSeconds;
            if (subTime >= contestStart && subTime <= contestEnd) {
              const idx = s.problem.index.toUpperCase();
              if (problemSet.size === 0 || problemSet.has(idx)) {
                solved.add(idx);
              }
            }
          }
        }
        return { handle, count: solved.size };
      } catch (e) {
        console.error(`Failed to fetch submissions for ${handle}:`, e.message);
        return { handle, count: 0 };
      }
    }));
    for (const r of batchResults) {
      solvedMap[r.handle].solved = r.count;
      // rank stays null
    }
    if (i + 2 < handles.length) await sleep(1500);
  }
  return solvedMap;
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

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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

  sock.ev.on("connection.update", (update) => {
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

      setInterval(() => checkAndSendReminders(sock), 10 * 60 * 1000);
      setInterval(() => checkAndAnnounceWinner(sock), 5 * 60 * 1000);
      setTimeout(() => checkAndAnnounceWinner(sock), 2 * 60 * 1000);
      setTimeout(() => checkAndSendReminders(sock), 30 * 1000);
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
          const [cf, lc, cc] = await Promise.all([
            getCFUpcoming(),
            getLeetCodeUpcoming(),
            getCodeChefUpcoming(),
          ]);
          const all = [...cf, ...lc, ...cc].slice(0, 8);
          let text = `📅 *Upcoming Contests*\n${"─".repeat(28)}\n\n`;
          if (!all.length) {
            text += `😴 No upcoming contests right now.`;
          } else {
            all.forEach((c) => {
              const emoji = c.platform === "Codeforces" ? "🔵" :
                            c.platform === "CodeChef" ? "🟤" : "🟡";
              text += `${emoji} *${c.platform}*\n`;
              text += `  • *${c.name}*\n    🕐 ${formatIST(c.startTimeSeconds)}\n    ⏱ ${formatDuration(c.durationSeconds)}\n    🔗 ${c.url}\n\n`;
            });
          }
          await reply(text.trim());
        }

        // ── // solved ──────────────────────────────────────────────────
        else if (command === "// solved") {
          const handles = getAllHandles(groupData);
          if (!handles.length) { await reply("📭 No members registered.\nUse `// add your_cf_id` to join."); continue; }
          await reply("🔍 Detecting current/recent contest...");
          let contest = await getRunningContest();
          let isLive = !!contest;
          if (!contest) contest = await getRecentFinishedContest();
          if (!contest) { await reply("❌ No active or recent contest found on Codeforces."); continue; }
          await reply(`⏳ Fetching standings for *${contest.name}*...\n_May take 10-20 seconds_`);
          const solvedMap = await getContestStandings(contest.id, handles, contest);
          if (!solvedMap) {
            await reply(`❌ Could not fetch standings for contest ${contest.id}. Please try again later.`);
            continue;
          }
          const [{ problems }] = await Promise.all([getContestDetails(contest.id)]);
          const totalProblems = problems ? problems.length : 0;
          const problemLetters = problems ? problems.map((p) => p.index).join(" ") : "";
          const participated = Object.entries(solvedMap)
            .filter(([, data]) => data.solved > 0)
            .sort((a, b) => b[1].solved - a[1].solved);

          let text = `${isLive ? "🟢 *LIVE*" : "📊"} *${contest.name}*\n`;
          text += `📅 ${formatIST(contest.startTimeSeconds)}\n`;
          text += `⏱ Duration: ${formatDuration(contest.durationSeconds)}\n`;
          if (totalProblems) text += `📝 Problems: ${totalProblems} (${problemLetters})\n`;
          text += `${"─".repeat(28)}\n\n`;

          if (!participated.length) {
            text += `😴 No group members have participated yet.`;
          } else {
            participated.forEach(([h, data], i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
              const rankStr = data.rank ? ` | Rank #${data.rank}` : '';
              text += `${medal} *${h}* — ✅ ${data.solved}${totalProblems ? `/${totalProblems}` : ''} solved${rankStr}\n`;
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
            await reply(`❌ Contest ${contestId} does not exist or is not a regular Codeforces round (gym contests not supported).`);
            continue;
          }

          await reply(`⏳ Fetching standings for *${contestInfo.name}*...\n_May take a few seconds_`);

          const solvedMap = await getContestStandings(contestId, handles, contestInfo);
          if (!solvedMap) {
            await reply(`❌ Could not fetch standings for contest ${contestId}. Please try again later.`);
            continue;
          }

          const { problems } = await getContestDetails(contestId);
          const totalProblems = problems ? problems.length : 0;
          const problemLetters = problems ? problems.map((p) => p.index).join(" ") : "";

          const participated = Object.entries(solvedMap)
            .filter(([, data]) => data.solved > 0)
            .sort((a, b) => b[1].solved - a[1].solved);

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

          if (!participated.length) {
            text += `😴 No group members participated in this contest.`;
          } else {
            participated.forEach(([h, data], i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
              const rankStr = data.rank ? ` | Rank #${data.rank}` : '';
              text += `${medal} *${h}* — ✅ ${data.solved}${totalProblems ? `/${totalProblems}` : ''} solved${rankStr}\n`;
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
            `📅 \`// upcoming\`\n   _Next CF, LC & CC contests_\n\n` +
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
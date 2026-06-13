const express = require("express");
const mongoose = require("mongoose");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const axios = require("axios");
const pino = require("pino");

// Holds latest QR for /qr web endpoint
let latestQR = null;

// ─── MongoDB Connect ───────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Error:", err.message);
    process.exit(1);
  });

// ─── Schemas ──────────────────────────────────────────────────────────────────
const AuthState = mongoose.model(
  "AuthState",
  new mongoose.Schema({ _id: String, data: mongoose.Schema.Types.Mixed })
);

const CFData = mongoose.model(
  "CFData",
  new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    members: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastContestAnnounced: { type: Number, default: 0 },
  })
);

// ─── MongoDB Auth State ────────────────────────────────────────────────────────
async function useMongoAuthState() {
  const writeData = async (key, data) => {
    await AuthState.findByIdAndUpdate(
      key,
      { data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) },
      { upsert: true }
    );
  };
  const readData = async (key) => {
    const item = await AuthState.findById(key).lean();
    if (!item?.data) return null;
    return JSON.parse(JSON.stringify(item.data), BufferJSON.reviver);
  };
  const removeData = async (key) => {
    await AuthState.findByIdAndDelete(key);
  };
  const creds = (await readData("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value)
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              data[id] = value;
            })
          );
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

// ─── CF Data Helpers ──────────────────────────────────────────────────────────
async function getGroupData(chatId) {
  const group = await CFData.findOne({ chatId }).lean();
  if (!group) return { members: {}, lastContestAnnounced: 0 };
  return { members: group.members || {}, lastContestAnnounced: group.lastContestAnnounced || 0 };
}

async function saveGroupData(chatId, groupData) {
  await CFData.findOneAndUpdate(
    { chatId },
    { $set: { members: groupData.members, lastContestAnnounced: groupData.lastContestAnnounced } },
    { upsert: true }
  );
}

function getAllHandles(groupData) {
  const all = [];
  for (const handles of Object.values(groupData?.members || {}))
    for (const h of handles)
      if (!all.includes(h)) all.push(h);
  return all;
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

// ── CF Streak ─────────────────────────────────────────────────────────────────
async function getCFStreak(handle) {
  try {
    const res = await axios.get(`https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`, { timeout: 15000 });
    const subs = res.data.result;
    // Get unique days with at least one AC
    const acDays = new Set();
    for (const s of subs) {
      if (s.verdict === "OK") {
        const day = new Date(s.creationTimeSeconds * 1000).toISOString().slice(0, 10);
        acDays.add(day);
      }
    }
    const sortedDays = [...acDays].sort();
    if (!sortedDays.length) return { current: 0, max: 0 };

    // Calculate max streak
    let maxStreak = 1, cur = 1;
    for (let i = 1; i < sortedDays.length; i++) {
      const prev = new Date(sortedDays[i - 1]);
      const curr = new Date(sortedDays[i]);
      const diff = (curr - prev) / (1000 * 60 * 60 * 24);
      if (diff === 1) { cur++; maxStreak = Math.max(maxStreak, cur); }
      else cur = 1;
    }

    // Calculate current streak (from today backwards)
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let currentStreak = 0;
    if (acDays.has(today) || acDays.has(yesterday)) {
      let checkDay = acDays.has(today) ? new Date(today) : new Date(yesterday);
      while (true) {
        const dayStr = checkDay.toISOString().slice(0, 10);
        if (acDays.has(dayStr)) { currentStreak++; checkDay = new Date(checkDay - 86400000); }
        else break;
      }
    }
    return { current: currentStreak, max: maxStreak };
  } catch { return null; }
}

// ── CF User Info (solved count + rating distribution) ─────────────────────────
async function getCFUserInfo(handle) {
  try {
    const [userRes, subRes] = await Promise.all([
      axios.get(`https://codeforces.com/api/user.info?handles=${handle}`, { timeout: 8000 }),
      axios.get(`https://codeforces.com/api/user.status?handle=${handle}&from=1&count=10000`, { timeout: 15000 }),
    ]);
    const u = userRes.data.result[0];
    const subs = subRes.data.result;

    // Unique solved problems
    const solved = new Set();
    const ratingBuckets = {};
    for (const s of subs) {
      if (s.verdict === "OK" && s.problem) {
        const key = `${s.problem.contestId}-${s.problem.index}`;
        if (!solved.has(key)) {
          solved.add(key);
          const r = s.problem.rating;
          if (r) {
            ratingBuckets[r] = (ratingBuckets[r] || 0) + 1;
          }
        }
      }
    }

    return {
      handle: u.handle,
      rating: u.rating ?? null,
      maxRating: u.maxRating ?? null,
      rank: u.rank ?? "newbie",
      maxRank: u.maxRank ?? "newbie",
      totalSolved: solved.size,
      ratingBuckets,
    };
  } catch { return null; }
}

// ── CF Contest functions ───────────────────────────────────────────────────────
async function getCFUpcoming() {
  try {
    const res = await axios.get("https://codeforces.com/api/contest.list?gym=false", { timeout: 10000 });
    return res.data.result.filter((c) => c.phase === "BEFORE").sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).slice(0, 3);
  } catch { return []; }
}

async function getRunningContest() {
  try {
    const res = await axios.get("https://codeforces.com/api/contest.list?gym=false", { timeout: 10000 });
    const running = res.data.result.filter((c) => c.phase === "CODING");
    return running.length ? running[0] : null;
  } catch { return null; }
}

async function getRecentFinishedContests(limit = 10) {
  try {
    const res = await axios.get("https://codeforces.com/api/contest.list?gym=false", { timeout: 10000 });
    return res.data.result.filter((c) => c.phase === "FINISHED").slice(0, limit);
  } catch { return []; }
}

// ── FIXED: Contest standings with better handle matching ──────────────────────
async function getContestStandings(contestId, handles) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}&showUnofficial=true`,
      { timeout: 20000 }
    );
    const rows = res.data.result.rows;
    const handleLower = handles.map((h) => h.toLowerCase());
    const solvedMap = {};

    for (const row of rows) {
      const members = row.party.members.map((m) => m.handle.toLowerCase());
      const acceptedCount = row.problemResults.filter(
        (p) => p.points > 0 || (p.rejectedAttemptCount !== undefined && p.bestSubmissionTimeSeconds > 0)
      ).length;
      for (const m of members) {
        const idx = handleLower.indexOf(m);
        if (idx !== -1) {
          const origHandle = handles[idx];
          // Keep highest solved count if handle appears multiple times (official + unofficial)
          if (!solvedMap[origHandle] || acceptedCount > solvedMap[origHandle])
            solvedMap[origHandle] = acceptedCount;
        }
      }
    }
    return solvedMap;
  } catch (e) {
    console.error("getContestStandings error:", e.message);
    return null;
  }
}

async function getContestProblems(contestId) {
  try {
    const res = await axios.get(`https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`, { timeout: 10000 });
    return res.data.result.problems || [];
  } catch { return []; }
}

// ── AtCoder upcoming (via unofficial API) ────────────────────────────────────
async function getAtCoderUpcoming() {
  try {
    const res = await axios.get("https://atcoder-contests-calendar-api.vercel.app/api/contests", { timeout: 8000 });
    const now = Date.now();
    return res.data
      .filter((c) => new Date(c.start_time).getTime() > now)
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      .slice(0, 2);
  } catch { return []; }
}

// ── CodeChef upcoming (via CLIST API or scrape fallback) ──────────────────────
async function getCodeChefUpcoming() {
  try {
    const res = await axios.get(
      "https://clist.by/api/v4/contest/?resource=codechef.com&upcoming=true&order_by=start&limit=2",
      { timeout: 8000, headers: { Authorization: `ApiKey ${process.env.CLIST_API_KEY || ""}` } }
    );
    return (res.data.objects || []).slice(0, 2);
  } catch { return []; }
}

// ── LeetCode upcoming ─────────────────────────────────────────────────────────
async function getLeetCodeUpcoming() {
  try {
    const res = await axios.post(
      "https://leetcode.com/graphql",
      {
        query: `{ allContests { title startTime duration } }`,
      },
      { timeout: 8000, headers: { "Content-Type": "application/json" } }
    );
    const now = Math.floor(Date.now() / 1000);
    return (res.data.data.allContests || [])
      .filter((c) => c.startTime > now)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, 2);
  } catch { return []; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rankEmoji(rank) {
  if (!rank) return "⚪";
  const r = rank.toLowerCase();
  if (r.includes("legendary")) return "👑";
  if (r.includes("international") && r.includes("grandmaster")) return "🔴";
  if (r.includes("grandmaster")) return "🔴";
  if (r.includes("international") && r.includes("master")) return "🟠";
  if (r.includes("master")) return "🟠";
  if (r.includes("candidate")) return "🟡";
  if (r.includes("expert")) return "🔵";
  if (r.includes("specialist")) return "🟣";
  if (r.includes("pupil")) return "🟢";
  return "⚪";
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatStartTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) + " IST";
}

function formatDateStr(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) + " IST";
}

// ─── Winner Checker ───────────────────────────────────────────────────────────
async function checkAndAnnounceWinner(sock) {
  const groups = await CFData.find({}).lean();
  for (const group of groups) {
    const chatId = group.chatId;
    if (!chatId.endsWith("@g.us")) continue;
    const groupData = { members: group.members || {}, lastContestAnnounced: group.lastContestAnnounced || 0 };
    const handles = getAllHandles(groupData);
    if (!handles.length) continue;
    try {
      const finished = await getRecentFinishedContests(5);
      if (!finished.length) continue;
      const lastContest = finished[0];
      const lastId = lastContest.id;
      if (groupData.lastContestAnnounced === lastId) continue;
      const finishedAt = lastContest.startTimeSeconds + lastContest.durationSeconds;
      const now = Math.floor(Date.now() / 1000);
      if (now - finishedAt > 7200) {
        await saveGroupData(chatId, { ...groupData, lastContestAnnounced: lastId });
        continue;
      }
      const solvedMap = await getContestStandings(lastId, handles);
      if (!solvedMap) continue;
      const entries = Object.entries(solvedMap).filter(([, s]) => s > 0);
      if (!entries.length) continue;
      entries.sort((a, b) => b[1] - a[1]);
      const [winner, winnerSolved] = entries[0];
      let text = `🏁 *Contest Over!*\n📋 *${lastContest.name}*\n${"─".repeat(28)}\n\n`;
      text += `🏆 *Group Winner: ${winner}* with *${winnerSolved}* solved!\n\n📊 *Group Performance:*\n`;
      entries.forEach(([h, s], i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
        text += `${medal} *${h}* — ${s} solved\n`;
      });
      const notParticipated = handles.filter((h) => !solvedMap[h]);
      if (notParticipated.length) text += `\n😴 Didn't participate: ${notParticipated.join(", ")}`;
      await sock.sendMessage(chatId, { text });
      await saveGroupData(chatId, { ...groupData, lastContestAnnounced: lastId });
    } catch (e) {
      console.error(`Winner check error for ${chatId}:`, e.message);
    }
  }
}

// ─── Express Server ───────────────────────────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("✅ CF WhatsApp Bot is running!"));
app.get("/ping", (req, res) => res.send("🏓 Pong!"));
app.get("/qr", async (req, res) => {
  if (!latestQR) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Bot is already connected!</h2><p>No QR needed. Bot is live.</p></body></html>`);
  }
  try {
    const qrImageUrl = await QRCode.toDataURL(latestQR);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff"><h2>📱 Scan with WhatsApp</h2><p style="color:#aaa">Open WhatsApp → Linked Devices → Link a Device</p><img src="${qrImageUrl}" style="width:280px;height:280px;border:8px solid #fff;border-radius:12px"/><p style="color:#aaa;font-size:13px">Auto-refreshes every 20s</p><script>setTimeout(()=>location.reload(),20000)</script></body></html>`);
  } catch (e) { res.status(500).send("QR Error: " + e.message); }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Express server on port ${PORT}`));

// ─── Main Bot ─────────────────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMongoAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      console.log("\n📱 QR ready! Open your Render URL + /qr to scan.\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("❌ Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
      else console.log("Logged out. Delete AuthState from MongoDB and restart.");
    }
    if (connection === "open") {
      latestQR = null;
      console.log("\n✅ CF WhatsApp Bot is ready!");
      setInterval(() => checkAndAnnounceWinner(sock), 5 * 60 * 1000);
      setTimeout(() => checkAndAnnounceWinner(sock), 2 * 60 * 1000);
    }
  });

  // ─── Message Handler ──────────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

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

        // ── // add ────────────────────────────────────────────────────────────
        if (command.startsWith("// add ")) {
          const handle = body.slice(7).trim().split(/\s+/)[0];
          if (!handle) { await reply("❌ Usage: `// add <cf_handle>`\nExample: `// add tourist`"); continue; }
          await reply(`🔍 Verifying *${handle}*...`);
          const userInfo = await getCFUser(handle);
          if (!userInfo) { await reply(`❌ *${handle}* not found on Codeforces. Check spelling.`); continue; }
          if (!groupData.members[senderId]) groupData.members[senderId] = [];
          if (groupData.members[senderId].includes(userInfo.handle)) { await reply(`ℹ️ *${userInfo.handle}* is already registered by you.`); continue; }
          groupData.members[senderId].push(userInfo.handle);
          await saveGroupData(chatId, groupData);
          await reply(
            `✅ *${userInfo.handle}* registered!\n\n` +
            `${rankEmoji(userInfo.rank)} Rating: *${userInfo.rating ?? "Unrated"}* | Rank: ${userInfo.rank}`
          );
        }

        // ── // remove ─────────────────────────────────────────────────────────
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

        // ── // rating ─────────────────────────────────────────────────────────
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

        // ── // myrating ───────────────────────────────────────────────────────
        else if (command === "// myrating") {
          const myHandles = groupData.members[senderId] || [];
          if (!myHandles.length) { await reply("❌ Not registered!\nUse `// add your_cf_id` first."); continue; }
          const users = await getCFUsers(myHandles);
          if (!users.length) { await reply("❌ Failed to fetch. Try again."); continue; }
          let text = `👤 *Your CF Profiles:*\n\n`;
          for (const u of users) {
            text += `${rankEmoji(u.rank)} *${u.handle}*\n`;
            text += `   📊 Rating: *${u.rating ?? "Unrated"}*\n`;
            text += `   🏅 Rank: ${u.rank}\n`;
            text += `   🚀 Max: ${u.maxRating ?? "N/A"} (${u.maxRank})\n\n`;
          }
          await reply(text.trim());
        }

        // ── // upcoming ───────────────────────────────────────────────────────
        else if (command === "// upcoming") {
          await reply("⏳ Fetching upcoming contests from all platforms...");
          const [cfContests, lcContests] = await Promise.all([
            getCFUpcoming(),
            getLeetCodeUpcoming(),
          ]);

          let text = `📅 *Upcoming Contests*\n${"─".repeat(28)}\n\n`;

          if (cfContests.length) {
            text += `🔵 *Codeforces*\n`;
            cfContests.forEach((c) => {
              text += `  • *${c.name}*\n`;
              text += `    🕐 ${formatStartTime(c.startTimeSeconds)}\n`;
              text += `    ⏱ ${formatDuration(c.durationSeconds)}\n\n`;
            });
          }

          if (lcContests.length) {
            text += `🟡 *LeetCode*\n`;
            lcContests.forEach((c) => {
              text += `  • *${c.title}*\n`;
              text += `    🕐 ${formatStartTime(c.startTime)}\n`;
              text += `    ⏱ ${formatDuration(c.duration)}\n\n`;
            });
          }

          if (!cfContests.length && !lcContests.length) {
            text += `😴 No upcoming contests found right now.`;
          }

          text += `_Note: AtCoder & CodeChef times are on their official sites_`;
          await reply(text.trim());
        }

        // ── // solved ─────────────────────────────────────────────────────────
        else if (command.startsWith("// solved")) {
          const handles = getAllHandles(groupData);
          if (!handles.length) { await reply("📭 No members registered.\nUse `// add your_cf_id` to join."); continue; }

          const arg = body.slice(9).trim();
          let contestId = null;
          let contestName = "";

          if (arg) {
            contestId = parseInt(arg);
            if (isNaN(contestId)) { await reply("❌ Invalid contest ID. Use a number like: `// solved 2060`"); continue; }
            contestName = `Contest #${contestId}`;
          } else {
            await reply("🔍 Looking for active/recent contest...");
            const running = await getRunningContest();
            if (running) {
              contestId = running.id;
              contestName = running.name;
            } else {
              const finished = await getRecentFinishedContests(3);
              if (finished.length) { contestId = finished[0].id; contestName = finished[0].name; }
            }
            if (!contestId) { await reply("❌ No active or recent contest found.\nTry: `// solved <contest_id>`"); continue; }
          }

          await reply(`⏳ Fetching standings for *${contestName}*...\n_This may take 10-20 seconds_`);
          const [problems, solvedMap] = await Promise.all([
            getContestProblems(contestId),
            getContestStandings(contestId, handles),
          ]);

          if (!solvedMap) { await reply("❌ Failed to fetch standings. Contest may be too old or CF API is down."); continue; }

          const totalProblems = problems.length;
          const participated = Object.entries(solvedMap).filter(([, s]) => s > 0);
          participated.sort((a, b) => b[1] - a[1]);

          let text = `📊 *${contestName}*\n`;
          if (totalProblems) text += `📝 Total Problems: ${totalProblems}\n`;
          text += `${"─".repeat(28)}\n\n`;

          if (!participated.length) {
            text += `😴 No group members participated yet.`;
          } else {
            participated.forEach(([h, s], i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
              const bar = "█".repeat(s) + "░".repeat(Math.max(0, totalProblems - s));
              text += `${medal} *${h}*\n   ✅ ${s}${totalProblems ? `/${totalProblems}` : ""} ${totalProblems ? bar : ""}\n\n`;
            });
            const notSolved = handles.filter((h) => !solvedMap[h] || solvedMap[h] === 0);
            if (notSolved.length) text += `😴 Not participated: ${notSolved.join(", ")}`;
          }
          await reply(text.trim());
        }

        // ── // streak ─────────────────────────────────────────────────────────
        else if (command === "// streak") {
          const handles = getAllHandles(groupData);
          if (!handles.length) { await reply("📭 No members registered.\nUse `// add your_cf_id` to join."); continue; }
          await reply(`⏳ Fetching streaks for ${handles.length} member(s)... _May take a while_`);

          const results = await Promise.all(handles.map(async (h) => {
            const streak = await getCFStreak(h);
            return { handle: h, streak };
          }));

          results.sort((a, b) => (b.streak?.max ?? 0) - (a.streak?.max ?? 0));

          let text = `🔥 *CF Streaks*\n${"─".repeat(28)}\n\n`;
          results.forEach((r, i) => {
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
            if (!r.streak) {
              text += `${medal} *${r.handle}* — ❌ fetch failed\n`;
            } else {
              text += `${medal} *${r.handle}*\n`;
              text += `   🔥 Current streak: *${r.streak.current}* days\n`;
              text += `   🏆 Max streak: *${r.streak.max}* days\n\n`;
            }
          });
          await reply(text.trim());
        }


        // ── // info <handle> ──────────────────────────────────────────────────
        else if (command.startsWith("// info")) {
          const arg = body.slice(7).trim();
          if (!arg) { await reply("❌ Usage: `// info <cf_handle>`\nExample: `// info tourist`"); continue; }
          await reply(`⏳ Fetching info for *${arg}*... _May take 10-15 seconds_`);
          const info = await getCFUserInfo(arg);
          if (!info) { await reply(`❌ Could not fetch *${arg}*. Check if handle is correct.`); continue; }

          // Build rating distribution
          const buckets = info.ratingBuckets;
          const ranges = [
            [800, 1000], [1000, 1200], [1200, 1400], [1400, 1600],
            [1600, 1800], [1800, 2000], [2000, 2200], [2200, 2400],
            [2400, 2600], [2600, 3500],
          ];

          let text = `👤 *${info.handle}*\n${"─".repeat(28)}\n\n`;
          text += `${rankEmoji(info.rank)} Rank: *${info.rank}*\n`;
          text += `📊 Rating: *${info.rating ?? "Unrated"}*\n`;
          text += `🚀 Max Rating: *${info.maxRating ?? "N/A"}* (${info.maxRank})\n`;
          text += `✅ Total Solved: *${info.totalSolved}* problems\n\n`;
          text += `📈 *Problems by Rating:*\n`;

          for (const [lo, hi] of ranges) {
            const count = Object.entries(buckets)
              .filter(([r]) => parseInt(r) >= lo && parseInt(r) < hi)
              .reduce((sum, [, c]) => sum + c, 0);
            if (count > 0) {
              const bar = "█".repeat(Math.min(count, 15));
              text += `  ${lo}-${hi === 3500 ? "2600+" : hi}: ${bar} *${count}*\n`;
            }
          }

          await reply(text.trim());
        }

        // ── // help ───────────────────────────────────────────────────────────
        else if (command === "// help") {
          await reply(
            `🤖 *CF Group Bot — Commands*\n\n` +
            `➕ \`// add <cf_id>\`\n    Register your CF username\n    Example: \`// add tourist\`\n\n` +
            `❌ \`// remove\`\n    Remove all your handles\n\n` +
            `❌ \`// remove <cf_id>\`\n    Remove one specific handle\n\n` +
            `🏆 \`// rating\`\n    Group leaderboard sorted by rating\n\n` +
            `👤 \`// myrating\`\n    Your own CF rating & rank\n\n` +
            `📅 \`// upcoming\`\n    Upcoming CF + LeetCode contests (IST)\n\n` +
            `📊 \`// solved\`\n    Who solved what in current/recent contest\n\n` +
            `📊 \`// solved <contest_id>\`\n    Solved stats for a specific contest\n    Example: \`// solved 2060\`\n\n` +
            `🔥 \`// streak\`\n    Current & max streak of all group members\n\n` +
            `👤 \`// info <cf_id>\`\n    Full profile: rating, total solved & rating-wise breakdown\n    Example: \`// info tourist\`\n\n` +
            `❓ \`// help\`\n    Show this command list\n\n` +
            `🏁 *Auto-announces group winner after every contest!*`
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

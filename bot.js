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
  if (!group) return { members: {}, lastContestAnnounced: 0 };
  return { members: group.members || {}, lastContestAnnounced: group.lastContestAnnounced || 0 };
}

async function saveGroupData(chatId, groupData) {
  await CFData.findOneAndUpdate({ chatId },
    { $set: { members: groupData.members, lastContestAnnounced: groupData.lastContestAnnounced } },
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

// ─── Streak (brute force 10000 submissions — accurate) ───────────────────────
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
        acDays.add(new Date(s.creationTimeSeconds * 1000).toISOString().slice(0, 10));
    }
    const sortedAsc = [...acDays].sort();

    // Max streak
    let maxS = sortedAsc.length ? 1 : 0, curS = 1;
    for (let i = 1; i < sortedAsc.length; i++) {
      const diff = (new Date(sortedAsc[i]) - new Date(sortedAsc[i - 1])) / 86400000;
      if (diff === 1) { curS++; maxS = Math.max(maxS, curS); }
      else curS = 1;
    }

    // Current streak (count backwards from today)
    let current = 0;
    let checkDate = new Date();
    checkDate.setUTCHours(0, 0, 0, 0);
    for (let i = 0; i < 1000; i++) {
      const d = checkDate.toISOString().slice(0, 10);
      if (acDays.has(d)) { current++; checkDate = new Date(checkDate - 86400000); }
      else if (i === 0) { checkDate = new Date(checkDate - 86400000); }
      else break;
    }

    return { current, max: maxS };
  } catch (e) {
    console.error("getCFStreak error:", e.message);
    return null;
  }
}

// ─── CF User Info (scrapes profile page — fast, accurate) ─────────────────────
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

    // Extract total solved from profile page
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

    // Fallback: look for number near "solved" text
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
      ratingBuckets: {}, // removed brute force — no bucket breakdown
      contests,
    };
  } catch { return null; }
}

// ─── Contest Helpers ──────────────────────────────────────────────────────────
async function getCFContestList() {
  const res = await axios.get("https://codeforces.com/api/contest.list?gym=false", { timeout: 10000 });
  return res.data.result;
}

async function getCFUpcoming() {
  try {
    const list = await getCFContestList();
    return list.filter((c) => c.phase === "BEFORE").sort((a, b) => a.startTimeSeconds - b.startTimeSeconds).slice(0, 3);
  } catch { return []; }
}

async function getRunningContest() {
  try {
    const list = await getCFContestList();
    const running = list.filter((c) => c.phase === "CODING");
    return running.length ? running[0] : null;
  } catch { return null; }
}

async function getRecentFinishedContest() {
  try {
    const list = await getCFContestList();
    const finished = list.filter((c) => c.phase === "FINISHED");
    return finished.length ? finished[0] : null;
  } catch { return null; }
}

async function getContestDetails(contestId) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`,
      { timeout: 12000 }
    );
    return {
      problems: res.data.result.problems || [],
      contest: res.data.result.contest,
    };
  } catch { return { problems: [], contest: null }; }
}

async function getContestStandings(contestId, handles) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}&showUnofficial=true`,
      { timeout: 25000 }
    );
    const rows = res.data.result.rows;
    const handleLower = handles.map((h) => h.toLowerCase());
    const solvedMap = {};

    for (const row of rows) {
      const members = row.party.members.map((m) => m.handle.toLowerCase());
      // bestSubmissionTimeSeconds > 0 is the most reliable "solved" indicator
      const acceptedCount = row.problemResults.filter(
        (p) => p.bestSubmissionTimeSeconds !== undefined && p.bestSubmissionTimeSeconds > 0
      ).length;
      for (const m of members) {
        const idx = handleLower.indexOf(m);
        if (idx !== -1) {
          const orig = handles[idx];
          if (!solvedMap[orig] || acceptedCount > solvedMap[orig])
            solvedMap[orig] = acceptedCount;
        }
      }
    }
    return solvedMap;
  } catch (e) {
    console.error("standings error:", e.message);
    return null;
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
      .slice(0, 2);
  } catch { return []; }
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
      const lastContest = await getRecentFinishedContest();
      if (!lastContest) continue;
      const lastId = lastContest.id;
      if (groupData.lastContestAnnounced === lastId) continue;
      const finishedAt = lastContest.startTimeSeconds + lastContest.durationSeconds;
      const now = Math.floor(Date.now() / 1000);
      if (now - finishedAt > 7200) { await saveGroupData(chatId, { ...groupData, lastContestAnnounced: lastId }); continue; }
      const solvedMap = await getContestStandings(lastId, handles);
      if (!solvedMap) continue;
      const entries = Object.entries(solvedMap).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
      if (!entries.length) continue;
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
    } catch (e) { console.error(`Winner check error ${chatId}:`, e.message); }
  }
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

function streakFire(days) {
  if (days >= 30) return "🔥🔥🔥🔥";
  if (days >= 15) return "🔥🔥🔥";
  if (days >= 8)  return "🔥🔥";
  if (days >= 1)  return "🔥";
  return "💤";
}

function solvedEmoji(count) {
  if (count >= 101) return "🚀";
  if (count >= 61)  return "💫";
  if (count >= 31)  return "🔥";
  if (count >= 11)  return "⭐";
  return "🌱";
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

        // ── // add h1 h2 h3 ───────────────────────────────────────────────────
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
          for (const u of users)
            text += `${rankEmoji(u.rank)} *${u.handle}*\n   📊 Rating: *${u.rating ?? "Unrated"}*\n   🏅 Rank: ${u.rank}\n   🚀 Max: ${u.maxRating ?? "N/A"} (${u.maxRank})\n\n`;
          await reply(text.trim());
        }

        // ── // upcoming ───────────────────────────────────────────────────────
        else if (command === "// upcoming") {
          await reply("⏳ Fetching upcoming contests...");
          const [cfContests, lcContests] = await Promise.all([getCFUpcoming(), getLeetCodeUpcoming()]);
          let text = `📅 *Upcoming Contests*\n${"─".repeat(28)}\n\n`;
          if (cfContests.length) {
            text += `🔵 *Codeforces*\n`;
            cfContests.forEach((c) => {
              text += `  • *${c.name}*\n    🕐 ${formatIST(c.startTimeSeconds)}\n    ⏱ ${formatDuration(c.durationSeconds)}\n\n`;
            });
          }
          if (lcContests.length) {
            text += `🟡 *LeetCode*\n`;
            lcContests.forEach((c) => {
              text += `  • *${c.title}*\n    🕐 ${formatIST(c.startTime)}\n    ⏱ ${formatDuration(c.duration)}\n\n`;
            });
          }
          if (!cfContests.length && !lcContests.length) text += `😴 No upcoming contests right now.`;
          await reply(text.trim());
        }

        // ── // solved (auto-detect only) ──────────────────────────────────────
        else if (command === "// solved") {
          const handles = getAllHandles(groupData);
          if (!handles.length) { await reply("📭 No members registered.\nUse `// add your_cf_id` to join."); continue; }

          await reply("🔍 Detecting current/recent contest...");

          // Try running contest first, then most recent finished
          let contest = await getRunningContest();
          let isLive = !!contest;
          if (!contest) contest = await getRecentFinishedContest();
          if (!contest) { await reply("❌ No active or recent contest found on Codeforces."); continue; }

          await reply(`⏳ Fetching standings for *${contest.name}*...\n_May take 10-20 seconds_`);

          const [{ problems }, solvedMap] = await Promise.all([
            getContestDetails(contest.id),
            getContestStandings(contest.id, handles),
          ]);

          if (!solvedMap) { await reply("❌ Failed to fetch standings. CF API may be down. Try again."); continue; }

          const totalProblems = problems.length;
          const problemLetters = problems.map((p) => p.index).join(" ");
          const participated = Object.entries(solvedMap).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
          const notParticipated = handles.filter((h) => !solvedMap[h] || solvedMap[h] === 0);

          let text = `${isLive ? "🟢 *LIVE*" : "📊"} *${contest.name}*\n`;
          text += `📅 ${formatIST(contest.startTimeSeconds)}\n`;
          text += `⏱ Duration: ${formatDuration(contest.durationSeconds)}\n`;
          if (totalProblems) text += `📝 Problems: ${totalProblems} (${problemLetters})\n`;
          text += `${"─".repeat(28)}\n\n`;

          if (!participated.length) {
            text += `😴 No group members have participated yet.`;
          } else {
            participated.forEach(([h, s], i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
              text += `${medal} *${h}* — ✅ ${s}${totalProblems ? `/${totalProblems}` : ""} solved\n`;
            });
            if (notParticipated.length) text += `\n😴 Not participated: ${notParticipated.join(", ")}`;
          }
          await reply(text.trim());
        }

        // ── // streak <cf_id> ─────────────────────────────────────────────────
        else if (command.startsWith("// streak")) {
          const arg = body.slice(9).trim();
          if (!arg) { await reply("❌ Usage: `// streak <cf_handle>`\nExample: `// streak tourist`"); continue; }
          await reply(`⏳ Fetching streak for *${arg}*... _May take 10-15 seconds_`);
          const streak = await getCFStreak(arg);
          if (!streak) { await reply(`❌ Could not fetch *${arg}*. Check handle and try again.`); continue; }

          let text = `🔥 *Streak Report: ${streak.handle || arg}*\n${"─".repeat(28)}\n\n`;
          text += `📅 Current Streak: *${streak.current} days* ${streakFire(streak.current)}\n`;
          text += `🏆 Max Streak Ever: *${streak.max} days*\n\n`;
          text += `🔥 Scale:\n`;
          text += `   1-7 days → 🔥\n`;
          text += `   8-14 days → 🔥🔥\n`;
          text += `   15-30 days → 🔥🔥🔥\n`;
          text += `   30+ days → 🔥🔥🔥🔥`;

          if (streak.current === 0)
            text += `\n\n💪 No active streak. Start solving to build one!`;

          await reply(text);
        }

        // ── // info <cf_id> ───────────────────────────────────────────────────
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

          if (qData) {
            const b = qData.buckets;
            const maxCount = Math.max(...Object.values(b), 1);
            const bar = (n) => "█".repeat(Math.round((n / maxCount) * 12)) + "░".repeat(12 - Math.round((n / maxCount) * 12));
            text += `✅ Total Solved: *${qData.total}*\n\n`;
            text += `📈 *By Rating:*\n`;
            text += `  🟢 800–1199  : ${bar(b["800-1199"])} *${b["800-1199"]}*\n`;
            text += `  🔵 1200–1599 : ${bar(b["1200-1599"])} *${b["1200-1599"]}*\n`;
            text += `  🟡 1600–1999 : ${bar(b["1600-1999"])} *${b["1600-1999"]}*\n`;
            text += `  🔴 2000+     : ${bar(b["2000+"])} *${b["2000+"]}*\n`;
          }

          await reply(text.trim());
        }

        // ── // help ───────────────────────────────────────────────────────────
        else if (command === "// help") {
          await reply(
            `🤖 *CF Group Bot — Commands*\n\n` +
            `➕ \`// add <cf_id>\`\n    Register your CF handle\n\n` +
            `➕ \`// add h1 h2 h3\`\n    Add multiple handles at once\n\n` +
            `❌ \`// remove\`\n    Remove all your handles\n\n` +
            `❌ \`// remove <cf_id>\`\n    Remove one specific handle\n\n` +
            `🏆 \`// rating\`\n    Group leaderboard by rating\n\n` +
            `👤 \`// myrating\`\n    Your own CF rating & rank\n\n` +
            `📅 \`// upcoming\`\n    Upcoming CF + LeetCode contests\n\n` +
            `📊 \`// solved\`\n    Who solved what in latest contest\n\n` +
            `🔥 \`// streak <cf_id>\`\n    Current & max streak for any CF user\n    Example: \`// streak tourist\`\n\n` +
            `👤 \`// info <cf_id>\`\n    Profile + total solved + rating breakdown\n    Example: \`// info tourist\`\n\n` +
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

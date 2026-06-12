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

// Holds the latest QR string so the web endpoint can serve it
let latestQR = null;
const pino = require("pino");

// ─── MongoDB Connect ───────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Error:", err.message);
    process.exit(1);
  });

// ─── Schemas ──────────────────────────────────────────────────────────────────

// Stores Baileys WhatsApp session (replaces auth_info folder)
const AuthState = mongoose.model(
  "AuthState",
  new mongoose.Schema({ _id: String, data: mongoose.Schema.Types.Mixed })
);

// Stores group member CF handles and contest tracking
const CFData = mongoose.model(
  "CFData",
  new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    members: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastContestAnnounced: { type: Number, default: 0 },
  })
);

// ─── MongoDB Auth State (replaces useMultiFileAuthState) ─────────────────────
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
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}

// ─── CF Data Helpers (MongoDB instead of JSON file) ───────────────────────────
async function getGroupData(chatId) {
  const group = await CFData.findOne({ chatId }).lean();
  if (!group) return { members: {}, lastContestAnnounced: 0 };
  return {
    members: group.members || {},
    lastContestAnnounced: group.lastContestAnnounced || 0,
  };
}

async function saveGroupData(chatId, groupData) {
  await CFData.findOneAndUpdate(
    { chatId },
    {
      $set: {
        members: groupData.members,
        lastContestAnnounced: groupData.lastContestAnnounced,
      },
    },
    { upsert: true }
  );
}

function getAllHandles(groupData) {
  const members = groupData?.members || {};
  const all = [];
  for (const handles of Object.values(members)) {
    for (const h of handles) {
      if (!all.includes(h)) all.push(h);
    }
  }
  return all;
}

// ─── Codeforces API ───────────────────────────────────────────────────────────
async function getCFUser(handle) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/user.info?handles=${handle}`,
      { timeout: 8000 }
    );
    const u = res.data.result[0];
    return {
      handle: u.handle,
      rating: u.rating ?? null,
      maxRating: u.maxRating ?? null,
      rank: u.rank ?? "newbie",
      maxRank: u.maxRank ?? "newbie",
    };
  } catch {
    return null;
  }
}

async function getCFUsers(handles) {
  if (!handles.length) return [];
  try {
    const res = await axios.get(
      `https://codeforces.com/api/user.info?handles=${handles.join(";")}`,
      { timeout: 10000 }
    );
    return res.data.result.map((u) => ({
      handle: u.handle,
      rating: u.rating ?? null,
      maxRating: u.maxRating ?? null,
      rank: u.rank ?? "newbie",
      maxRank: u.maxRank ?? "newbie",
    }));
  } catch {
    return [];
  }
}

async function getUpcomingContests() {
  try {
    const res = await axios.get(
      "https://codeforces.com/api/contest.list?gym=false",
      { timeout: 10000 }
    );
    return res.data.result
      .filter((c) => c.phase === "BEFORE")
      .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
      .slice(0, 5);
  } catch {
    return [];
  }
}

async function getRunningContest() {
  try {
    const res = await axios.get(
      "https://codeforces.com/api/contest.list?gym=false",
      { timeout: 10000 }
    );
    const running = res.data.result.filter((c) => c.phase === "CODING");
    return running.length ? running[0] : null;
  } catch {
    return null;
  }
}

async function getRecentFinishedContests(limit = 10) {
  try {
    const res = await axios.get(
      "https://codeforces.com/api/contest.list?gym=false",
      { timeout: 10000 }
    );
    return res.data.result
      .filter((c) => c.phase === "FINISHED")
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function getContestStandings(contestId, handles) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}&showUnofficial=true`,
      { timeout: 15000 }
    );
    const rows = res.data.result.rows;
    const solvedMap = {};
    for (const row of rows) {
      const members = row.party.members.map((m) => m.handle.toLowerCase());
      const acceptedCount = row.problemResults.filter(
        (p) =>
          p.points > 0 ||
          (p.bestSubmissionTimeSeconds !== undefined &&
            p.bestSubmissionTimeSeconds > 0)
      ).length;
      for (const m of members) {
        for (const h of handles) {
          if (h.toLowerCase() === m) solvedMap[h] = acceptedCount;
        }
      }
    }
    return solvedMap;
  } catch {
    return null;
  }
}

async function getContestProblems(contestId) {
  try {
    const res = await axios.get(
      `https://codeforces.com/api/contest.standings?contestId=${contestId}&from=1&count=1`,
      { timeout: 10000 }
    );
    return res.data.result.problems || [];
  } catch {
    return [];
  }
}

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
  return (
    d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + " IST"
  );
}

// ─── Winner Checker ───────────────────────────────────────────────────────────
async function checkAndAnnounceWinner(sock) {
  const groups = await CFData.find({}).lean();
  for (const group of groups) {
    const chatId = group.chatId;
    if (!chatId.endsWith("@g.us")) continue;
    const groupData = {
      members: group.members || {},
      lastContestAnnounced: group.lastContestAnnounced || 0,
    };
    const handles = getAllHandles(groupData);
    if (!handles.length) continue;

    try {
      const finished = await getRecentFinishedContests(5);
      if (!finished.length) continue;
      const lastContest = finished[0];
      const lastId = lastContest.id;
      if (groupData.lastContestAnnounced === lastId) continue;

      const finishedAt =
        lastContest.startTimeSeconds + lastContest.durationSeconds;
      const now = Math.floor(Date.now() / 1000);
      if (now - finishedAt > 7200) {
        await saveGroupData(chatId, {
          ...groupData,
          lastContestAnnounced: lastId,
        });
        continue;
      }

      const solvedMap = await getContestStandings(lastId, handles);
      if (!solvedMap) continue;

      const entries = Object.entries(solvedMap).filter(([, s]) => s > 0);
      if (!entries.length) continue;
      entries.sort((a, b) => b[1] - a[1]);
      const [winner, winnerSolved] = entries[0];

      let text = `🏁 *Contest Over!*\n`;
      text += `📋 *${lastContest.name}*\n`;
      text += `${"─".repeat(28)}\n\n`;
      text += `🏆 *Group Winner: ${winner}* with *${winnerSolved}* solved!\n\n`;
      text += `📊 *Group Performance:*\n`;
      entries.forEach(([h, s], i) => {
        const medal =
          i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
        text += `${medal} *${h}* — ${s} solved\n`;
      });

      const notParticipated = handles.filter((h) => !solvedMap[h]);
      if (notParticipated.length) {
        text += `\n😴 Didn't participate: ${notParticipated.join(", ")}`;
      }

      await sock.sendMessage(chatId, { text });
      await saveGroupData(chatId, {
        ...groupData,
        lastContestAnnounced: lastId,
      });
    } catch (e) {
      console.error(`Winner check error for ${chatId}:`, e.message);
    }
  }
}

// ─── Express Server ───────────────────────────────────────────────────────────
const app = express();

app.get("/", (req, res) => res.send("✅ CF WhatsApp Bot is running!"));
app.get("/ping", (req, res) => res.send("🏓 Pong!"));

// Visit /qr in your browser to scan the WhatsApp QR code
app.get("/qr", async (req, res) => {
  if (!latestQR) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ Bot is already connected!</h2>
        <p>No QR code needed. The bot is live.</p>
        <p><a href="/">Back to status</a></p>
      </body></html>
    `);
  }
  try {
    const qrImageUrl = await QRCode.toDataURL(latestQR);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h2>📱 Scan with WhatsApp</h2>
        <p style="color:#aaa">Open WhatsApp → Linked Devices → Link a Device</p>
        <img src="${qrImageUrl}" style="width:280px;height:280px;border:8px solid #fff;border-radius:12px" />
        <p style="color:#aaa;font-size:13px">Page auto-refreshes every 20 seconds. QR expires in ~60s.</p>
        <script>setTimeout(() => location.reload(), 20000);</script>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send("Error generating QR: " + e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Express server on port ${PORT}`));

// ─── Main Bot ─────────────────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMongoAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr; // serve via /qr endpoint
      console.log("\n📱 QR ready! Open your Render URL + /qr to scan.\n");
      qrcode.generate(qr, { small: true }); // also print in logs as fallback
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("❌ Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log("Logged out. Delete AuthState from MongoDB and restart.");
      }
    }

    if (connection === "open") {
      latestQR = null; // clear QR — bot is connected
      console.log("\n✅ CF WhatsApp Bot is ready!");
      console.log("Commands: // add, // remove, // rating, // myrating, // upcoming, // solved, // help\n");
      setInterval(() => checkAndAnnounceWinner(sock), 5 * 60 * 1000);
      setTimeout(() => checkAndAnnounceWinner(sock), 2 * 60 * 1000);
    }
  });

  // ─── Message Handler ─────────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      const isGroup = chatId?.endsWith("@g.us");
      if (!isGroup) continue;

      const body = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ""
      ).trim();

      if (!body.startsWith("//")) continue;

      const senderId = msg.key.participant || msg.key.remoteJid;
      const command = body.toLowerCase();
      const reply = (text) =>
        sock.sendMessage(chatId, { text }, { quoted: msg });

      // Load this group's data from MongoDB
      const groupData = await getGroupData(chatId);
      if (!groupData.members) groupData.members = {};

      // ── // add ──────────────────────────────────────────────────────────────
      if (command.startsWith("// add ")) {
        const rawArgs = body.slice(7).trim();
        const mentionedJids =
          msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

        if (mentionedJids.length > 0) {
          const cfHandle = rawArgs
            .replace(/@\S+/g, "")
            .trim()
            .split(/\s+/)[0];
          if (!cfHandle) {
            await reply("❌ Usage: `// add <cf_handle> @mention`");
            continue;
          }
          await reply(`🔍 Verifying *${cfHandle}*...`);
          const userInfo = await getCFUser(cfHandle);
          if (!userInfo) {
            await reply(`❌ *${cfHandle}* not found on Codeforces.`);
            continue;
          }
          const targetId = mentionedJids[0];
          if (!groupData.members[targetId]) groupData.members[targetId] = [];
          if (groupData.members[targetId].includes(userInfo.handle)) {
            await reply(`ℹ️ *${userInfo.handle}* is already added for that member.`);
            continue;
          }
          groupData.members[targetId].push(userInfo.handle);
          await saveGroupData(chatId, groupData);
          const emoji = rankEmoji(userInfo.rank);
          await reply(
            `✅ Added *${userInfo.handle}* for the mentioned member!\n\n` +
              `${emoji} Rating: *${userInfo.rating ?? "Unrated"}* | Rank: ${userInfo.rank}`
          );
        } else {
          const handles = rawArgs.split(/\s+/).filter(Boolean);
          if (!handles.length) {
            await reply(
              "❌ Usage: `// add <cf_handle>`\nOr multiple: `// add handle1 handle2`"
            );
            continue;
          }
          await reply(`🔍 Verifying ${handles.length} handle(s)...`);
          if (!groupData.members[senderId]) groupData.members[senderId] = [];
          const results = [];
          for (const h of handles) {
            const userInfo = await getCFUser(h);
            if (!userInfo) {
              results.push(`❌ *${h}* — not found`);
              continue;
            }
            if (groupData.members[senderId].includes(userInfo.handle)) {
              results.push(`ℹ️ *${userInfo.handle}* — already added`);
              continue;
            }
            groupData.members[senderId].push(userInfo.handle);
            const emoji = rankEmoji(userInfo.rank);
            results.push(
              `✅ ${emoji} *${userInfo.handle}* — ${userInfo.rating ?? "Unrated"} (${userInfo.rank})`
            );
          }
          await saveGroupData(chatId, groupData);
          await reply(`*Registration Results:*\n\n` + results.join("\n"));
        }
      }

      // ── // remove ───────────────────────────────────────────────────────────
      else if (command.startsWith("// remove")) {
        const myHandles = groupData.members[senderId] || [];
        if (!myHandles.length) {
          await reply(
            "❌ You haven't registered any CF handles in this group."
          );
          continue;
        }
        const arg = body.slice(9).trim();
        if (!arg) {
          delete groupData.members[senderId];
          await saveGroupData(chatId, groupData);
          await reply(`✅ Removed all your handles: *${myHandles.join(", ")}*`);
        } else {
          const idx = myHandles.findIndex(
            (h) => h.toLowerCase() === arg.toLowerCase()
          );
          if (idx === -1) {
            await reply(
              `❌ *${arg}* not found.\nYour handles: ${myHandles.join(", ")}`
            );
            continue;
          }
          myHandles.splice(idx, 1);
          if (!myHandles.length) delete groupData.members[senderId];
          else groupData.members[senderId] = myHandles;
          await saveGroupData(chatId, groupData);
          await reply(`✅ Removed *${arg}* from your handles.`);
        }
      }

      // ── // rating ───────────────────────────────────────────────────────────
      else if (command === "// rating") {
        const handles = getAllHandles(groupData);
        if (!handles.length) {
          await reply(
            "📭 No one registered yet!\nUse `// add your_cf_id` to join."
          );
          continue;
        }
        await reply(`⏳ Fetching ratings for ${handles.length} member(s)...`);
        const users = await getCFUsers(handles);
        if (!users.length) {
          await reply("❌ Failed to fetch. Try again.");
          continue;
        }
        users.sort((a, b) => {
          if (a.rating === null && b.rating === null) return 0;
          if (a.rating === null) return 1;
          if (b.rating === null) return -1;
          return b.rating - a.rating;
        });
        let text = `🏆 *CF Leaderboard*\n${"─".repeat(28)}\n`;
        users.forEach((u, i) => {
          const medal =
            i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `  ${i + 1}.`;
          const emoji = rankEmoji(u.rank);
          text += `${medal} ${emoji} *${u.handle}* — ${u.rating ?? "Unrated"}\n`;
        });
        text += `${"─".repeat(28)}\n👥 Total: ${users.length} members`;
        await reply(text);
      }

      // ── // myrating ─────────────────────────────────────────────────────────
      else if (command === "// myrating") {
        const myHandles = groupData.members[senderId] || [];
        if (!myHandles.length) {
          await reply("❌ Not registered!\nUse `// add your_cf_id` first.");
          continue;
        }
        const users = await getCFUsers(myHandles);
        if (!users.length) {
          await reply("❌ Failed to fetch. Try again.");
          continue;
        }
        let text = `👤 *Your CF Profiles:*\n\n`;
        for (const u of users) {
          const emoji = rankEmoji(u.rank);
          text += `${emoji} *${u.handle}*\n`;
          text += `   📊 Rating: *${u.rating ?? "Unrated"}*\n`;
          text += `   🏅 Rank: ${u.rank}\n`;
          text += `   🚀 Max: ${u.maxRating ?? "N/A"} (${u.maxRank})\n\n`;
        }
        await reply(text.trim());
      }

      // ── // upcoming ─────────────────────────────────────────────────────────
      else if (command === "// upcoming") {
        await reply("⏳ Fetching upcoming contests...");
        const contests = await getUpcomingContests();
        if (!contests.length) {
          await reply("📭 No upcoming contests found.");
          continue;
        }
        let text = `📅 *Upcoming Codeforces Contests*\n${"─".repeat(28)}\n\n`;
        contests.forEach((c, i) => {
          text += `*${i + 1}. ${c.name}*\n`;
          text += `   🕐 Start: ${formatStartTime(c.startTimeSeconds)}\n`;
          text += `   ⏱ Duration: ${formatDuration(c.durationSeconds)}\n\n`;
        });
        await reply(text.trim());
      }

      // ── // solved ───────────────────────────────────────────────────────────
      else if (command.startsWith("// solved")) {
        const handles = getAllHandles(groupData);
        if (!handles.length) {
          await reply(
            "📭 No members registered.\nUse `// add your_cf_id` to join."
          );
          continue;
        }
        const arg = body.slice(9).trim();
        let contestId = null;
        let contestName = "";

        if (arg) {
          contestId = parseInt(arg);
          if (isNaN(contestId)) {
            await reply("❌ Invalid contest ID.");
            continue;
          }
          contestName = `Contest #${contestId}`;
        } else {
          await reply("🔍 Looking for active/recent contest...");
          const running = await getRunningContest();
          if (running) {
            contestId = running.id;
            contestName = running.name;
          } else {
            const finished = await getRecentFinishedContests(3);
            if (finished.length) {
              contestId = finished[0].id;
              contestName = finished[0].name;
            }
          }
          if (!contestId) {
            await reply("❌ No active or recent contest found.");
            continue;
          }
        }

        await reply(`⏳ Fetching standings for *${contestName}*...`);
        const problems = await getContestProblems(contestId);
        const solvedMap = await getContestStandings(contestId, handles);
        if (!solvedMap) {
          await reply("❌ Failed to fetch standings.");
          continue;
        }

        const totalProblems = problems.length;
        const participated = Object.entries(solvedMap).filter(([, s]) => s > 0);
        participated.sort((a, b) => b[1] - a[1]);

        let text = `📊 *${contestName}*\n`;
        if (totalProblems) text += `📝 Total Problems: ${totalProblems}\n`;
        text += `${"─".repeat(28)}\n\n`;

        if (!participated.length) {
          text += `😴 No group members have solved anything yet.`;
        } else {
          participated.forEach(([h, s], i) => {
            const medal =
              i === 0
                ? "🥇"
                : i === 1
                ? "🥈"
                : i === 2
                ? "🥉"
                : `  ${i + 1}.`;
            const bar =
              "█".repeat(s) +
              "░".repeat(Math.max(0, totalProblems - s));
            text += `${medal} *${h}*\n   ✅ ${s}${
              totalProblems ? `/${totalProblems}` : ""
            } solved ${totalProblems ? bar : ""}\n\n`;
          });
          const notSolved = handles.filter(
            (h) => !solvedMap[h] || solvedMap[h] === 0
          );
          if (notSolved.length)
            text += `😴 Not participated: ${notSolved.join(", ")}`;
        }
        await reply(text.trim());
      }

      // ── // help ─────────────────────────────────────────────────────────────
      else if (command === "// help") {
        await reply(
          `🤖 *CF Group Bot — Commands*\n\n` +
            `➕ \`// add <cf_id>\`\n    Register your CF username\n\n` +
            `➕ \`// add handle1 handle2\`\n    Add multiple handles for yourself\n\n` +
            `➕ \`// add <cf_id> @mention\`\n    Add handle for someone else\n\n` +
            `❌ \`// remove\`\n    Remove all your handles\n\n` +
            `❌ \`// remove <cf_id>\`\n    Remove one specific handle\n\n` +
            `🏆 \`// rating\`\n    Group leaderboard by rating\n\n` +
            `👤 \`// myrating\`\n    Your own rating & rank\n\n` +
            `📅 \`// upcoming\`\n    Next 5 CF contests with IST time\n\n` +
            `📊 \`// solved\`\n    Who solved what in current contest\n\n` +
            `📊 \`// solved <id>\`\n    Solved stats for specific contest\n\n` +
            `🏁 *Auto-announces group winner after every contest!*`
        );
      }
    }
  });
}

startBot().catch(console.error);

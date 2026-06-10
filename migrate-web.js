const express = require("express");
const { MongoClient } = require("mongodb");

const app = express();

const PORT = process.env.PORT || 10000;

const required = [
  "MIGRATE_KEY",
  "OLD_MONGO_URI",
  "NEW_MONGO_URI",
  "OLD_DB_NAME",
  "NEW_DB_NAME",
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing env: ${key}`);
    process.exit(1);
  }
}

const OLD_URI = process.env.OLD_MONGO_URI;
const NEW_URI = process.env.NEW_MONGO_URI;
const OLD_DB_NAME = process.env.OLD_DB_NAME;
const NEW_DB_NAME = process.env.NEW_DB_NAME;
const MIGRATE_KEY = process.env.MIGRATE_KEY;

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const STATUS_LOG_LIMIT = Number(process.env.STATUS_LOG_LIMIT || 120);
const TELEGRAM_LOG_LIMIT = Number(process.env.TELEGRAM_LOG_LIMIT || 25);

// Optional Telegram bot support.
// Add these env vars when you want to control migration from Telegram:
// BOT_TOKEN=123:ABC
// OWNER_ID=123456789
// or OWNER_IDS=123456789,987654321
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OWNER_IDS = String(process.env.OWNER_IDS || process.env.OWNER_ID || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

let bot = null;
let telegramReady = false;

let isRunning = false;
let lastLogs = [];
let activeTelegramChatId = null;

function splitLongText(text, maxLength = 3900) {
  const chunks = [];
  let remaining = String(text || "");

  while (remaining.length > maxLength) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendTelegram(chatId, text) {
  if (!bot || !chatId) return;

  try {
    for (const chunk of splitLongText(text)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

function shouldPushTelegramLog(message) {
  const text = String(message || "");

  return (
    text.includes("🚀") ||
    text.includes("🎉") ||
    text.includes("❌") ||
    text.includes("📚") ||
    text.includes("📦") ||
    text.includes("✅ Done") ||
    text.includes("DRY RUN") ||
    text.includes("processed")
  );
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  lastLogs.push(line);
  if (lastLogs.length > 500) lastLogs.shift();

  if (activeTelegramChatId && shouldPushTelegramLog(message)) {
    sendTelegram(activeTelegramChatId, line);
  }
}

function checkKey(req, res) {
  const key = req.query.key;
  if (!key || key !== MIGRATE_KEY) {
    res.status(403).send("❌ Forbidden: invalid key");
    return false;
  }
  return true;
}

function isOwner(msg) {
  if (!msg || !msg.from || OWNER_IDS.length === 0) return false;
  return OWNER_IDS.includes(String(msg.from.id));
}

function formatStatus(limit = STATUS_LOG_LIMIT) {
  return [
    `Status: ${isRunning ? "RUNNING" : "IDLE"}`,
    `Mode: NO_DELETE_OVERWRITE_BY_ID`,
    `Old DB: ${OLD_DB_NAME}`,
    `New DB: ${NEW_DB_NAME}`,
    "",
    "Last logs:",
    ...lastLogs.slice(-limit),
  ].join("\n");
}

async function copyIndexes(oldCol, newCol, collectionName) {
  const indexes = await oldCol.indexes();

  for (const index of indexes) {
    if (index.name === "_id_") continue;

    const { key, name, v, ns, ...indexOptions } = index;

    try {
      await newCol.createIndex(key, {
        ...indexOptions,
        name,
      });
      log(`✅ Index ready: ${collectionName}.${name}`);
    } catch (err) {
      log(`⚠️ Index skipped/failed: ${collectionName}.${name} | ${err.message}`);
    }
  }
}

async function ensureCollection(newDb, collectionInfo) {
  const name = collectionInfo.name;

  try {
    await newDb.createCollection(name, collectionInfo.options || {});
    log(`✅ Created collection if missing: ${name}`);
  } catch (err) {
    if (err.code === 48 || err.codeName === "NamespaceExists") {
      log(`ℹ️ Collection already exists: ${name}`);
    } else {
      throw err;
    }
  }
}

async function copyCollection(oldDb, newDb, collectionInfo, dryRun) {
  const name = collectionInfo.name;

  if (name.startsWith("system.")) {
    log(`⏭️ Skip system collection: ${name}`);
    return;
  }

  if (collectionInfo.type && collectionInfo.type !== "collection") {
    log(`⏭️ Skip non-normal collection: ${name} type=${collectionInfo.type}`);
    return;
  }

  const oldCol = oldDb.collection(name);
  const newCol = newDb.collection(name);

  const total = await oldCol.countDocuments({});

  log("----------------------------------------");
  log(`📦 Collection: ${name}`);
  log(`📄 OLD documents: ${total}`);

  if (dryRun) {
    log("🟡 DRY RUN: copy မလုပ်သေးပါ");
    return;
  }

  await ensureCollection(newDb, collectionInfo);

  const cursor = oldCol.find({}).batchSize(BATCH_SIZE);

  let ops = [];
  let processed = 0;

  for await (const doc of cursor) {
    ops.push({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    });

    if (ops.length >= BATCH_SIZE) {
      const result = await newCol.bulkWrite(ops, { ordered: false });
      processed += ops.length;

      log(
        `✅ ${name}: ${processed}/${total} processed | matched=${result.matchedCount} modified=${result.modifiedCount} upserted=${result.upsertedCount}`
      );

      ops = [];
    }
  }

  if (ops.length > 0) {
    const result = await newCol.bulkWrite(ops, { ordered: false });
    processed += ops.length;

    log(
      `✅ ${name}: ${processed}/${total} processed | matched=${result.matchedCount} modified=${result.modifiedCount} upserted=${result.upsertedCount}`
    );
  }

  await copyIndexes(oldCol, newCol, name);

  log(`✅ Done: ${name}`);
}

async function runMigration({ dryRun, telegramChatId = null }) {
  const oldClient = new MongoClient(OLD_URI);
  const newClient = new MongoClient(NEW_URI);

  activeTelegramChatId = telegramChatId;

  try {
    log("🚀 MongoDB migration started");
    log("MODE=NO_DELETE_OVERWRITE_BY_ID");
    log(`DRY_RUN=${dryRun}`);
    log(`OLD_DB=${OLD_DB_NAME}`);
    log(`NEW_DB=${NEW_DB_NAME}`);
    log(`BATCH_SIZE=${BATCH_SIZE}`);

    await oldClient.connect();
    await newClient.connect();

    const oldDb = oldClient.db(OLD_DB_NAME);
    const newDb = newClient.db(NEW_DB_NAME);

    const collections = await oldDb.listCollections({}, { nameOnly: false }).toArray();

    log(`📚 Found OLD collections: ${collections.length}`);
    for (const c of collections) {
      log(`- ${c.name}`);
    }

    for (const collectionInfo of collections) {
      await copyCollection(oldDb, newDb, collectionInfo, dryRun);
    }

    log("🎉 Migration finished");
    log("✅ NEW DB ထဲကရှိပြီးသား extra data တွေ မဖျက်ထားပါ");
  } catch (err) {
    log(`❌ Migration error: ${err.message}`);
    console.error(err);
  } finally {
    await oldClient.close().catch(() => {});
    await newClient.close().catch(() => {});
    isRunning = false;
    activeTelegramChatId = null;
  }
}

function startTelegramBotIfConfigured() {
  if (!BOT_TOKEN || OWNER_IDS.length === 0) {
    console.log("Telegram bot disabled. Add BOT_TOKEN and OWNER_ID/OWNER_IDS to enable it.");
    return;
  }

  let TelegramBot;
  try {
    TelegramBot = require("node-telegram-bot-api");
  } catch (err) {
    console.error("❌ node-telegram-bot-api package missing.");
    console.error("Add it to package.json: \"node-telegram-bot-api\": \"^0.66.0\"");
    return;
  }

  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  telegramReady = true;

  console.log("Telegram migration bot started");
  console.log(`Allowed owner IDs: ${OWNER_IDS.join(", ")}`);

  bot.on("polling_error", (err) => {
    console.error("Telegram polling error:", err.message);
  });

  bot.onText(/^\/start$/, async (msg) => {
    if (!isOwner(msg)) {
      return sendTelegram(msg.chat.id, "❌ You are not allowed.");
    }

    return sendTelegram(
      msg.chat.id,
      [
        "MongoDB Migration Bot",
        "",
        "Commands:",
        "/migrate_dry - data မရွှေ့ဘဲ collection/count စစ်မယ်",
        "/migrate_run YES - တကယ် copy/overwrite လုပ်မယ်",
        "/status - progress/log ကြည့်မယ်",
        "",
        "Mode:",
        "NEW DB မဖျက်ပါ။ _id တူရင် overwrite, မရှိရင် insert လုပ်ပါမယ်။",
      ].join("\n")
    );
  });

  bot.onText(/^\/help$/, async (msg) => {
    if (!isOwner(msg)) {
      return sendTelegram(msg.chat.id, "❌ You are not allowed.");
    }

    return sendTelegram(
      msg.chat.id,
      [
        "/migrate_dry",
        "/status",
        "/migrate_run YES",
      ].join("\n")
    );
  });

  bot.onText(/^\/status$/, async (msg) => {
    if (!isOwner(msg)) {
      return sendTelegram(msg.chat.id, "❌ You are not allowed.");
    }

    return sendTelegram(msg.chat.id, formatStatus(TELEGRAM_LOG_LIMIT));
  });

  bot.onText(/^\/migrate_dry$/, async (msg) => {
    if (!isOwner(msg)) {
      return sendTelegram(msg.chat.id, "❌ You are not allowed.");
    }

    if (isRunning) {
      return sendTelegram(msg.chat.id, "🟡 Migration already running. Use /status");
    }

    isRunning = true;
    lastLogs = [];
    await sendTelegram(msg.chat.id, "🟡 DRY RUN started. Use /status to check logs.");
    runMigration({ dryRun: true, telegramChatId: msg.chat.id });
  });

  bot.onText(/^\/migrate_run(?:\s+(.+))?$/, async (msg, match) => {
    if (!isOwner(msg)) {
      return sendTelegram(msg.chat.id, "❌ You are not allowed.");
    }

    const confirm = match && String(match[1] || "").trim();

    if (confirm !== "YES") {
      return sendTelegram(msg.chat.id, "⚠️ တကယ် run ချင်ရင် ဒီလိုရေးပါ:\n/migrate_run YES");
    }

    if (isRunning) {
      return sendTelegram(msg.chat.id, "🟡 Migration already running. Use /status");
    }

    isRunning = true;
    lastLogs = [];
    await sendTelegram(msg.chat.id, "🚀 Migration started. Use /status to check logs.");
    runMigration({ dryRun: false, telegramChatId: msg.chat.id });
  });
}

app.get("/", (req, res) => {
  res.send(`
    <h2>MongoDB Migration Web Service</h2>
    <p>Status: ${isRunning ? "RUNNING" : "IDLE"}</p>
    <p>Mode: NO_DELETE_OVERWRITE_BY_ID</p>
    <p>Telegram: ${telegramReady ? "ENABLED" : "DISABLED"}</p>
    <p>Use:</p>
    <pre>
/status?key=YOUR_KEY
/migrate-dry?key=YOUR_KEY
/migrate-run?key=YOUR_KEY&confirm=YES
    </pre>
  `);
});

app.get("/status", (req, res) => {
  if (!checkKey(req, res)) return;
  res.type("text/plain").send(formatStatus(STATUS_LOG_LIMIT));
});

app.get("/migrate-dry", async (req, res) => {
  if (!checkKey(req, res)) return;

  if (isRunning) {
    return res.send("🟡 Migration already running. Check /status");
  }

  isRunning = true;
  lastLogs = [];
  runMigration({ dryRun: true });

  res.send("🟡 DRY RUN started. Open /status?key=YOUR_KEY to check logs.");
});

app.get("/migrate-run", async (req, res) => {
  if (!checkKey(req, res)) return;

  if (req.query.confirm !== "YES") {
    return res.send("⚠️ တကယ် run ချင်ရင် &confirm=YES ထည့်ပါ");
  }

  if (isRunning) {
    return res.send("🟡 Migration already running. Check /status");
  }

  isRunning = true;
  lastLogs = [];
  runMigration({ dryRun: false });

  res.send("🚀 Migration started. Open /status?key=YOUR_KEY to check logs.");
});

startTelegramBotIfConfigured();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Migration web service listening on port ${PORT}`);
});

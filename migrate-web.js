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

let isRunning = false;
let lastLogs = [];

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  lastLogs.push(line);
  if (lastLogs.length > 300) lastLogs.shift();
}

function checkKey(req, res) {
  const key = req.query.key;
  if (!key || key !== MIGRATE_KEY) {
    res.status(403).send("❌ Forbidden: invalid key");
    return false;
  }
  return true;
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

async function runMigration({ dryRun }) {
  const oldClient = new MongoClient(OLD_URI);
  const newClient = new MongoClient(NEW_URI);

  try {
    log("🚀 MongoDB migration started");
    log(`MODE=NO_DELETE_OVERWRITE_BY_ID`);
    log(`DRY_RUN=${dryRun}`);
    log(`OLD_DB=${OLD_DB_NAME}`);
    log(`NEW_DB=${NEW_DB_NAME}`);

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
    await oldClient.close();
    await newClient.close();
    isRunning = false;
  }
}

app.get("/", (req, res) => {
  res.send(`
    <h2>MongoDB Migration Web Service</h2>
    <p>Status: ${isRunning ? "RUNNING" : "IDLE"}</p>
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

  res.type("text/plain").send(
    [
      `Status: ${isRunning ? "RUNNING" : "IDLE"}`,
      "",
      "Last logs:",
      ...lastLogs.slice(-100),
    ].join("\n")
  );
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Migration web service listening on port ${PORT}`);
});

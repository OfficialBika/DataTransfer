const { MongoClient } = require("mongodb");

const required = ["OLD_MONGO_URI", "NEW_MONGO_URI", "OLD_DB_NAME", "NEW_DB_NAME"];

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

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const SKIP_INDEXES = String(process.env.SKIP_INDEXES || "false").toLowerCase() === "true";

async function copyIndexes(oldCol, newCol, collectionName) {
  if (SKIP_INDEXES) {
    console.log(`⏭️ Skip indexes for ${collectionName} because SKIP_INDEXES=true`);
    return;
  }

  const indexes = await oldCol.indexes();

  for (const index of indexes) {
    if (index.name === "_id_") continue;

    const { key, name, v, ns, ...indexOptions } = index;

    try {
      await newCol.createIndex(key, {
        ...indexOptions,
        name,
      });
      console.log(`✅ Index ready: ${collectionName}.${name}`);
    } catch (err) {
      console.log(`⚠️ Index skipped/failed: ${collectionName}.${name}`);
      console.log(`Reason: ${err.message}`);
    }
  }
}

async function ensureCollection(newDb, collectionInfo) {
  const name = collectionInfo.name;

  try {
    await newDb.createCollection(name, collectionInfo.options || {});
    console.log(`✅ Created collection if missing: ${name}`);
  } catch (err) {
    if (err.code === 48 || err.codeName === "NamespaceExists") {
      console.log(`ℹ️ Collection already exists: ${name}`);
    } else {
      throw err;
    }
  }
}

async function copyCollection(oldDb, newDb, collectionInfo) {
  const name = collectionInfo.name;

  if (name.startsWith("system.")) {
    console.log(`⏭️ Skip system collection: ${name}`);
    return;
  }

  if (collectionInfo.type && collectionInfo.type !== "collection") {
    console.log(`⏭️ Skip non-normal collection: ${name} type=${collectionInfo.type}`);
    return;
  }

  const oldCol = oldDb.collection(name);
  const newCol = newDb.collection(name);

  const total = await oldCol.countDocuments({});

  console.log("\n----------------------------------------");
  console.log(`📦 Collection: ${name}`);
  console.log(`📄 OLD documents: ${total}`);

  if (DRY_RUN) {
    console.log("🟡 DRY_RUN=true ဖြစ်လို့ copy မလုပ်သေးပါ");
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

      console.log(
        `✅ ${name}: ${processed}/${total} processed | matched=${result.matchedCount} modified=${result.modifiedCount} upserted=${result.upsertedCount}`
      );

      ops = [];
    }
  }

  if (ops.length > 0) {
    const result = await newCol.bulkWrite(ops, { ordered: false });
    processed += ops.length;

    console.log(
      `✅ ${name}: ${processed}/${total} processed | matched=${result.matchedCount} modified=${result.modifiedCount} upserted=${result.upsertedCount}`
    );
  }

  await copyIndexes(oldCol, newCol, name);

  console.log(`✅ Done: ${name}`);
}

async function main() {
  const oldClient = new MongoClient(OLD_URI);
  const newClient = new MongoClient(NEW_URI);

  try {
    console.log("🚀 MongoDB overwrite-copy started");
    console.log(`OLD_DB=${OLD_DB_NAME}`);
    console.log(`NEW_DB=${NEW_DB_NAME}`);
    console.log(`DRY_RUN=${DRY_RUN}`);
    console.log(`BATCH_SIZE=${BATCH_SIZE}`);
    console.log("MODE=NO_DELETE_OVERWRITE_BY_ID");
    console.log("✅ NEW DB ထဲကရှိပြီးသား data တွေကို မဖျက်ပါ");

    await oldClient.connect();
    await newClient.connect();

    const oldDb = oldClient.db(OLD_DB_NAME);
    const newDb = newClient.db(NEW_DB_NAME);

    const collections = await oldDb.listCollections({}, { nameOnly: false }).toArray();

    console.log(`\n📚 Found OLD collections: ${collections.length}`);
    for (const c of collections) {
      console.log(`- ${c.name}`);
    }

    for (const collectionInfo of collections) {
      await copyCollection(oldDb, newDb, collectionInfo);
    }

    console.log("\n🎉 MongoDB overwrite-copy finished");
    console.log("✅ NEW DB ထဲက extra data တွေ မဖျက်ထားပါ");
  } catch (err) {
    console.error("\n❌ Copy error:");
    console.error(err);
    process.exit(1);
  } finally {
    await oldClient.close().catch(() => {});
    await newClient.close().catch(() => {});
  }
}

main();

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
const CONFIRM_DROP_NEW_DB = process.env.CONFIRM_DROP_NEW_DB === "YES";

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
  console.log(`\n📦 Collection: ${name}`);
  console.log(`📄 Documents: ${total}`);

  if (DRY_RUN) {
    console.log("🟡 DRY_RUN=true ဖြစ်လို့ copy မလုပ်သေးပါ");
    return;
  }

  const options = collectionInfo.options || {};

  try {
    await newDb.createCollection(name, options);
    console.log(`✅ Created collection: ${name}`);
  } catch (err) {
    if (err.codeName === "NamespaceExists" || err.code === 48) {
      console.log(`ℹ️ Collection already exists: ${name}`);
    } else {
      throw err;
    }
  }

  const cursor = oldCol.find({}).batchSize(BATCH_SIZE);

  let ops = [];
  let copied = 0;

  for await (const doc of cursor) {
    ops.push({
      insertOne: {
        document: doc,
      },
    });

    if (ops.length >= BATCH_SIZE) {
      await newCol.bulkWrite(ops, { ordered: false });
      copied += ops.length;
      console.log(`✅ Copied: ${copied}/${total}`);
      ops = [];
    }
  }

  if (ops.length > 0) {
    await newCol.bulkWrite(ops, { ordered: false });
    copied += ops.length;
  }

  console.log(`✅ Data done: ${name} => ${copied}/${total}`);

  const indexes = await oldCol.indexes();

  for (const index of indexes) {
    if (index.name === "_id_") continue;

    const { key, name: indexName, v, ns, ...indexOptions } = index;

    try {
      await newCol.createIndex(key, {
        ...indexOptions,
        name: indexName,
      });
      console.log(`✅ Index copied: ${name}.${indexName}`);
    } catch (err) {
      console.log(`⚠️ Index copy failed: ${name}.${indexName}`);
      console.log(err.message);
    }
  }
}

async function main() {
  const oldClient = new MongoClient(OLD_URI);
  const newClient = new MongoClient(NEW_URI);

  try {
    console.log("🚀 Full MongoDB clone started");
    console.log(`OLD_DB=${OLD_DB_NAME}`);
    console.log(`NEW_DB=${NEW_DB_NAME}`);
    console.log(`DRY_RUN=${DRY_RUN}`);
    console.log(`CONFIRM_DROP_NEW_DB=${CONFIRM_DROP_NEW_DB}`);

    await oldClient.connect();
    await newClient.connect();

    const oldDb = oldClient.db(OLD_DB_NAME);
    const newDb = newClient.db(NEW_DB_NAME);

    const collections = await oldDb.listCollections({}, { nameOnly: false }).toArray();

    console.log(`\n📚 Found collections: ${collections.length}`);
    for (const c of collections) {
      console.log(`- ${c.name}`);
    }

    if (DRY_RUN) {
      console.log("\n🟡 DRY_RUN=true: collection/data count ပဲစစ်ပြီး copy မလုပ်ပါ");
    } else {
      if (!CONFIRM_DROP_NEW_DB) {
        console.error("\n❌ Safety lock active");
        console.error("တကယ် copy လုပ်ချင်ရင် CONFIRM_DROP_NEW_DB=YES ထားပါ");
        console.error("ဒါက NEW_DB ထဲက data အဟောင်းတွေကို အရင်ဖျက်ပြီးမှ copy လုပ်မှာပါ");
        process.exit(1);
      }

      console.log("\n⚠️ Dropping NEW_DB first...");
      await newDb.dropDatabase();
      console.log("✅ NEW_DB dropped/cleaned");
    }

    for (const collectionInfo of collections) {
      await copyCollection(oldDb, newDb, collectionInfo);
    }

    console.log("\n🎉 Full MongoDB clone finished");
  } catch (err) {
    console.error("\n❌ Clone error:");
    console.error(err);
    process.exit(1);
  } finally {
    await oldClient.close();
    await newClient.close();
  }
}

main();

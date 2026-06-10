"use strict";

const { config } = require("../config");
const { createMongoClient } = require("./mongo");

function validateCollectionName(name) {
  const value = String(name || "").trim();
  if (!value) throw new Error("Collection name is required. Example: /copy items_bika_character");
  if (value.length > 120) throw new Error("Collection name is too long");
  if (value.startsWith("system.")) throw new Error("System collections are not allowed");
  if (value.includes("$")) throw new Error("Invalid collection name: $ is not allowed");
  if (value.includes("\0")) throw new Error("Invalid collection name");

  if (!config.allowAnyCollection && !config.allowedCollections.includes(value)) {
    throw new Error(
      [
        `Collection not allowed: ${value}`,
        "Allowed collections:",
        ...config.allowedCollections.map((x) => `- ${x}`),
        "",
        "Set ALLOW_ANY_COLLECTION=true if you really want to copy any normal collection.",
      ].join("\n")
    );
  }

  return value;
}

async function ensureCollection(newDb, collectionInfo, log) {
  const name = collectionInfo.name;
  try {
    await newDb.createCollection(name, collectionInfo.options || {});
    log(`✅ Created collection: ${name}`);
  } catch (err) {
    if (err.code === 48 || err.codeName === "NamespaceExists") {
      log(`ℹ️ Collection already exists: ${name}`);
      return;
    }
    throw err;
  }
}

async function copyIndexes(oldCol, newCol, collectionName, log) {
  if (!config.copyIndexes) {
    log(`⏭️ Index copy disabled: ${collectionName}`);
    return;
  }

  let indexes = [];
  try {
    indexes = await oldCol.indexes();
  } catch (err) {
    log(`⚠️ Could not read indexes for ${collectionName}: ${err.message}`);
    return;
  }

  for (const index of indexes) {
    if (index.name === "_id_") continue;

    const { key, name, v, ns, ...options } = index;
    try {
      await newCol.createIndex(key, { ...options, name });
      log(`✅ Index ready: ${collectionName}.${name}`);
    } catch (err) {
      log(`⚠️ Index skipped/failed: ${collectionName}.${name} | ${err.message}`);
    }
  }
}

function createEmptyStats(collectionName) {
  return {
    collectionName,
    total: 0,
    processed: 0,
    matched: 0,
    modified: 0,
    upserted: 0,
    batches: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dryRun: false,
  };
}

async function flushBulk(newCol, ops, stats) {
  if (!ops.length) return;
  const result = await newCol.bulkWrite(ops, { ordered: false });
  stats.processed += ops.length;
  stats.matched += result.matchedCount || 0;
  stats.modified += result.modifiedCount || 0;
  stats.upserted += result.upsertedCount || 0;
  stats.batches += 1;
}

async function copyCollection(state, collectionName, options = {}) {
  const name = validateCollectionName(collectionName);
  const dryRun = Boolean(options.dryRun);
  const onLog = typeof options.onLog === "function" ? options.onLog : () => {};
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  const oldClient = createMongoClient(state.oldMongoUri);
  const newClient = createMongoClient(state.newMongoUri);
  const stats = createEmptyStats(name);
  stats.dryRun = dryRun;

  function log(message) {
    onLog(message);
  }

  try {
    log("🚀 Copy started");
    log(`Old DB: ${state.oldDbName}`);
    log(`New DB: ${state.newDbName}`);
    log(`Collection: ${name}`);
    log(`Mode: ${dryRun ? "DRY_RUN" : "NO_DELETE_OVERWRITE_BY_ID"}`);

    await oldClient.connect();
    await newClient.connect();

    const oldDb = oldClient.db(state.oldDbName);
    const newDb = newClient.db(state.newDbName);

    const collectionInfo = await oldDb.listCollections({ name }, { nameOnly: false }).next();
    if (!collectionInfo) {
      throw new Error(`Collection not found in OLD DB: ${name}`);
    }
    if (collectionInfo.type && collectionInfo.type !== "collection") {
      throw new Error(`Unsupported collection type: ${name} type=${collectionInfo.type}`);
    }

    const oldCol = oldDb.collection(name);
    const newCol = newDb.collection(name);
    stats.total = await oldCol.countDocuments({});
    log(`📄 OLD documents: ${stats.total}`);

    if (dryRun) {
      stats.finishedAt = new Date().toISOString();
      log("🟡 DRY RUN finished. No data was copied.");
      return stats;
    }

    await ensureCollection(newDb, collectionInfo, log);

    const cursor = oldCol.find({}).batchSize(config.batchSize);
    let ops = [];

    for await (const doc of cursor) {
      ops.push({
        replaceOne: {
          filter: { _id: doc._id },
          replacement: doc,
          upsert: true,
        },
      });

      if (ops.length >= config.batchSize) {
        await flushBulk(newCol, ops, stats);
        ops = [];
        onProgress({ ...stats });
      }
    }

    if (ops.length > 0) {
      await flushBulk(newCol, ops, stats);
      onProgress({ ...stats });
    }

    await copyIndexes(oldCol, newCol, name, log);

    stats.finishedAt = new Date().toISOString();
    log(`✅ Done: ${name}`);
    log(`Processed=${stats.processed} matched=${stats.matched} modified=${stats.modified} upserted=${stats.upserted}`);
    log("✅ OLD DB unchanged. NEW DB extra collections/data were not deleted.");
    return stats;
  } finally {
    await oldClient.close().catch(() => {});
    await newClient.close().catch(() => {});
  }
}

module.exports = {
  copyCollection,
  validateCollectionName,
};

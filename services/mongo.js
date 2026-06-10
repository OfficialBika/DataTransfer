"use strict";

const { MongoClient } = require("mongodb");
const { config } = require("../config");

function createMongoClient(uri) {
  return new MongoClient(uri, {
    serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
    connectTimeoutMS: config.connectTimeoutMS,
    socketTimeoutMS: config.socketTimeoutMS,
    maxPoolSize: 10,
    retryWrites: true,
  });
}

async function withDb(uri, dbName, callback) {
  const client = createMongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    return await callback(db, client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function listCollections(uri, dbName) {
  return withDb(uri, dbName, async (db) => {
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    return collections
      .filter((c) => !String(c.name || "").startsWith("system."))
      .map((c) => ({
        name: c.name,
        type: c.type || "collection",
        options: c.options || {},
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

async function ping(uri, dbName) {
  return withDb(uri, dbName, async (db) => {
    await db.command({ ping: 1 });
    return true;
  });
}

module.exports = {
  createMongoClient,
  listCollections,
  ping,
  withDb,
};

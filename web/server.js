"use strict";

const express = require("express");
const { config } = require("../config");

function startWebServer(stateStore) {
  const app = express();

  function checkKey(req, res) {
    if (!config.migrateKey) return true;
    if (req.query.key !== config.migrateKey) {
      res.status(403).send("Forbidden");
      return false;
    }
    return true;
  }

  app.get("/", (_req, res) => {
    res.type("html").send(`
      <h2>DataTransfer Telegram Service</h2>
      <p>Status: running</p>
      <p>Mode: Telegram-controlled selected collection copy</p>
      <p>OLD DB is never deleted. NEW DB extra data is not deleted.</p>
      <p>Use the Telegram bot commands to set DB URIs, DB names, check collections, and copy one collection.</p>
    `);
  });

  app.get("/status", (req, res) => {
    if (!checkKey(req, res)) return;
    res.json({
      ok: true,
      mode: "TELEGRAM_SELECTED_COLLECTION_COPY",
      settings: stateStore.getMasked(),
      copyIndexes: config.copyIndexes,
      allowAnyCollection: config.allowAnyCollection,
      allowedCollections: config.allowedCollections,
    });
  });

  app.listen(config.port, config.host, () => {
    console.log(`Web server listening on ${config.host}:${config.port}`);
  });
}

module.exports = {
  startWebServer,
};

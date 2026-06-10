"use strict";

const TelegramBot = require("node-telegram-bot-api");
const { config } = require("../config");
const { listCollections, ping } = require("../services/mongo");
const { copyCollection } = require("../services/migration");
const { maskMongoUri } = require("../services/state");

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

function normalizeOwnerIds(ids) {
  return new Set((ids || []).map(String));
}

function getArg(text, command) {
  const raw = String(text || "").trim();
  return raw.replace(new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i"), "").trim();
}

function formatCollectionList(title, collections) {
  if (!collections.length) return `${title}\nNo collections found.`;
  return [
    title,
    `Total: ${collections.length}`,
    "",
    ...collections.map((c, i) => `${i + 1}. ${c.name}`),
  ].join("\n");
}

function formatState(stateStore) {
  const s = stateStore.getMasked();
  return [
    "📌 Current Transfer Settings",
    "",
    `OLD URI: ${s.oldMongoUri}`,
    `OLD DB: ${s.oldDbName}`,
    "",
    `NEW URI: ${s.newMongoUri}`,
    `NEW DB: ${s.newDbName}`,
    "",
    `Updated: ${s.updatedAt}`,
    `Mode: NO_DELETE_OVERWRITE_BY_ID`,
    `Copy indexes: ${config.copyIndexes}`,
    `Allow any collection: ${config.allowAnyCollection}`,
  ].join("\n");
}

function formatStats(stats) {
  return [
    stats.dryRun ? "🟡 DRY RUN finished" : "✅ Copy finished",
    "",
    `Collection: ${stats.collectionName}`,
    `Total: ${stats.total}`,
    `Processed: ${stats.processed}`,
    `Matched: ${stats.matched}`,
    `Modified: ${stats.modified}`,
    `Inserted: ${stats.upserted}`,
    `Batches: ${stats.batches}`,
    "",
    "OLD DB unchanged.",
  ].join("\n");
}

class TelegramTransferBot {
  constructor(stateStore) {
    this.stateStore = stateStore;
    this.ownerIds = normalizeOwnerIds(config.ownerIds);
    this.bot = null;
    this.isRunning = false;
    this.logs = [];
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
  }

  isOwner(msg) {
    return Boolean(msg && msg.from && this.ownerIds.has(String(msg.from.id)));
  }

  isPrivate(msg) {
    return msg && msg.chat && msg.chat.type === "private";
  }

  async send(chatId, text, options = {}) {
    for (const chunk of splitLongText(text)) {
      await this.bot.sendMessage(chatId, chunk, { disable_web_page_preview: true, ...options });
    }
  }

  async replyError(msg, err) {
    const message = err && err.message ? err.message : String(err || "Unknown error");
    await this.send(msg.chat.id, `❌ ${message}`);
  }

  guardOwner(msg) {
    if (!this.isOwner(msg)) {
      this.send(msg.chat.id, "❌ You are not allowed.");
      return false;
    }
    return true;
  }

  guardSensitiveCommand(msg) {
    if (!config.allowSensitiveCommandsInGroups && !this.isPrivate(msg)) {
      this.send(msg.chat.id, "⚠️ For safety, use this command in bot DM only.");
      return false;
    }
    return true;
  }

  usageText() {
    return [
      "MongoDB Selected Collection Transfer Bot",
      "",
      "Setup:",
      "/setolddb <old_mongodb_url>",
      "/fromolddbname <old_db_name>",
      "/setnewdb <new_mongodb_url>",
      "/setnewdbname <new_db_name>",
      "",
      "Check:",
      "/status",
      "/checkolddbcollection",
      "/checknewdbcollection",
      "",
      "Copy:",
      "/copy <collection_name>",
      "/copydry <collection_name>",
      "",
      "Clean saved settings only:",
      "/cleanolddb",
      "/cleannewdb",
      "",
      "Mode:",
      "- OLD DB data never deleted",
      "- NEW DB extra data not deleted",
      "- Same _id => overwrite",
      "- Missing _id => insert",
    ].join("\n");
  }

  registerHandlers() {
    this.bot.on("polling_error", (err) => {
      console.error("Telegram polling error:", err.message);
    });

    this.bot.onText(/^\/start(?:@\w+)?$|^\/help(?:@\w+)?$/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      await this.send(msg.chat.id, this.usageText());
    });

    this.bot.onText(/^\/status(?:@\w+)?$/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      const recentLogs = this.logs.slice(-config.telegramLogLimit);
      await this.send(msg.chat.id, [formatState(this.stateStore), "", "Last logs:", ...recentLogs].join("\n"));
    });

    this.bot.onText(/^\/setolddb(?:@\w+)?\s+(.+)/i, async (msg) => {
      if (!this.guardOwner(msg) || !this.guardSensitiveCommand(msg)) return;
      try {
        const uri = getArg(msg.text, "setolddb");
        this.stateStore.setOldMongoUri(uri);
        await this.send(msg.chat.id, `✅ OLD MongoDB URI saved\n${maskMongoUri(uri)}`);
      } catch (err) {
        await this.replyError(msg, err);
      }
    });

    this.bot.onText(/^\/setnewdb(?:@\w+)?\s+(.+)/i, async (msg) => {
      if (!this.guardOwner(msg) || !this.guardSensitiveCommand(msg)) return;
      try {
        const uri = getArg(msg.text, "setnewdb");
        this.stateStore.setNewMongoUri(uri);
        await this.send(msg.chat.id, `✅ NEW MongoDB URI saved\n${maskMongoUri(uri)}`);
      } catch (err) {
        await this.replyError(msg, err);
      }
    });

    this.bot.onText(/^\/fromolddbname(?:@\w+)?\s+(.+)/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      try {
        const name = getArg(msg.text, "fromolddbname");
        this.stateStore.setOldDbName(name);
        await this.send(msg.chat.id, `✅ OLD DB name saved: ${name}`);
      } catch (err) {
        await this.replyError(msg, err);
      }
    });

    this.bot.onText(/^\/setnewdbname(?:@\w+)?\s+(.+)/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      try {
        const name = getArg(msg.text, "setnewdbname");
        this.stateStore.setNewDbName(name);
        await this.send(msg.chat.id, `✅ NEW DB name saved: ${name}`);
      } catch (err) {
        await this.replyError(msg, err);
      }
    });

    this.bot.onText(/^\/cleanolddb(?:@\w+)?$/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      this.stateStore.cleanOldDb();
      await this.send(msg.chat.id, "✅ OLD saved connection info cleared. OLD DB data was not deleted.");
    });

    this.bot.onText(/^\/cleannewdb(?:@\w+)?$/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      this.stateStore.cleanNewDb();
      await this.send(msg.chat.id, "✅ NEW saved connection info cleared. NEW DB data was not deleted.");
    });

    this.bot.onText(/^\/checkolddbcollection(?:@\w+)?$/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      try {
        const s = this.stateStore.requireOldConfig();
        await ping(s.oldMongoUri, s.oldDbName);
        const collections = await listCollections(s.oldMongoUri, s.oldDbName);
        await this.send(msg.chat.id, formatCollectionList(`📚 OLD DB collections: ${s.oldDbName}`, collections));
      } catch (err) {
        await this.replyError(msg, err);
      }
    });

    this.bot.onText(/^\/checknewdbcollection(?:@\w+)?$/i, async (msg) => {
      if (!this.guardOwner(msg)) return;
      try {
        const s = this.stateStore.requireNewConfig();
        await ping(s.newMongoUri, s.newDbName);
        const collections = await listCollections(s.newMongoUri, s.newDbName);
        await this.send(msg.chat.id, formatCollectionList(`📚 NEW DB collections: ${s.newDbName}`, collections));
      } catch (err) {
        await this.replyError(msg, err);
      }
    });

    this.bot.onText(/^\/copydry(?:@\w+)?\s+(.+)/i, async (msg) => {
      await this.handleCopy(msg, true);
    });

    this.bot.onText(/^\/copy(?:@\w+)?\s+(.+)/i, async (msg) => {
      await this.handleCopy(msg, false);
    });
  }

  async handleCopy(msg, dryRun) {
    if (!this.guardOwner(msg)) return;

    if (this.isRunning) {
      await this.send(msg.chat.id, "🟡 Copy already running. Use /status to check logs.");
      return;
    }

    const command = dryRun ? "copydry" : "copy";
    const collectionName = getArg(msg.text, command);
    if (!collectionName) {
      await this.send(msg.chat.id, `Usage: /${command} <collection_name>`);
      return;
    }

    this.isRunning = true;
    this.logs = [];
    let lastProgressAt = 0;
    let batchCounter = 0;

    try {
      const state = this.stateStore.requireCopyConfig();
      await this.send(
        msg.chat.id,
        [
          dryRun ? "🟡 DRY RUN started" : "🚀 Copy started",
          `Collection: ${collectionName}`,
          `Old DB: ${state.oldDbName}`,
          `New DB: ${state.newDbName}`,
          `Mode: ${dryRun ? "DRY_RUN" : "NO_DELETE_OVERWRITE_BY_ID"}`,
        ].join("\n")
      );

      const stats = await copyCollection(state, collectionName, {
        dryRun,
        onLog: (line) => this.log(line),
        onProgress: async (partial) => {
          batchCounter += 1;
          const now = Date.now();
          if (batchCounter % config.progressEveryBatches !== 0 && now - lastProgressAt < 15000) return;
          lastProgressAt = now;
          await this.send(
            msg.chat.id,
            `⏳ ${partial.collectionName}: ${partial.processed}/${partial.total} processed | matched=${partial.matched} modified=${partial.modified} inserted=${partial.upserted}`
          );
        },
      });

      await this.send(msg.chat.id, formatStats(stats));
    } catch (err) {
      this.log(`❌ ${err.message}`);
      await this.replyError(msg, err);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    this.bot = new TelegramBot(config.botToken, { polling: true });
    this.registerHandlers();
    console.log("Telegram transfer bot started");
    console.log(`Owner IDs: ${config.ownerIds.join(", ")}`);
  }
}

module.exports = {
  TelegramTransferBot,
};

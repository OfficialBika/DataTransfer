"use strict";

require("dotenv").config();

const DEFAULT_ALLOWED_COLLECTIONS = [
  "items_character_catcher",
  "items_characters_hallow",
  "items_capture_character",
  "items_character_seizer",
  "items_husbando_grabber",
  "items_grab_your_waifu",
  "items_grab_your_husbando",
  "items_takers_character",
  "items_catch_your_husbando",
  "items_smash_character",
  "items_waifux_grab",
  "items_catch_your_waifu",
  "items_waifu_grabber",
  "items_roronoa_zoro",
  "items_character_picker",
  "items_bika_character",
];

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseInteger(value, defaultValue) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

const ownerIds = parseCsv(process.env.OWNER_IDS || process.env.OWNER_ID).map(String);
const envAllowedCollections = parseCsv(process.env.ALLOWED_COLLECTIONS);

const config = {
  port: parseInteger(process.env.PORT, 10000),
  host: process.env.HOST || "0.0.0.0",
  logLevel: String(process.env.LOG_LEVEL || "INFO").toUpperCase(),

  botToken: process.env.BOT_TOKEN || "",
  ownerIds,

  // Optional web key for /status?key=... endpoint. Telegram commands are owner-only.
  migrateKey: process.env.MIGRATE_KEY || "",

  // These are fallback/default values. Telegram commands can override them at runtime.
  oldMongoUri: process.env.OLD_MONGO_URI || "",
  newMongoUri: process.env.NEW_MONGO_URI || "",
  oldDbName: process.env.OLD_DB_NAME || "",
  newDbName: process.env.NEW_DB_NAME || "",

  stateFile: process.env.STATE_FILE || "./transfer-state.json",

  batchSize: parseInteger(process.env.BATCH_SIZE, 500),
  progressEveryBatches: parseInteger(process.env.PROGRESS_EVERY_BATCHES, 5),
  telegramLogLimit: parseInteger(process.env.TELEGRAM_LOG_LIMIT, 30),

  copyIndexes: parseBool(process.env.COPY_INDEXES, true),
  allowAnyCollection: parseBool(process.env.ALLOW_ANY_COLLECTION, false),
  allowedCollections: envAllowedCollections.length > 0 ? envAllowedCollections : DEFAULT_ALLOWED_COLLECTIONS,

  // Mongo connection settings.
  serverSelectionTimeoutMS: parseInteger(process.env.SERVER_SELECTION_TIMEOUT_MS, 15000),
  connectTimeoutMS: parseInteger(process.env.CONNECT_TIMEOUT_MS, 15000),
  socketTimeoutMS: parseInteger(process.env.SOCKET_TIMEOUT_MS, 120000),

  // Safety: URI-setting commands should normally be used in bot DM only.
  allowSensitiveCommandsInGroups: parseBool(process.env.ALLOW_SENSITIVE_COMMANDS_IN_GROUPS, false),
};

function validateStartupConfig() {
  if (!config.botToken) {
    throw new Error("BOT_TOKEN is required");
  }
  if (!config.ownerIds.length) {
    throw new Error("OWNER_ID or OWNER_IDS is required");
  }
  if (!Number.isFinite(config.batchSize) || config.batchSize < 1) {
    throw new Error("BATCH_SIZE must be a positive integer");
  }
}

module.exports = {
  DEFAULT_ALLOWED_COLLECTIONS,
  config,
  parseBool,
  parseCsv,
  parseInteger,
  validateStartupConfig,
};

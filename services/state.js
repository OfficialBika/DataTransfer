"use strict";

const fs = require("fs");
const path = require("path");

function maskMongoUri(uri) {
  const value = String(uri || "").trim();
  if (!value) return "not set";

  try {
    const u = new URL(value);
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    return u.toString();
  } catch (_) {
    // Fallback mask for unusual URI strings.
    return value.replace(/(mongodb(?:\+srv)?:\/\/)([^:@/]+):([^@/]+)@/i, "$1***:***@");
  }
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isMongoUri(value) {
  const uri = normalizeString(value);
  return uri.startsWith("mongodb://") || uri.startsWith("mongodb+srv://");
}

function isValidDbName(value) {
  const name = normalizeString(value);
  if (!name || name.length > 63) return false;
  // MongoDB database names cannot contain these characters.
  return !/[\\/."$\s]/.test(name);
}

class StateStore {
  constructor(config) {
    this.config = config;
    this.filePath = path.resolve(config.stateFile);
    this.state = {
      oldMongoUri: config.oldMongoUri || "",
      newMongoUri: config.newMongoUri || "",
      oldDbName: config.oldDbName || "",
      newDbName: config.newDbName || "",
      updatedAt: null,
    };
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const saved = JSON.parse(raw);
      this.state = {
        ...this.state,
        ...["oldMongoUri", "newMongoUri", "oldDbName", "newDbName"].reduce((acc, key) => {
          if (typeof saved[key] === "string") acc[key] = saved[key];
          return acc;
        }, {}),
        updatedAt: saved.updatedAt || this.state.updatedAt,
      };
    } catch (err) {
      console.warn(`State load skipped: ${err.message}`);
    }
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  get() {
    return { ...this.state };
  }

  getMasked() {
    return {
      oldMongoUri: maskMongoUri(this.state.oldMongoUri),
      newMongoUri: maskMongoUri(this.state.newMongoUri),
      oldDbName: this.state.oldDbName || "not set",
      newDbName: this.state.newDbName || "not set",
      updatedAt: this.state.updatedAt || "not saved yet",
    };
  }

  setOldMongoUri(uri) {
    const value = normalizeString(uri);
    if (!isMongoUri(value)) throw new Error("Invalid OLD MongoDB URI. It must start with mongodb:// or mongodb+srv://");
    this.state.oldMongoUri = value;
    this.save();
  }

  setNewMongoUri(uri) {
    const value = normalizeString(uri);
    if (!isMongoUri(value)) throw new Error("Invalid NEW MongoDB URI. It must start with mongodb:// or mongodb+srv://");
    this.state.newMongoUri = value;
    this.save();
  }

  setOldDbName(name) {
    const value = normalizeString(name);
    if (!isValidDbName(value)) throw new Error("Invalid OLD DB name. Avoid spaces and these characters: / \\ . \" $ ");
    this.state.oldDbName = value;
    this.save();
  }

  setNewDbName(name) {
    const value = normalizeString(name);
    if (!isValidDbName(value)) throw new Error("Invalid NEW DB name. Avoid spaces and these characters: / \\ . \" $ ");
    this.state.newDbName = value;
    this.save();
  }

  cleanOldDb() {
    this.state.oldMongoUri = "";
    this.state.oldDbName = "";
    this.save();
  }

  cleanNewDb() {
    this.state.newMongoUri = "";
    this.state.newDbName = "";
    this.save();
  }

  requireOldConfig() {
    const s = this.get();
    if (!s.oldMongoUri) throw new Error("OLD MongoDB URI is not set. Use /setolddb <mongodb-url>");
    if (!s.oldDbName) throw new Error("OLD DB name is not set. Use /fromolddbname <dbname>");
    return s;
  }

  requireNewConfig() {
    const s = this.get();
    if (!s.newMongoUri) throw new Error("NEW MongoDB URI is not set. Use /setnewdb <mongodb-url>");
    if (!s.newDbName) throw new Error("NEW DB name is not set. Use /setnewdbname <dbname>");
    return s;
  }

  requireCopyConfig() {
    const s = this.get();
    this.requireOldConfig();
    this.requireNewConfig();
    return s;
  }
}

module.exports = {
  StateStore,
  isMongoUri,
  isValidDbName,
  maskMongoUri,
};

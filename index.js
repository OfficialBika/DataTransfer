"use strict";

const { config, validateStartupConfig } = require("./config");
const { StateStore } = require("./services/state");
const { TelegramTransferBot } = require("./bot/telegram");
const { startWebServer } = require("./web/server");

function main() {
  validateStartupConfig();

  const stateStore = new StateStore(config);
  stateStore.load();

  startWebServer(stateStore);

  const telegramBot = new TelegramTransferBot(stateStore);
  telegramBot.start();
}

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

main();

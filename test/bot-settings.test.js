import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(os.tmpdir(), "toluwalase-xmd-mode-"));
process.env.TOLUWALASE_DATA_DIR = directory;
process.env.BOT_MODE = "public";

const settings = await import("../lib/bot-settings.js");
const ownerTools = await import("../commands/owner-tools.js");

test("mode defaults to public and persists changes across reads", async () => {
  assert.equal(await settings.getBotMode(), "public");
  assert.equal(await settings.setBotMode("private"), "private");
  assert.equal(await settings.getBotMode(), "private");
  assert.equal(await settings.setBotMode("public"), "public");
  assert.equal(await settings.getBotMode(), "public");
});

test("mode survives a fresh settings-module load", async () => {
  await settings.setBotMode("private");
  const freshSettings = await import("../lib/bot-settings.js?fresh-mode-check");
  assert.equal(await freshSettings.getBotMode(), "private");
  await settings.setBotMode("public");
});

test("mode rejects values other than public and private", async () => {
  await assert.rejects(() => settings.setBotMode("friends"), /public or private/);
  await assert.rejects(() => settings.setBotMode(""), /public or private/);
});

test("mode command is owner-only and reports the current mode", async () => {
  const command = ownerTools.default.find(item => item.name === "mode");
  const replies = [];
  await command.run({
    owner: false,
    args: "private",
    config: { prefix: "!" },
    reply: async message => replies.push(message)
  });
  assert.match(replies[0], /Only the bot owner/);
  assert.equal(await settings.getBotMode(), "public");

  replies.length = 0;
  await command.run({
    owner: true,
    args: "",
    config: { prefix: "!" },
    reply: async message => replies.push(message)
  });
  assert.match(replies[0], /Current mode: \*PUBLIC\*/);
});

test("mode command lets the owner switch between private and public", async () => {
  const command = ownerTools.default.find(item => item.name === "mode");
  const replies = [];
  const ctx = {
    owner: true,
    config: { prefix: "!" },
    reply: async message => replies.push(message)
  };

  ctx.args = "private";
  await command.run(ctx);
  assert.equal(await settings.getBotMode(), "private");
  assert.match(replies.at(-1), /Only the bot owner/);

  ctx.args = "public";
  await command.run(ctx);
  assert.equal(await settings.getBotMode(), "public");
});

test("owner matching uses the configured owner number", async () => {
  const { isOwnerNumber, canUseBotCommands } = await import("../lib/owner-utils.js");
  const config = { ownerNumbers: ["2348012345678"] };
  assert.equal(isOwnerNumber(config, "2348012345678@s.whatsapp.net"), true);
  assert.equal(isOwnerNumber(config, "2348099999999@s.whatsapp.net"), false);
  assert.equal(canUseBotCommands("public", config, "2348099999999@s.whatsapp.net"), true);
  assert.equal(canUseBotCommands("private", config, "2348099999999@s.whatsapp.net"), false);
  assert.equal(canUseBotCommands("private", config, "2348012345678@s.whatsapp.net"), true);
});

test("mode test storage is removed after the test file completes", async () => {
  await rm(directory, { recursive: true, force: true });
});

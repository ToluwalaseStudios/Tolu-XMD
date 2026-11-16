import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import config from "../config/bot.config.js";
import theme from "../config/theme.config.js";
import { loadCommands } from "../handlers/command-loader.js";
import { buildMenu } from "../lib/menu.js";

test("selected commands load without collisions and excluded modules stay inactive", async () => {
  const { commands, lookup } = await loadCommands(path.resolve("commands"));
  assert.ok(commands.length > 0);

  for (const name of [
    "menu", "help", "ping", "alive", "owner", "support", "time", "date",
    "version", "jid", "whoami", "calc", "poll", "coinflip", "dice",
    "8ball", "choose", "trivia", "riddle", "activity", "vv", "vv2",
    "mode", "setprefix"
  ]) {
    assert.ok(lookup.has(name), "missing retained command " + name);
  }

  for (const name of [
    "anime", "animemenu", "manga", "character", "randomanime",
    "angry", "baka", "blowkiss", "cuddle", "dance", "hug", "kiss",
    "pokemon"
  ]) {
    assert.equal(lookup.has(name), false, "excluded command was registered: " + name);
  }
});

test("menu contains each configured section in order and omits command descriptions", async () => {
  const { commands } = await loadCommands(path.resolve("commands"));
  const menu = buildMenu({ commands, config, theme });
  const positions = theme.sections.map(section => menu.indexOf(section.title));

  assert.ok(theme.sections.length > 0);
  assert.ok(positions.every(position => position >= 0));
  assert.ok(positions.every((position, index) =>
    index === 0 || positions[index - 1] < position
  ));
  assert.ok(menu.includes(config.prefix + "menu"));
  assert.ok(menu.includes(config.prefix + "mode"));
  assert.equal(menu.includes(" — Show"), false);
  assert.equal(menu.includes(" — Change"), false);
});

test("configuration uses Toluwalase Studios branding", () => {
  assert.equal(config.name, "Toluwalase XMD");
  assert.equal(config.ownerName, "Toluwalase Studios");
  assert.ok(Array.isArray(config.ownerNumbers));
  assert.equal(config.channel.name, "TOLUWALASE STUDIOS");
  assert.equal(typeof config.imageUrl, "string");
  assert.equal(typeof config.botUrl, "string");
});

test("menu command sends a text menu", async () => {
  const { commands } = await loadCommands(path.resolve("commands"));
  const menuCommand = commands.find(command => command.name === "menu");
  const sent = [];
  const ctx = {
    config,
    theme,
    commands,
    send: async payload => sent.push({ type: "media", payload }),
    reply: async payload => sent.push({ type: "text", payload })
  };

  await menuCommand.run(ctx);
  const textMessage = sent.find(item => item.type === "text");
  assert.ok(textMessage);
  for (const section of theme.sections) {
    assert.ok(textMessage.payload.includes(section.title));
  }
});

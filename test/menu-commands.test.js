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
    "mode", "setprefix", "song", "play2", "claude", "txt2video", "fetch", "clideo", "gemtts", "woman1", "woman2", "woman3", "man1", "man2", "man3", "captts"
  ]) {
    assert.ok(lookup.has(name), "missing retained command " + name);
  }

  for (const name of [
    "ai", "ask", "gpt", "chatgpt", "mathgpt", "deepseek", "translate", "summarize",
    "fable5", "qwen", "deepseek2", "qwenweb", "study", "code", "ytbrief", "ytsummary",
    "claudeomega", "onlycloud", "pollination", "tts5",
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
  assert.ok(menu.includes(config.prefix + "fetch"));
  assert.ok(menu.includes(config.prefix + "txt2video"));
  assert.equal(menu.includes("OTHER COMMANDS"), false);
  assert.equal(menu.includes("AI & CHAT"), false);
  assert.equal(menu.includes("AI MEDIA"), false);
  assert.equal(menu.includes(" — Show"), false);
  assert.equal(menu.includes(" — Change"), false);
  assert.ok(menu.includes("𝕿𝖔𝖑𝖚𝖜𝖆𝖑𝖆𝖘𝖊♚"));
  assert.equal(menu.includes("⚕"), false);
  assert.ok(menu.split("\n").length > 10);
  assert.equal(menu.includes("\\n"), false);
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


test("full menu retains its original decorated multi-section layout", async () => {
  const { commands } = await loadCommands(path.resolve("commands"));
  const menu = buildMenu({ commands, config, theme });
  assert.ok(menu.length > 1024, "full menu should not be compacted to fit an image caption");
  assert.ok(menu.includes("╭━━〔"));
  assert.ok(menu.includes("┃ ◈ " + config.prefix + "menu"));
  for (const section of theme.sections) assert.ok(menu.includes(section.title));
  assert.ok(menu.includes(theme.footer));
  assert.ok(menu.split("\n").length > 30);
});

test("menu artwork preview and full decorated menu are sent in one text message", async () => {
  const { commands } = await loadCommands(path.resolve("commands"));
  const menuCommand = commands.find(command => command.name === "menu");
  const sent = [];
  const ctx = {
    config: { ...config, imageUrl: "https://example.com/bot-menu.jpg", botUrl: "https://example.com" },
    theme,
    commands,
    send: async payload => sent.push({ type: "send", payload }),
    reply: async payload => sent.push({ type: "reply", payload })
  };

  await menuCommand.run(ctx);
  assert.equal(sent.length, 1, "menu must be delivered in exactly one WhatsApp message");
  assert.equal(sent[0].type, "send");
  assert.equal(sent[0].payload.text, buildMenu({ commands, config: ctx.config, theme }));
  const preview = sent[0].payload.contextInfo.externalAdReply;
  assert.equal(preview.thumbnailUrl, ctx.config.imageUrl);
  assert.equal(preview.sourceUrl, ctx.config.botUrl);
  assert.equal(preview.renderLargerThumbnail, true);
  for (const section of theme.sections) assert.ok(sent[0].payload.text.includes(section.title));
});

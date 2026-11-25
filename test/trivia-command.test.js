import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(os.tmpdir(), "tolu-trivia-command-"));
process.env.TOLUWALASE_DATA_DIR = directory;
process.env.BOT_MODE = "private";

const [{ default: trivia }, { default: generalCommands }, { triviaStore }, { triviaEngine }] = await Promise.all([
  import("../commands/trivia.js"),
  import("../commands/general.js"),
  import("../lib/trivia-store.js"),
  import("../lib/trivia-engine.js")
]);

const groupJid = "120363098765432109-123456@g.us";
const replies = [];
const sent = [];
const sock = { sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return {}; } };
const baseContext = {
  jid: groupJid,
  senderJid: "2348000000001@s.whatsapp.net",
  config: { prefix: "!", name: "Toluwalase XMD" },
  mode: "private",
  owner: false,
  sock,
  msg: { key: { remoteJid: groupJid }, message: {} },
  reply: async value => { replies.push(String(value)); }
};

test("Trivia is explicitly marked as a narrowly permitted Private-mode command", () => {
  assert.equal(trivia.allowInPrivateMode, true);
  assert.equal(trivia.name, "trivia");
});

test("only the owner can enable a group and participants can access its restricted menu", async () => {
  await trivia.run({ ...baseContext, owner: false, args: "enable" });
  assert.match(replies.at(-1), /Only the bot owner/);
  assert.equal(await triviaStore.isGroupEnabled(groupJid), false);

  await trivia.run({ ...baseContext, owner: true, args: "enable" });
  assert.equal(await triviaStore.isGroupEnabled(groupJid), true);
  assert.match(replies.at(-1), /TRIVIA ENABLED/);

  const menu = generalCommands.find(command => command.name === "menu");
  await menu.run({ ...baseContext, commands: [], theme: {} });
  assert.match(replies.at(-1), /TRIVIA ARENA/);
  assert.doesNotMatch(replies.at(-1), /AI & MEDIA/);
});

test("owner can add a question and members can start and stop a competition", async () => {
  const block = [
    "Subject: Biology",
    "Subcategory: Cell Biology",
    "Difficulty: Hard",
    "Question: Which organelle modifies and packages proteins?",
    "A: Lysosome",
    "B: Golgi apparatus",
    "C: Ribosome",
    "D: Nucleolus",
    "Answer: B",
    "Explanation: The Golgi apparatus modifies, sorts and packages proteins."
  ].join("\n");

  await trivia.run({ ...baseContext, owner: true, args: "add\n" + block });
  assert.match(replies.at(-1), /Question added/);
  assert.equal((await triviaStore.listQuestions()).length, 1);

  await trivia.run({
    ...baseContext,
    owner: false,
    senderJid: "2348000000002@s.whatsapp.net",
    args: "start Biology | all | mixed | 1 | 10"
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.text, /TRIVIA/);
  assert.match(sent[0].payload.text, /Question:\* 1\/1/);

  await trivia.run({
    ...baseContext,
    owner: false,
    senderJid: "2348000000003@s.whatsapp.net",
    args: "stop"
  });
  assert.equal(triviaEngine.getActiveGame(groupJid), null);
  assert.equal(sent.some(item => item.payload.text.includes("COMPETITION STOPPED")), true);
});

test("disabled groups cannot start competitions and members cannot manage the question bank", async () => {
  await trivia.run({ ...baseContext, owner: true, args: "disable" });
  assert.equal(await triviaStore.isGroupEnabled(groupJid), false);

  await trivia.run({ ...baseContext, owner: false, args: "start Biology" });
  assert.match(replies.at(-1), /not enabled/);

  await trivia.run({ ...baseContext, owner: false, args: "add" });
  assert.match(replies.at(-1), /Only the bot owner/);
});

test("Trivia test data is cleaned up", async () => {
  await triviaEngine.stopGame(groupJid);
  await triviaStore.flush();
  await rm(directory, { recursive: true, force: true });
});

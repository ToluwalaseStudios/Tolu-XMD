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

test("plain !trivia in the owner's personal DM still opens the existing menu", async () => {
  const personalReplies = [];
  await trivia.run({
    ...baseContext,
    jid: "2349000000000@s.whatsapp.net",
    owner: true,
    args: "",
    reply: async value => personalReplies.push(String(value))
  });
  assert.match(personalReplies[0], /GROUP COMPETITION ARENA/);
  assert.match(personalReplies[0], /AVAILABLE CATEGORIES/);
});

test("Trivia menu lists the question-bank and bulk-delete commands", async () => {
  const ownerReplies = [];
  await trivia.run({ ...baseContext, owner: true, args: "help", reply: async value => ownerReplies.push(String(value)) });
  assert.match(ownerReplies.at(-1), /trivia import/);
  assert.match(ownerReplies.at(-1), /trivia delete subject/);
  assert.match(ownerReplies.at(-1), /trivia delete topic/);
  assert.match(ownerReplies.at(-1), /trivia delete ids/);
  assert.match(ownerReplies.at(-1), /trivia delete all/);
  assert.match(ownerReplies.at(-1), /trivia delete confirm/);
});

test("bulk deletion requires an owner confirmation code and deletes only the previewed questions", async () => {
  const add = index => ({
    subject: "Biology",
    subcategory: index === 1 ? "Cell Biology" : "Genetics",
    question: "Bulk delete test question " + index + "?",
    options: { A: "A", B: "B", C: "C", D: "D" },
    answer: "A"
  });
  await triviaStore.addQuestions([add(1), add(2)]);
  const before = await triviaStore.getStats();
  await trivia.run({ ...baseContext, owner: false, args: "delete all" });
  assert.match(replies.at(-1), /Only the bot owner/);
  assert.equal((await triviaStore.getStats()).questionCount, before.questionCount);

  await trivia.run({ ...baseContext, owner: true, args: "delete topic Biology|Cell Biology" });
  const preview = replies.at(-1);
  assert.match(preview, /Questions to delete: 1/);
  const code = preview.match(/trivia delete confirm ([A-F0-9]+)/)?.[1];
  assert.ok(code);
  await trivia.run({ ...baseContext, owner: true, args: "delete confirm WRONG" });
  assert.match(replies.at(-1), /does not match/);
  assert.equal((await triviaStore.getStats()).questionCount, before.questionCount);
  await trivia.run({ ...baseContext, owner: true, args: "delete confirm " + code });
  assert.match(replies.at(-1), /Questions deleted: 1/);
  const remaining = await triviaStore.listQuestions();
  assert.equal(remaining.some(item => item.subcategory === "Cell Biology"), false);
  assert.equal(remaining.some(item => item.subcategory === "Genetics"), true);

  await trivia.run({ ...baseContext, owner: true, args: "delete all" });
  const allPreview = replies.at(-1);
  const allCode = allPreview.match(/trivia delete confirm ([A-F0-9]+)/)?.[1];
  assert.ok(allCode);
  await trivia.run({ ...baseContext, owner: true, args: "delete cancel" });
  assert.match(replies.at(-1), /cancelled/);
  assert.equal((await triviaStore.getStats()).questionCount, 1);
});

test("owner can add a question and members can start and stop a competition", async () => {
  const block = [
    "Subject: Biology",
    "Subcategory: Cell Biology",
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
  const questionId = (await triviaStore.listQuestions())[0].id;
  const editedBlock = block.replace("Which organelle modifies and packages proteins?", "Which organelle sorts and packages proteins?");
  await trivia.run({ ...baseContext, owner: true, args: "edit " + questionId + "\n" + editedBlock });
  assert.match(replies.at(-1), /updated in the official bank/);

  await trivia.run({
    ...baseContext,
    owner: false,
    senderJid: "2348000000002@s.whatsapp.net",
    args: "start"
  });
  assert.match(sent.at(-1).payload.text, /STEP 1 — CHOOSE A SUBJECT/);
  assert.equal(await triviaEngine.handleSetupReply({
    groupJid,
    senderJid: "2348000000002@s.whatsapp.net",
    text: "1"
  }), true);
  assert.match(sent.at(-1).payload.text, /ALL TOPICS/);
  assert.equal(await triviaEngine.handleSetupReply({
    groupJid,
    senderJid: "2348000000002@s.whatsapp.net",
    text: "1"
  }), true);
  assert.match(sent.at(-1).payload.text, /NUMBER OF QUESTIONS/);
  assert.equal(await triviaEngine.handleSetupReply({
    groupJid,
    senderJid: "2348000000002@s.whatsapp.net",
    text: "10"
  }), true);
  assert.match(sent.at(-1).payload.text, /Question:\* 1\/1/);
  assert.equal(await triviaEngine.handleAnswer({
    groupJid,
    senderJid: "2348000000004@s.whatsapp.net",
    name: "Quiz Winner",
    answer: "B"
  }), true);
  assert.equal(sent.some(item => item.payload.text.includes("FINAL LEADERBOARD")), true);
  assert.equal(sent.some(item => item.payload.text.includes("Quiz Winner") && item.payload.text.includes("1 pts")), true);

  assert.equal(triviaEngine.getActiveGame(groupJid), null);
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTriviaStore } from "../lib/trivia-store.js";
import { createTriviaEngine } from "../lib/trivia-engine.js";

const groupJid = "120363012345678901-123456@g.us";

function question(index, answer = "B") {
  return {
    subject: "Biology",
    subcategory: "Cell Biology",
    difficulty: index === 1 ? "hard" : "easy",
    question: "Test question " + index + "?",
    options: { A: "First", B: "Second", C: "Third", D: "Fourth" },
    answer,
    explanation: "Verified explanation " + index + "."
  };
}

async function setup(count = 2) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tolu-trivia-engine-"));
  const store = createTriviaStore({ filePath: path.join(directory, "trivia.json") });
  await store.addQuestions(Array.from({ length: count }, (_, index) => question(index + 1)));
  await store.updateSettings({ questionCount: count, startCooldownMs: 10000 });
  const timers = [];
  const engine = createTriviaEngine({
    store,
    minOutgoingGapMs: 0,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel: timer => { if (timer) timer.cancelled = true; }
  });
  const sent = [];
  const send = async payload => sent.push(payload.text);
  return { directory, store, engine, timers, sent, send };
}

test("starts one group competition and sends the first question", async () => {
  const state = await setup(2);
  try {
    const result = await state.engine.startGame({
      groupJid,
      subjects: ["Biology"],
      count: 2,
      send: state.send
    });
    assert.equal(result.ok, true);
    assert.equal(result.questionCount, 2);
    assert.equal(state.sent.length, 1);
    assert.match(state.sent[0], /TRIVIA/);
    assert.match(state.sent[0], /Question:\* 1\/2/);
    assert.match(state.sent[0], /Reply A, B, C or D/);
    assert.equal(state.engine.getActiveGame(groupJid).questionNumber, 1);

    const duplicate = await state.engine.startGame({ groupJid, subjects: ["Biology"], send: state.send });
    assert.equal(duplicate.reason, "already_running");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("each player gets one attempt per question and the first correct answer earns points", async () => {
  const state = await setup(1);
  try {
    await state.engine.startGame({ groupJid, subjects: ["Biology"], count: 1, send: state.send });
    assert.equal(await state.engine.handleAnswer({
      groupJid, senderJid: "2348000000001@s.whatsapp.net", name: "Wrong Player", answer: "A"
    }), true);
    assert.equal(await state.engine.handleAnswer({
      groupJid, senderJid: "2348000000001@s.whatsapp.net", name: "Wrong Player", answer: "B"
    }), true);
    assert.equal(state.engine.getActiveGame(groupJid).participantCount, 1);
    assert.equal(state.engine.getActiveGame(groupJid).scores[0].points, 0);

    await state.engine.handleAnswer({
      groupJid, senderJid: "2348000000002@s.whatsapp.net", name: "Winner", answer: "B"
    });
    assert.equal(state.sent.some(text => text.includes("Winner")), true);
    assert.equal(state.sent.some(text => text.includes("+3")), true);
    assert.equal(state.sent.some(text => text.includes("FINAL LEADERBOARD")), true);
    assert.equal(state.sent.some(text => text.includes("Winner") && text.includes("3 pts")), true);
    assert.equal(state.engine.getActiveGame(groupJid), null);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("any group participant can stop a running game and receives only that game's leaderboard", async () => {
  const state = await setup(2);
  try {
    await state.engine.startGame({ groupJid, subjects: ["Biology"], count: 2, send: state.send });
    await state.engine.handleAnswer({
      groupJid, senderJid: "2348000000002@s.whatsapp.net", name: "Winner", answer: "B"
    });
    assert.ok(state.engine.getActiveGame(groupJid));
    assert.equal(await state.engine.stopGame(groupJid), true);
    assert.equal(state.engine.getActiveGame(groupJid), null);
    assert.equal(state.sent.some(text => text.includes("COMPETITION STOPPED")), true);
    assert.equal(await state.engine.stopGame(groupJid), false);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("answers outside an active game are ignored and start cooldown is enforced", async () => {
  const state = await setup(2);
  try {
    assert.equal(await state.engine.handleAnswer({
      groupJid, senderJid: "2348000000002@s.whatsapp.net", answer: "A"
    }), false);
    await state.engine.startGame({ groupJid, subjects: ["Biology"], count: 1, send: state.send });
    await state.engine.stopGame(groupJid);
    const next = await state.engine.startGame({
      groupJid, subjects: ["Biology"], count: 1, send: state.send
    });
    assert.equal(next.reason, "cooldown");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("a question pool smaller than the requested count is reduced without duplicates", async () => {
  const state = await setup(2);
  try {
    const result = await state.engine.startGame({
      groupJid, subjects: ["Biology"], count: 10, send: state.send
    });
    assert.equal(result.ok, true);
    assert.equal(result.questionCount, 2);
    assert.equal(result.reduced, true);
    assert.equal(new Set(state.engine.getActiveGame(groupJid).scores.map(item => item.id)).size, 0);
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

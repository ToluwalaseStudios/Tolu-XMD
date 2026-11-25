import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTriviaStore, normalizeTriviaQuestion } from "../lib/trivia-store.js";

function question(index, overrides = {}) {
  return {
    subject: "Biology",
    subcategory: "Cell Biology",
    difficulty: "hard",
    question: "Question " + index + "?",
    options: { A: "Option A", B: "Option B", C: "Option C", D: "Option D" },
    answer: "B",
    explanation: "Because B is correct.",
    ...overrides
  };
}

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tolu-trivia-store-"));
  try {
    const store = createTriviaStore({ filePath: path.join(directory, "trivia.json") });
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("normalizes a question and validates its four options and answer", () => {
  const normalized = normalizeTriviaQuestion(question(1));
  assert.equal(normalized.subject, "Biology");
  assert.equal(normalized.subcategory, "Cell Biology");
  assert.equal(normalized.difficulty, "hard");
  assert.deepEqual(Object.keys(normalized.options), ["A", "B", "C", "D"]);
  assert.equal(normalized.answer, "B");
  assert.ok(normalized.id);
  assert.ok(normalized.fingerprint);

  assert.throws(() => normalizeTriviaQuestion(question(2, { answer: "E" })), /A, B, C or D/);
  assert.throws(() => normalizeTriviaQuestion(question(3, { options: ["A", "B"] })), /exactly four/);
  assert.throws(() => normalizeTriviaQuestion(question(4, { difficulty: "impossible" })), /Difficulty/);
});

test("group activation is persisted and validates group JIDs", async () => {
  await withStore(async store => {
    const jid = "120363012345678901-123456@g.us";
    assert.equal(await store.isGroupEnabled(jid), false);
    await store.setGroupEnabled(jid, true);
    assert.equal(await store.isGroupEnabled(jid), true);
    assert.deepEqual(await store.listEnabledGroups(), [jid]);
    await store.setGroupEnabled(jid, false);
    assert.equal(await store.isGroupEnabled(jid), false);
    await assert.rejects(() => store.setGroupEnabled("2348000000000@s.whatsapp.net", true), /only be changed inside/);
  });
});

test("question bank adds questions and rejects duplicate content without losing entries", async () => {
  await withStore(async store => {
    const result = await store.addQuestions([question(1), question(2), question(1)]);
    assert.equal(result.added, 2);
    assert.equal(result.duplicates, 1);
    assert.equal((await store.listQuestions()).length, 2);
    assert.equal((await store.getStats()).questionCount, 2);
    const removed = await store.removeQuestion(result.ids[0]);
    assert.equal(removed, true);
    assert.equal(await store.removeQuestion(result.ids[0]), false);
    assert.equal((await store.listQuestions()).length, 1);
  });
});

test("questions can be edited without changing their stable ID", async () => {
  await withStore(async store => {
    const added = await store.addQuestions(question(1));
    const id = added.ids[0];
    const updated = await store.updateQuestion(id, question(1, {
      question: "Updated question text?",
      difficulty: "expert"
    }));
    assert.equal(updated, true);
    const saved = (await store.listQuestions())[0];
    assert.equal(saved.id, id);
    assert.equal(saved.question, "Updated question text?");
    assert.equal(saved.difficulty, "expert");
    assert.equal(await store.updateQuestion("missing-id", question(2)), false);
  });
});

test("category listing exposes custom subjects and subcategories", async () => {
  await withStore(async store => {
    await store.addQuestions([
      question(1),
      question(2, { subcategory: "Genetics" }),
      question(3, { subject: "Chemistry", subcategory: "Organic Chemistry" })
    ]);
    assert.deepEqual(await store.getCategories(), [
      { name: "Biology", subcategories: ["Cell Biology", "Genetics"] },
      { name: "Chemistry", subcategories: ["Organic Chemistry"] }
    ]);
    assert.equal((await store.listQuestions({ subject: "biology" })).length, 2);
  });
});

test("question usage is independent per group and avoids repeats until a cycle is exhausted", async () => {
  await withStore(async store => {
    const groupA = "120363012345678901-123456@g.us";
    const groupB = "120363012345678901-654321@g.us";
    await store.addQuestions(Array.from({ length: 5 }, (_, index) => question(index + 1)));

    const first = await store.selectQuestions({ groupJid: groupA, subjects: ["Biology"], count: 3 });
    const second = await store.selectQuestions({ groupJid: groupA, subjects: ["Biology"], count: 2 });
    const third = await store.selectQuestions({ groupJid: groupA, subjects: ["Biology"], count: 3 });
    const otherGroup = await store.selectQuestions({ groupJid: groupB, subjects: ["Biology"], count: 3 });

    const firstIds = new Set(first.questions.map(item => item.id));
    assert.equal(firstIds.size, 3);
    assert.equal(second.questions.length, 2);
    assert.equal(second.questions.some(item => firstIds.has(item.id)), false);
    assert.equal(third.questions.length, 3);
    assert.equal(new Set(third.questions.map(item => item.id)).size, 3);
    assert.equal(otherGroup.questions.length, 3);
    assert.equal(otherGroup.questions.some(item => firstIds.has(item.id)), true);
  });
});

test("question usage carries across mixed-subject and single-subject competitions", async () => {
  await withStore(async store => {
    const group = "120363012345678901-123456@g.us";
    await store.addQuestions([
      question(1, { subject: "Biology" }),
      question(2, { subject: "Biology" }),
      question(3, { subject: "Chemistry" }),
      question(4, { subject: "Chemistry" }),
      question(5, { subject: "Physics" })
    ]);
    const first = await store.selectQuestions({ groupJid: group, subjects: ["Biology"], count: 1 });
    const usedId = first.questions[0].id;
    const mixed = await store.selectQuestions({
      groupJid: group,
      subjects: ["Biology", "Chemistry", "Physics"],
      count: 4
    });
    assert.equal(mixed.questions.length, 4);
    assert.equal(mixed.questions.some(item => item.id === usedId), false);
  });
});

test("question selection filters difficulty and reports when the bank is smaller than requested", async () => {
  await withStore(async store => {
    const group = "120363012345678901-123456@g.us";
    await store.addQuestions([
      question(1, { difficulty: "easy" }),
      question(2, { difficulty: "hard" }),
      question(3, { difficulty: "expert" })
    ]);
    const result = await store.selectQuestions({
      groupJid: group,
      subjects: ["Biology"],
      difficulty: "hard",
      count: 10
    });
    assert.equal(result.available, 1);
    assert.equal(result.questions.length, 1);
    assert.equal(result.reduced, true);
    assert.equal(result.questions[0].difficulty, "hard");
  });
});

test("Trivia settings are bounded and persisted", async () => {
  await withStore(async store => {
    const updated = await store.updateSettings({ questionCount: 20, secondsPerQuestion: 15 });
    assert.equal(updated.questionCount, 20);
    assert.equal(updated.secondsPerQuestion, 15);
    assert.equal((await store.getSettings()).questionCount, 20);
    await assert.rejects(() => store.updateSettings({ secondsPerQuestion: 2 }), /between 10 and 60/);
    await assert.rejects(() => store.updateSettings({ unknown: 1 }), /Unknown Trivia setting/);
  });
});

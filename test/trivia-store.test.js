import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  assert.equal(Object.hasOwn(normalized, "difficulty"), false);
  assert.deepEqual(Object.keys(normalized.options), ["A", "B", "C", "D"]);
  assert.equal(normalized.answer, "B");
  assert.ok(normalized.id);
  assert.ok(normalized.fingerprint);

  assert.throws(() => normalizeTriviaQuestion(question(2, { answer: "E" })), /A, B, C or D/);
  assert.throws(() => normalizeTriviaQuestion(question(3, { options: ["A", "B"] })), /exactly four/);
  assert.equal(Object.hasOwn(normalizeTriviaQuestion(question(4, { difficulty: "impossible" })), "difficulty"), false);
});

test("legacy all-time usage is migrated safely to previous-quiz rotation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tolu-trivia-migration-"));
  try {
    const filePath = path.join(directory, "trivia.json");
    await writeFile(filePath, JSON.stringify({
      version: 1,
      enabledGroups: [],
      questions: [],
      questionUsage: { "120363012345678901-123456@g.us": ["legacy-used-id"] },
      settings: {}
    }));
    const store = createTriviaStore({ filePath });
    await store.addQuestions([question(1), question(2)]);
    const group = "120363012345678901-123456@g.us";
    const selected = await store.selectQuestions({ groupJid: group, subjects: ["Biology"], count: 2 });
    assert.equal(selected.questions.length, 2);
    const migrated = await store.load();
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.questionUsage, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    const modernJid = "120363012345678901@g.us";
    await store.setGroupEnabled(modernJid, true);
    assert.equal(await store.isGroupEnabled(modernJid), true);
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

test("bulk deletion removes questions by subject, topic or explicit IDs and cleans rotation history", async () => {
  await withStore(async store => {
    const group = "120363012345678901-123456@g.us";
    const added = await store.addQuestions([
      question(1),
      question(2, { subcategory: "Genetics" }),
      question(3, { subject: "Chemistry", subcategory: "Organic Chemistry" })
    ]);
    await store.recordQuestionsUsed({ groupJid: group, questionIds: added.ids });
    const topicResult = await store.removeQuestions({ subject: "biology", subcategory: "cell biology" });
    assert.equal(topicResult.removed, 1);
    assert.equal((await store.listQuestions()).length, 2);
    assert.deepEqual((await store.load()).questionUsage[group].sort(), added.ids.slice(1).sort());

    const idResult = await store.removeQuestions({ ids: [added.ids[1], "not-present"] });
    assert.equal(idResult.removed, 1);
    const subjectResult = await store.removeQuestions({ subject: "CHEMISTRY" });
    assert.equal(subjectResult.removed, 1);
    assert.equal((await store.getStats()).questionCount, 0);
    await assert.rejects(() => store.removeQuestions({}), /Choose question IDs/);
    await assert.rejects(() => store.removeQuestions({ subcategory: "Cell Biology" }), /must also specify its subject/);
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
    assert.equal(Object.hasOwn(saved, "difficulty"), false);
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

test("question usage is independent per group and refers only to the previous completed quiz", async () => {
  await withStore(async store => {
    const groupA = "120363012345678901-123456@g.us";
    const groupB = "120363012345678901-654321@g.us";
    await store.addQuestions(Array.from({ length: 5 }, (_, index) => question(index + 1)));

    const first = await store.selectQuestions({ groupJid: groupA, subjects: ["Biology"], count: 3 });
    await store.recordQuestionsUsed({ groupJid: groupA, questionIds: first.questions.map(item => item.id) });
    const second = await store.selectQuestions({ groupJid: groupA, subjects: ["Biology"], count: 2 });
    const firstIds = new Set(first.questions.map(item => item.id));
    assert.equal(second.questions.length, 2);
    assert.equal(second.questions.some(item => firstIds.has(item.id)), false);

    await store.recordQuestionsUsed({ groupJid: groupA, questionIds: second.questions.map(item => item.id) });
    const third = await store.selectQuestions({ groupJid: groupA, subjects: ["Biology"], count: 3 });
    const secondIds = new Set(second.questions.map(item => item.id));
    assert.equal(third.questions.length, 3);
    assert.equal(third.questions.some(item => secondIds.has(item.id)), false);
    assert.equal(new Set(third.questions.map(item => item.id)).size, 3);

    const otherGroup = await store.selectQuestions({ groupJid: groupB, subjects: ["Biology"], count: 3 });
    assert.equal(otherGroup.questions.length, 3);
    assert.equal(otherGroup.questions.some(item => firstIds.has(item.id)), true);
  });
});


test("questions absent from the last concluded quiz are used first, then older questions fill the remainder", async () => {
  await withStore(async store => {
    const group = "120363012345678901-123456@g.us";
    await store.addQuestions(Array.from({ length: 32 }, (_, index) => question(index + 1)));
    const firstQuiz = await store.selectQuestions({ groupJid: group, subjects: ["Biology"], count: 20 });
    assert.equal(firstQuiz.questions.length, 20);

    // Selecting a game must not consume its questions until it concludes.
    await store.selectQuestions({ groupJid: group, subjects: ["Biology"], count: 20 });
    const beforeConclusion = await store.load();
    assert.equal(beforeConclusion.questionUsage[group], undefined);

    await store.recordQuestionsUsed({
      groupJid: group,
      questionIds: firstQuiz.questions.map(item => item.id)
    });

    const nextQuiz = await store.selectQuestions({ groupJid: group, subjects: ["Biology"], count: 20 });
    const previousIds = new Set(firstQuiz.questions.map(item => item.id));
    const fresh = nextQuiz.questions.filter(item => !previousIds.has(item.id));
    const repeated = nextQuiz.questions.filter(item => previousIds.has(item.id));
    assert.equal(nextQuiz.questions.length, 20);
    assert.equal(fresh.length, 12);
    assert.equal(repeated.length, 8);
    assert.equal(new Set(nextQuiz.questions.map(item => item.id)).size, 20);
    assert.equal(nextQuiz.questions.slice(0, 12).every(item => !previousIds.has(item.id)), true);
  });
});

test("a bank smaller than the requested quiz is the only reason to reduce question count", async () => {
  await withStore(async store => {
    const group = "120363012345678901-123456@g.us";
    await store.addQuestions(Array.from({ length: 20 }, (_, index) => question(index + 1)));
    const result = await store.selectQuestions({ groupJid: group, subjects: ["Biology"], count: 50 });
    assert.equal(result.questions.length, 20);
    assert.equal(result.available, 20);
    assert.equal(result.reduced, true);
    assert.equal(new Set(result.questions.map(item => item.id)).size, 20);
  });
});

test("legacy difficulty values are ignored and all topic questions remain eligible", async () => {
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
      count: 10
    });
    assert.equal(result.available, 3);
    assert.equal(result.questions.length, 3);
    assert.equal(result.questions.every(item => !Object.hasOwn(item, "difficulty")), true);
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

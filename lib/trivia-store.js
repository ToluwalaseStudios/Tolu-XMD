import { randomUUID, randomInt, createHash } from "node:crypto";
import path from "node:path";
import { createJsonStateStore } from "./state-store.js";

export const TRIVIA_DIFFICULTIES = Object.freeze(["easy", "medium", "hard", "expert"]);
export const TRIVIA_DEFAULT_SETTINGS = Object.freeze({
  questionCount: 10,
  secondsPerQuestion: 25,
  interQuestionDelayMs: 3000,
  startCooldownMs: 30000
});

const MAX_QUESTIONS = 10000;
const MAX_TEXT_LENGTH = 2000;
const MAX_OPTION_LENGTH = 300;

function cleanText(value, label, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(label + " is required.");
  if (text.length > maxLength) throw new Error(label + " is too long (maximum " + maxLength + " characters).");
  return text;
}

function normalizeDifficulty(value) {
  const difficulty = String(value || "medium").trim().toLowerCase();
  if (!TRIVIA_DIFFICULTIES.includes(difficulty)) {
    throw new Error("Difficulty must be Easy, Medium, Hard or Expert.");
  }
  return difficulty;
}

function optionMap(value) {
  const keys = ["A", "B", "C", "D"];
  if (Array.isArray(value)) {
    if (value.length !== 4) throw new Error("Every question must have exactly four options.");
    return Object.fromEntries(keys.map((key, index) => [key, cleanText(value[index], "Option " + key, MAX_OPTION_LENGTH)]));
  }
  if (!value || typeof value !== "object") throw new Error("Provide four options labelled A, B, C and D.");
  return Object.fromEntries(keys.map(key => [
    key,
    cleanText(value[key] ?? value[key.toLowerCase()], "Option " + key, MAX_OPTION_LENGTH)
  ]));
}

export function normalizeTriviaQuestion(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Each question must be a JSON object.");
  }
  const subject = cleanText(raw.subject ?? raw.topic, "Subject", 80);
  const subcategory = String(raw.subcategory ?? raw.topicCategory ?? "General").trim().slice(0, 80) || "General";
  const question = cleanText(raw.question ?? raw.q, "Question");
  const options = optionMap(raw.options ?? {
    A: raw.A ?? raw.optionA,
    B: raw.B ?? raw.optionB,
    C: raw.C ?? raw.optionC,
    D: raw.D ?? raw.optionD
  });
  const answer = String(raw.answer ?? raw.correctAnswer ?? raw.correct ?? "").trim().toUpperCase();
  if (!["A", "B", "C", "D"].includes(answer)) {
    throw new Error("The correct answer must be A, B, C or D.");
  }
  const explanation = String(raw.explanation ?? raw.explain ?? "").trim().slice(0, 1200);
  const difficulty = normalizeDifficulty(raw.difficulty);
  const fingerprint = createHash("sha256")
    .update([subject.toLowerCase(), subcategory.toLowerCase(), question.toLowerCase().replace(/\s+/g, " ")].join("\u0000"))
    .digest("hex");
  return {
    id: String(raw.id || randomUUID()).slice(0, 80),
    subject,
    subcategory,
    difficulty,
    question,
    options,
    answer,
    explanation,
    fingerprint
  };
}

function normalizeGroupJid(value) {
  const jid = String(value || "").trim().toLowerCase();
  if (!/^\d{5,30}(?:-\d{1,25})?@g\.us$/.test(jid)) {
    throw new Error("Trivia group settings can only be changed inside a WhatsApp group.");
  }
  return jid;
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function matches(value, wanted) {
  return !wanted || String(value || "").toLowerCase() === String(wanted).toLowerCase();
}

export function createTriviaStore({ filePath } = {}) {
  const dataDirectory = path.resolve(
    process.env.TOLUWALASE_DATA_DIR || process.env.FEI_DATA_DIR || "./data"
  );
  const store = createJsonStateStore({
    filePath: filePath || path.join(dataDirectory, "trivia-arena.json"),
    defaults: {
      version: 1,
      enabledGroups: [],
      questions: [],
      questionUsage: {},
      settings: { ...TRIVIA_DEFAULT_SETTINGS }
    }
  });

  async function isGroupEnabled(groupJid) {
    const jid = normalizeGroupJid(groupJid);
    const state = await store.load();
    return state.enabledGroups.includes(jid);
  }

  async function setGroupEnabled(groupJid, enabled) {
    const jid = normalizeGroupJid(groupJid);
    await store.update(state => {
      if (!Array.isArray(state.enabledGroups)) state.enabledGroups = [];
      const groups = new Set(state.enabledGroups);
      if (enabled) groups.add(jid);
      else groups.delete(jid);
      state.enabledGroups = [...groups].sort();
    });
    return Boolean(enabled);
  }

  async function listEnabledGroups() {
    const state = await store.load();
    return Array.isArray(state.enabledGroups) ? [...state.enabledGroups] : [];
  }

  async function addQuestions(input) {
    const incoming = Array.isArray(input) ? input : [input];
    if (!incoming.length) throw new Error("No questions were supplied.");
    const normalized = incoming.map(normalizeTriviaQuestion);
    return store.update(state => {
      if (!Array.isArray(state.questions)) state.questions = [];
      const known = new Set(state.questions.map(item => item.fingerprint).filter(Boolean));
      const ids = new Set(state.questions.map(item => item.id));
      const added = [];
      let duplicates = 0;
      for (const question of normalized) {
        if (known.has(question.fingerprint)) {
          duplicates += 1;
          continue;
        }
        if (ids.has(question.id)) question.id = randomUUID();
        known.add(question.fingerprint);
        ids.add(question.id);
        added.push(question);
      }
      if (state.questions.length + added.length > MAX_QUESTIONS) {
        throw new Error("The question bank limit is " + MAX_QUESTIONS + " questions.");
      }
      state.questions.push(...added);
      return { added: added.length, duplicates, ids: added.map(item => item.id) };
    });
  }

  async function removeQuestion(id) {
    const target = String(id || "").trim();
    if (!target) throw new Error("Provide a question ID.");
    return store.update(state => {
      const before = state.questions.length;
      state.questions = state.questions.filter(item => item.id !== target);
      return before !== state.questions.length;
    });
  }

  async function updateQuestion(id, raw) {
    const target = String(id || "").trim();
    if (!target) throw new Error("Provide a question ID.");
    const normalized = normalizeTriviaQuestion({ ...raw, id: target });
    return store.update(state => {
      const index = state.questions.findIndex(item => item.id === target);
      if (index < 0) return false;
      const duplicate = state.questions.some((item, itemIndex) =>
        itemIndex !== index && item.fingerprint === normalized.fingerprint
      );
      if (duplicate) throw new Error("Another question already has the same subject, subcategory and question text.");
      state.questions[index] = normalized;
      return true;
    });
  }


  async function listQuestions(filters = {}) {
    const state = await store.load();
    return (state.questions || []).filter(item =>
      matches(item.subject, filters.subject) &&
      matches(item.subcategory, filters.subcategory) &&
      matches(item.difficulty, filters.difficulty)
    );
  }

  async function getCategories() {
    const questions = await listQuestions();
    const subjects = new Map();
    for (const question of questions) {
      const key = question.subject.toLowerCase();
      if (!subjects.has(key)) subjects.set(key, { name: question.subject, subcategories: new Set() });
      subjects.get(key).subcategories.add(question.subcategory);
    }
    return [...subjects.values()]
      .map(item => ({ name: item.name, subcategories: [...item.subcategories].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getSettings() {
    const state = await store.load();
    return { ...TRIVIA_DEFAULT_SETTINGS, ...(state.settings || {}) };
  }

  async function updateSettings(patch = {}) {
    const current = await getSettings();
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in TRIVIA_DEFAULT_SETTINGS)) throw new Error("Unknown Trivia setting: " + key);
      const number = Number(value);
      if (!Number.isInteger(number)) throw new Error("Trivia settings must be whole numbers.");
      const bounds = {
        questionCount: [1, 50],
        secondsPerQuestion: [10, 60],
        interQuestionDelayMs: [1000, 10000],
        startCooldownMs: [10000, 300000]
      }[key];
      if (number < bounds[0] || number > bounds[1]) {
        throw new Error(key + " must be between " + bounds[0] + " and " + bounds[1] + ".");
      }
      next[key] = number;
    }
    await store.set("settings", next);
    return next;
  }

  async function selectQuestions({ groupJid, subjects = [], subcategory = "", difficulty = "mixed", count = 10 } = {}) {
    const jid = normalizeGroupJid(groupJid);
    const wantedSubjects = (Array.isArray(subjects) ? subjects : [subjects])
      .map(value => String(value || "").trim().toLowerCase()).filter(Boolean);
    const wantedDifficulty = String(difficulty || "mixed").toLowerCase();
    if (wantedDifficulty !== "mixed" && !TRIVIA_DIFFICULTIES.includes(wantedDifficulty)) {
      throw new Error("Choose Easy, Medium, Hard, Expert or Mixed difficulty.");
    }
    const requestedCount = Number(count);
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 50) {
      throw new Error("A Trivia competition must contain between 1 and 50 questions.");
    }

    return store.update(state => {
      const pool = (state.questions || []).filter(question =>
        (!wantedSubjects.length || wantedSubjects.includes(question.subject.toLowerCase())) &&
        (!subcategory || matches(question.subcategory, subcategory)) &&
        (wantedDifficulty === "mixed" || question.difficulty === wantedDifficulty)
      );
      if (!pool.length) return { questions: [], available: 0, requested: requestedCount, reduced: false };

      const actualCount = Math.min(requestedCount, pool.length);
      const usageKey = jid;
      if (!state.questionUsage || typeof state.questionUsage !== "object") state.questionUsage = {};
      const previouslyUsed = new Set(Array.isArray(state.questionUsage[usageKey])
        ? state.questionUsage[usageKey] : []);
      const poolIds = new Set(pool.map(question => question.id));
      const unused = shuffle(pool.filter(question => !previouslyUsed.has(question.id)));
      let selected = unused.slice(0, actualCount);
      let nextUsed = new Set([...previouslyUsed, ...selected.map(question => question.id)]);

      // If this selected pool is exhausted, restart only that pool's cycle.
      // Usage from other subjects remains intact for later mixed competitions.
      if (selected.length < actualCount) {
        const selectedIds = new Set(selected.map(question => question.id));
        const preservedOtherSubjects = [...previouslyUsed].filter(id => !poolIds.has(id));
        const freshCycle = shuffle(pool.filter(question => !selectedIds.has(question.id)));
        const wrapped = freshCycle.slice(0, actualCount - selected.length);
        selected = [...selected, ...wrapped];
        nextUsed = new Set([...preservedOtherSubjects, ...selected.map(question => question.id)]);
      }

      state.questionUsage[usageKey] = [...nextUsed];
      return {
        questions: selected,
        available: pool.length,
        requested: requestedCount,
        reduced: actualCount < requestedCount
      };
    });
  }

  async function getStats() {
    const state = await store.load();
    const questions = state.questions || [];
    return {
      questionCount: questions.length,
      enabledGroupCount: (state.enabledGroups || []).length,
      subjects: [...new Set(questions.map(item => item.subject))].sort()
    };
  }

  return {
    isGroupEnabled,
    setGroupEnabled,
    listEnabledGroups,
    addQuestions,
    removeQuestion,
    updateQuestion,
    listQuestions,
    getCategories,
    getSettings,
    updateSettings,
    selectQuestions,
    getStats,
    load: () => store.load(),
    flush: () => store.flush(),
    filePath: store.filePath
  };
}

export const triviaStore = createTriviaStore();

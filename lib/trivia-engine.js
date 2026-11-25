import { triviaStore } from "./trivia-store.js";
import { formatTriviaMath } from "./trivia-math-format.js";

const MIN_OUTGOING_GAP_MS = 1200;

function cleanName(value) {
  return String(value || "Participant").replace(/[\r\n\t@]/g, " ").trim().slice(0, 32) || "Participant";
}

function formatQuestion(session, question, index) {
  const lines = [
    "╭━━〔 🧠 𝕿𝖔𝖑𝖚𝖜𝖆𝖑𝖆𝖘𝖊 𝐓𝐑𝐈𝐕𝐈𝐀 〕━━┈⊷",
    "┃ ➣ *Category:* " + question.subject + " · " + question.subcategory,
    "┃ ➣ *Question:* " + (index + 1) + "/" + session.questions.length,
    "┃",
    "┃ *" + formatTriviaMath(question.question) + "*",
    "┃",
    "┃ *A.* " + formatTriviaMath(question.options.A),
    "┃ *B.* " + formatTriviaMath(question.options.B),
    "┃ *C.* " + formatTriviaMath(question.options.C),
    "┃ *D.* " + formatTriviaMath(question.options.D),
    "╰━━━━━━━━━━━━━━━━━━⬣",
    "",
    "> Reply A, B, C or D · one try · " + session.secondsPerQuestion + "s"
  ];
  if (session.reduced) {
    lines.splice(lines.length - 1, 0,
      "┃ ⚠️ Bank has only " + session.questions.length + " approved questions; game size adjusted to avoid repeats.");
  }
  return lines.join("\n");
}

function formatExplanation(question) {
  return question.explanation ? "\n\n*Explanation:* " + formatTriviaMath(question.explanation) : "";
}

function leaderboardText(session, status = "COMPLETED") {
  const rows = [...session.scores.values()].sort((a, b) =>
    b.points - a.points ||
    b.correctAnswers - a.correctAnswers ||
    b.questionsWon - a.questionsWon ||
    a.lastScoredAt - b.lastScoredAt ||
    a.name.localeCompare(b.name)
  );
  const lines = [
    "╭━━〔 🏆 𝕿𝖔𝖑𝖚𝖜𝖆𝖑𝖆𝖘𝖊 𝐓𝐑𝐈𝐕𝐈𝐀 〕━━┈⊷",
    "┃ *" + (status === "STOPPED" ? "COMPETITION STOPPED" : "FINAL LEADERBOARD") + "*",
    "┃ ➣ *Quiz:* " + session.label,
    "┃ ➣ *Questions:* " + session.completedQuestions + "/" + session.questions.length,
    "┃ ➣ *Participants:* " + session.scores.size,
    "╰━━━━━━━━━━━━━━━━━━⬣",
    ""
  ];

  if (!rows.length) {
    lines.push("No points were earned in this competition.");
  } else {
    lines.push("*RANKINGS*");
    rows.slice(0, 20).forEach((player, index) => {
      const medal = ["🥇", "🥈", "🥉"][index] || String(index + 1) + ".";
      lines.push(medal + " *" + player.name + "* — " + player.points + " pts");
    });
    if (rows.length > 20) lines.push("_And " + (rows.length - 20) + " more participants._");
  }

  lines.push("", "> This leaderboard belongs to this competition only.");
  lines.push("⚡ POWERED BY TOLUWALASE STUDIOS");
  return lines.join("\n");
}

export function createTriviaEngine({
  store = triviaStore,
  now = () => Date.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
  minOutgoingGapMs = MIN_OUTGOING_GAP_MS
} = {}) {
  const activeGames = new Map();
  const lastStartedAt = new Map();
  const setupSessions = new Map();

  function enqueueSend(session, content, allowClosed = false) {
    session.sendQueue = session.sendQueue.then(async () => {
      const wait = Math.max(0, minOutgoingGapMs - (now() - session.lastSentAt));
      if (wait > 0) await new Promise(resolve => {
        schedule(resolve, wait);
      });
      if (session.closed && !allowClosed) return;
      await session.send({ text: content });
      session.lastSentAt = now();
    });
    return session.sendQueue;
  }

  function clearSessionTimer(session) {
    if (session.timer) cancel(session.timer);
    session.timer = null;
  }

  async function finish(session, status) {
    if (!session || session.closed) return false;
    session.closed = true;
    clearSessionTimer(session);
    if (activeGames.get(session.groupJid) === session) activeGames.delete(session.groupJid);
    if (status === "COMPLETED" && session.askedQuestionIds.length) {
      try {
        await store.recordQuestionsUsed({
          groupJid: session.groupJid,
          questionIds: session.askedQuestionIds
        });
      } catch {
        // Keep the game result available even if rotation persistence fails.
      }
    }
    try {
      await enqueueSend(session, leaderboardText(session, status), true);
    } catch {
      // The session is already closed. A transient WhatsApp send error must not
      // leave a ghost game that blocks the next competition.
    }
    return true;
  }

  async function sendCurrentQuestion(session) {
    if (session.closed) return false;
    const question = session.questions[session.index];
    if (!question) { await finish(session, "COMPLETED"); return false; }

    session.attempted = new Set();
    session.solved = false;
    try {
      await enqueueSend(session, formatQuestion(session, question, session.index));
      session.askedQuestionIds.push(question.id);
    } catch {
      await finish(session, "STOPPED");
      return false;
    }

    if (session.closed || session.solved) return false;
    session.timer = schedule(() => {
      void handleTimeout(session);
    }, session.secondsPerQuestion * 1000);
    session.timer?.unref?.();
    return true;
  }

  async function advance(session) {
    if (session.closed) return;
    session.index += 1;
    if (session.index >= session.questions.length) {
      await finish(session, "COMPLETED");
      return;
    }
    session.timer = schedule(() => {
      void sendCurrentQuestion(session);
    }, session.interQuestionDelayMs);
    session.timer?.unref?.();
  }

  async function handleTimeout(session) {
    if (session.closed || session.solved) return;
    session.solved = true;
    clearSessionTimer(session);
    const question = session.questions[session.index];
    const result = "╭━━〔 ⏰ 𝐓𝐈𝐌𝐄'𝐒 𝐔𝐏 〕━━┈⊷\n" +
      "┃ ➣ *Answer:* " + question.answer + " — " + formatTriviaMath(question.options[question.answer]) +
      formatExplanation(question) +
      "\n╰━━━━━━━━━━━━━━━━━━⬣";
    try {
      await enqueueSend(session, result);
      session.completedQuestions += 1;
      await advance(session);
    } catch {
      await finish(session, "STOPPED");
    }
  }


  function setupKey(groupJid, senderJid) {
    return String(groupJid || "").trim().toLowerCase() + "|" + String(senderJid || "").trim();
  }

  async function beginSetup({ groupJid, senderJid, send } = {}) {
    const jid = String(groupJid || "").trim().toLowerCase();
    const player = String(senderJid || "").trim();
    if (!jid.endsWith("@g.us") || !player || typeof send !== "function") {
      return { ok: false, reason: "invalid_setup" };
    }
    if (activeGames.has(jid)) return { ok: false, reason: "already_running" };
    const categories = await store.getCategories();
    if (!categories.length) return { ok: false, reason: "empty_bank" };
    setupSessions.set(setupKey(jid, player), {
      groupJid: jid, senderJid: player, send, stage: "subject",
      categories, expiresAt: now() + 180000
    });
    const lines = [
      "╭━━〔 🧠 𝐓𝐑𝐈𝐕𝐈𝐀 𝐐𝐔𝐈𝐙 𝐒𝐄𝐓𝐔𝐏 〕━━┈⊷",
      "┃ *STEP 1 — CHOOSE A SUBJECT*",
      "┃ Reply with the number beside your subject:"
    ];
    categories.forEach((item, index) => lines.push("┃ " + (index + 1) + ". " + item.name));
    lines.push("╰━━━━━━━━━━━━━━━━━━⬣", "", "You have 3 minutes to complete the setup. Send *cancel* to exit.");
    await send({ text: lines.join("\n") });
    return { ok: true };
  }

  async function handleSetupReply({ groupJid, senderJid, text, name } = {}) {
    const key = setupKey(groupJid, senderJid);
    const setup = setupSessions.get(key);
    if (!setup) return false;
    const value = String(text || "").trim();
    if (!value) return false;
    if (value.toLowerCase() === "cancel") {
      setupSessions.delete(key);
      await setup.send({ text: "Trivia setup cancelled." });
      return true;
    }
    if (setup.expiresAt <= now()) {
      setupSessions.delete(key);
      await setup.send({ text: "⌛ Your Trivia setup expired. Send !trivia start to begin again." });
      return true;
    }
    if (!/^\d+$/.test(value)) return false;
    const choice = Number(value);

    if (setup.stage === "subject") {
      if (choice < 1 || choice > setup.categories.length) {
        await setup.send({ text: "⚠️ Choose a valid subject number from the list above." });
        return true;
      }
      setup.subject = setup.categories[choice - 1].name;
      setup.subcategories = setup.categories[choice - 1].subcategories;
      setup.stage = "subcategory";
      const lines = [
        "╭━━〔 🧠 𝐓𝐑𝐈𝐕𝐈𝐀 𝐐𝐔𝐈𝐙 𝐒𝐄𝐓𝐔𝐏 〕━━┈⊷",
        "┃ *STEP 2 — " + setup.subject.toUpperCase() + " TOPICS*",
        "┃ Choose one topic, or choose ALL TOPICS for a mixed quiz:",
        "┃ 1. ALL TOPICS — mixed questions from every " + setup.subject + " topic"
      ];
      setup.subcategories.forEach((item, index) => lines.push("┃ " + (index + 2) + ". " + item));
      lines.push("╰━━━━━━━━━━━━━━━━━━⬣", "", "Reply with a number.");
      await setup.send({ text: lines.join("\n") });
      return true;
    }

    if (setup.stage === "subcategory") {
      if (choice < 1 || choice > setup.subcategories.length + 1) {
        await setup.send({ text: "⚠️ Choose a valid topic number from the list above." });
        return true;
      }
      setup.subcategory = choice === 1 ? "" : setup.subcategories[choice - 2];
      setup.stage = "count";
      const settings = await store.getSettings();
      setup.counts = [...new Set([10, 20, 30, 50, settings.questionCount])].sort((x, y) => x - y);
      await setup.send({ text:
        "╭━━〔 🧠 𝐓𝐑𝐈𝐕𝐈𝐀 𝐐𝐔𝐈𝐙 𝐒𝐄𝐓𝐔𝐏 〕━━┈⊷\n" +
        "┃ *STEP 3 — NUMBER OF QUESTIONS*\n" +
        "┃ Subject: " + setup.subject + "\n" +
        "┃ Topic: " + (setup.subcategory || "All topics (mixed)") + "\n" +
        "┃ Choose how many questions you want:\n" +
        setup.counts.map(count => "┃ " + count + " questions").join("\n") +
        "\n╰━━━━━━━━━━━━━━━━━━⬣\n\nReply with the question count (for example, 20)."
      });
      return true;
    }

    if (setup.stage === "count") {
      if (!setup.counts.includes(choice)) {
        await setup.send({ text: "⚠️ Choose one of the available question counts: " + setup.counts.join(", ") + "." });
        return true;
      }
      setupSessions.delete(key);
      const result = await startGame({
        groupJid: setup.groupJid,
        subjects: [setup.subject],
        subcategory: setup.subcategory,
        count: choice,
        send: setup.send
      });
      if (!result.ok) {
        const messages = {
          already_running: "A Trivia competition is already running in this group.",
          cooldown: "Please wait " + Math.ceil(result.remainingMs / 1000) + " seconds before starting another competition.",
          empty_bank: "There are no approved questions for that selection yet. Choose another topic or ask the owner to add questions.",
          invalid_time: "The configured time per question is invalid.",
          send_failed: "WhatsApp could not send the first question. Please try again shortly."
        };
        await setup.send({ text: "⚠️ " + (messages[result.reason] || "The competition could not be started.") });
      }
      return true;
    }
    return false;
  }

  function cancelSetup({ groupJid, senderJid } = {}) {
    return setupSessions.delete(setupKey(groupJid, senderJid));
  }

  function cancelGroupSetups(groupJid) {
    const prefix = String(groupJid || "").trim().toLowerCase() + "|";
    let cancelled = 0;
    for (const key of setupSessions.keys()) {
      if (key.startsWith(prefix)) {
        setupSessions.delete(key);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  async function startGame({
    groupJid,
    subjects = [],
    subcategory = "",
    count,
    secondsPerQuestion,
    send
  } = {}) {
    const jid = String(groupJid || "").trim().toLowerCase();
    if (!jid.endsWith("@g.us")) return { ok: false, reason: "group_only" };
    if (typeof send !== "function") return { ok: false, reason: "missing_sender" };
    if (activeGames.has(jid)) return { ok: false, reason: "already_running" };

    const settings = await store.getSettings();
    const cooldownMs = settings.startCooldownMs;
    const previousStart = lastStartedAt.get(jid) || 0;
    const remaining = previousStart ? cooldownMs - (now() - previousStart) : 0;
    if (remaining > 0) return { ok: false, reason: "cooldown", remainingMs: remaining };

    const requestedSeconds = Number(secondsPerQuestion ?? settings.secondsPerQuestion);
    if (!Number.isInteger(requestedSeconds) || requestedSeconds < 10 || requestedSeconds > 60) {
      return { ok: false, reason: "invalid_time" };
    }

    const selected = await store.selectQuestions({
      groupJid: jid,
      subjects,
      subcategory,
      count: count ?? settings.questionCount
    });
    if (!selected.questions.length) return { ok: false, reason: "empty_bank", available: 0 };

    const session = {
      groupJid: jid,
      subjects: Array.isArray(subjects) ? subjects : [subjects],
      label: [...new Set(selected.questions.map(question => question.subject))].join(" + ") +
        (subcategory ? " · " + subcategory : (subjects.length ? " · All Topics" : "")),
      questions: selected.questions,
      reduced: selected.reduced,
      secondsPerQuestion: requestedSeconds,
      interQuestionDelayMs: settings.interQuestionDelayMs,
      send,
      scores: new Map(),
      completedQuestions: 0,
      askedQuestionIds: [],
      index: 0,
      attempted: new Set(),
      solved: false,
      timer: null,
      sendQueue: Promise.resolve(),
      lastSentAt: 0,
      closed: false
    };

    activeGames.set(jid, session);
    lastStartedAt.set(jid, now());
    const firstQuestionSent = await sendCurrentQuestion(session);
    if (!firstQuestionSent || session.closed) return { ok: false, reason: "send_failed" };
    return {
      ok: true,
      questionCount: session.questions.length,
      requestedCount: Number(count ?? settings.questionCount),
      reduced: selected.reduced,
      available: selected.available
    };
  }

  async function stopGame(groupJid) {
    const session = activeGames.get(String(groupJid || "").trim().toLowerCase());
    if (!session) return false;
    return finish(session, "STOPPED");
  }

  async function handleAnswer({ groupJid, senderJid, name, answer } = {}) {
    const session = activeGames.get(String(groupJid || "").trim().toLowerCase());
    const selected = String(answer || "").trim().toUpperCase();
    if (!session || !/^[ABCD]$/.test(selected) || session.closed || session.solved) return false;

    const playerId = String(senderJid || "").trim();
    if (!playerId || playerId === session.groupJid || playerId.endsWith("@g.us")) return false;
    if (session.attempted.has(playerId)) return true;
    session.attempted.add(playerId);

    const question = session.questions[session.index];
    const player = session.scores.get(playerId) || {
      id: playerId,
      name: cleanName(name),
      points: 0,
      correctAnswers: 0,
      questionsWon: 0,
      lastScoredAt: 0
    };
    session.scores.set(playerId, player);
    if (selected !== question.answer) return true;


    const points = 1;
    player.points += points;
    player.correctAnswers += 1;
    player.questionsWon += 1;
    player.lastScoredAt = now();
    session.scores.set(playerId, player);

    const result = "╭━━〔 ✅ 𝐂𝐎𝐑𝐑𝐄𝐂𝐓 𝐀𝐍𝐒𝐖𝐄𝐑 〕━━┈⊷\n" +
      "┃ ➣ *Winner:* " + player.name + "\n" +
      "┃ ➣ *Answer:* " + question.answer + " — " + formatTriviaMath(question.options[question.answer]) + "\n" +
      "┃ ➣ *Points:* +" + points + " (Total: " + player.points + ")" +
      formatExplanation(question) +
      "\n╰━━━━━━━━━━━━━━━━━━⬣";

    try {
      await enqueueSend(session, result);
      session.completedQuestions += 1;
      await advance(session);
    } catch {
      await finish(session, "STOPPED");
    }
    return true;
  }

  function getActiveGame(groupJid) {
    const session = activeGames.get(String(groupJid || "").trim().toLowerCase());
    if (!session) return null;
    return {
      groupJid: session.groupJid,
      label: session.label,
      questionNumber: session.index + 1,
      questionCount: session.questions.length,
      participantCount: session.scores.size,
      scores: [...session.scores.values()].map(player => ({ ...player }))
    };
  }

  function getActiveGroupIds() {
    return [...activeGames.keys()];
  }

  return {
    beginSetup,
    handleSetupReply,
    cancelSetup,
    cancelGroupSetups,
    startGame,
    stopGame,
    handleAnswer,
    getActiveGame,
    getActiveGroupIds
  };
}

export const triviaEngine = createTriviaEngine();

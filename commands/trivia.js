import { randomBytes } from "node:crypto";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { getContextInfo, unwrapMessage } from "../lib/message-utils.js";
import { triviaStore } from "../lib/trivia-store.js";
import { triviaEngine } from "../lib/trivia-engine.js";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_QUESTIONS = 5000;

const pendingBulkDeletes = new Map();
const BULK_DELETE_CONFIRM_TTL_MS = 2 * 60 * 1000;

function bulkDeleteKey(ctx) {
  return String(ctx.senderJid || "") + "|" + String(ctx.jid || "");
}

function parseBulkDeleteScope(input) {
  const [kindRaw = "", ...rest] = String(input || "").trim().split(/\s+/);
  const kind = kindRaw.toLowerCase();
  const value = rest.join(" ").trim();
  if (kind === "subject" && value) return { subject: value };
  if (kind === "topic" && value.includes("|")) {
    const [subject, ...parts] = value.split("|");
    const subcategory = parts.join("|").trim();
    if (subject.trim() && subcategory) return { subject: subject.trim(), subcategory };
  }
  if (kind === "ids" && value) {
    const ids = value.split(",").map(id => id.trim()).filter(Boolean);
    if (ids.length && ids.length <= 100) return { ids };
  }
  if (kind === "all" && !value) return { all: true };
  return null;
}

function isGroup(ctx) {
  return String(ctx.jid || "").endsWith("@g.us");
}

async function ownerOnly(ctx) {
  if (ctx.owner) return true;
  await ctx.reply("⛔ Only the bot owner can manage the official Trivia question bank and group access.");
  return false;
}

async function groupOnly(ctx) {
  if (isGroup(ctx)) return true;
  await ctx.reply("⚠️ This Trivia action must be used inside a WhatsApp group.");
  return false;
}

function parseQuestionBlock(source) {
  const fields = {};
  let current = "";
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-z ]{1,24})\s*:\s*(.*)$/i);
    if (match) {
      current = match[1].trim().toLowerCase().replace(/\s+/g, "");
      fields[current] = match[2].trim();
    } else if (current) {
      fields[current] = (fields[current] + "\n" + line).trim();
    }
  }
  return {
    subject: fields.subject,
    subcategory: fields.subcategory || fields.category || "General",
    question: fields.question,
    options: {
      A: fields.a || fields.optiona,
      B: fields.b || fields.optionb,
      C: fields.c || fields.optionc,
      D: fields.d || fields.optiond
    },
    answer: fields.answer,
    explanation: fields.explanation || ""
  };
}

async function readImportFile(ctx) {
  const info = getContextInfo(ctx.msg?.message);
  if (!info?.quotedMessage) {
    throw new Error("Reply to a .json question-bank file with " + ctx.config.prefix + "trivia import.");
  }
  const quoted = unwrapMessage(info.quotedMessage);
  const media = quoted.documentMessage;
  if (!media) throw new Error("The quoted message must be a JSON document.");
  const fileName = String(media.fileName || "").toLowerCase();
  const mimetype = String(media.mimetype || "").toLowerCase();
  if (!fileName.endsWith(".json") && !["application/json", "text/json"].includes(mimetype)) {
    throw new Error("Only a .json question-bank document is supported for bulk import.");
  }
  const size = Number(media.fileLength?.toNumber?.() ?? media.fileLength ?? 0);
  if (size > MAX_IMPORT_BYTES) throw new Error("The JSON file exceeds the 2 MB import limit.");

  const stream = await downloadContentFromMessage(media, "document");
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_IMPORT_BYTES) throw new Error("The JSON file exceeds the 2 MB import limit.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON. Use the format shown by " + ctx.config.prefix + "trivia template.");
  }
  const questions = Array.isArray(parsed) ? parsed : parsed?.questions;
  if (!Array.isArray(questions) || !questions.length) {
    throw new Error("The JSON file must contain a non-empty questions array.");
  }
  if (questions.length > MAX_IMPORT_QUESTIONS) {
    throw new Error("A single import can contain at most " + MAX_IMPORT_QUESTIONS + " questions.");
  }
  return questions;
}

function categorySummary(categories) {
  if (!categories.length) return "No questions have been added to the official bank yet.";
  return categories.map(item =>
    "┃ ◈ *" + item.name + "* — " + item.subcategories.join(", ")
  ).join("\n");
}

function helpText(prefix) {
  return [
    "╭━━〔 🧠 𝕿𝖔𝖑𝖚𝖜𝖆𝖑𝖆𝖘𝖊 𝐓𝐑𝐈𝐕𝐈𝐀 〕━━┈⊷",
    "┃ *GROUP COMPETITION ARENA*",
    "┃",
    "┃ *PARTICIPANTS*",
    "┃ ◈ " + prefix + "trivia / help — Open this command menu",
    "┃ ◈ " + prefix + "trivia start — Start guided quiz setup",
    "┃ ◈ " + prefix + "trivia cancel — Cancel your pending setup",
    "┃ ◈ " + prefix + "trivia stop — Stop the current game",
    "┃ ◈ " + prefix + "trivia leaderboard — View live scores",
    "┃ ◈ " + prefix + "trivia status — View group Trivia status",
    "┃",
    "┃ *OWNER — GROUP ACCESS*",
    "┃ ◈ " + prefix + "trivia enable / disable — Toggle this group",
    "┃ ◈ " + prefix + "trivia groups — List enabled groups",
    "┃",
    "┃ *OWNER — QUESTION BANK*",
    "┃ ◈ " + prefix + "trivia add — Show format / add one question",
    "┃ ◈ " + prefix + "trivia import — Import a replied-to JSON file",
    "┃ ◈ " + prefix + "trivia template — Send JSON template",
    "┃ ◈ " + prefix + "trivia export — Export the full bank",
    "┃ ◈ " + prefix + "trivia list [subject] — List questions and IDs",
    "┃ ◈ " + prefix + "trivia edit <id> — Edit one question",
    "┃ ◈ " + prefix + "trivia remove <id> — Delete one question",
    "┃ ◈ " + prefix + "trivia delete subject <name>",
    "┃ ◈ " + prefix + "trivia delete topic <subject>|<topic>",
    "┃ ◈ " + prefix + "trivia delete ids <id1,id2>",
    "┃ ◈ " + prefix + "trivia delete all — Delete the entire bank",
    "┃ ◈ " + prefix + "trivia delete confirm <code> / cancel",
    "┃",
    "┃ *OWNER — SETTINGS*",
    "┃ ◈ " + prefix + "trivia settings — View settings",
    "┃ ◈ " + prefix + "trivia settings count 20",
    "┃ ◈ " + prefix + "trivia settings time 25",
    "┃ ◈ " + prefix + "trivia settings delay 3",
    "┃ ◈ " + prefix + "trivia settings cooldown 30",
    "╰━━━━━━━━━━━━━━━━━━⬣",
    "",
    "Each correct answer earns 1 point. The first correct answer wins the question.",
    "Bulk deletion shows a preview and requires a confirmation code.",
    "⚡ POWERED BY TOLUWALASE STUDIOS"
  ].join("\n");
}

function liveLeaderboard(game) {
  const players = [...game.scores].sort((a, b) =>
    b.points - a.points || b.correctAnswers - a.correctAnswers || a.name.localeCompare(b.name)
  );
  const lines = [
    "╭━━〔 🏆 𝐋𝐈𝐕𝐄 𝐓𝐑𝐈𝐕𝐈𝐀 𝐋𝐄𝐀𝐃𝐄𝐑𝐁𝐎𝐀𝐑𝐃 〕━━┈⊷",
    "┃ ➣ " + game.label,
    "┃ ➣ Question " + game.questionNumber + "/" + game.questionCount,
    "╰━━━━━━━━━━━━━━━━━━⬣"
  ];
  if (!players.length) lines.push("No points have been scored yet.");
  else players.slice(0, 15).forEach((player, index) => {
    lines.push((["🥇", "🥈", "🥉"][index] || String(index + 1) + ".") +
      " *" + player.name + "* — " + player.points + " pts");
  });
  return lines.join("\n");
}

const triviaCommand = {
  name: "trivia",
  aliases: ["triviaarena"],
  category: "Games",
  description: "Run group-based competitive quizzes with a question bank and leaderboard.",
  allowInPrivateMode: true,
  run: async ctx => {
    const input = String(ctx.args || "").trim();
    const [rawAction = "menu"] = input.split(/\s+/);
    const action = rawAction.toLowerCase();
    const actionArgs = input.slice(rawAction.length).trim();
    const prefix = ctx.config.prefix || "!";

    if (["help", "menu", ""].includes(action)) {
      if (!isGroup(ctx) && !ctx.owner) {
        await ctx.reply("Trivia competitions are available only inside groups enabled by the bot owner.");
        return;
      }
      if (isGroup(ctx) && !(await triviaStore.isGroupEnabled(ctx.jid))) {
        await ctx.reply("🔒 Trivia Arena has not been enabled for this group. Ask the bot owner to enable it.");
        return;
      }
      const categories = await triviaStore.getCategories();
      const active = isGroup(ctx) ? triviaEngine.getActiveGame(ctx.jid) : null;
      await ctx.reply(
        helpText(prefix) + "\n\n*AVAILABLE CATEGORIES*\n" + categorySummary(categories) +
        (active ? "\n\n⚡ A competition is currently running: " +
          active.label + " (" + active.questionNumber + "/" + active.questionCount + ")." : "")
      );
      return;
    }

    if (action === "enable" || action === "disable") {
      if (!(await ownerOnly(ctx)) || !(await groupOnly(ctx))) return;
      const enabled = action === "enable";
      await triviaStore.setGroupEnabled(ctx.jid, enabled);
      if (!enabled) {
        await triviaEngine.stopGame(ctx.jid);
        triviaEngine.cancelGroupSetups(ctx.jid);
      }
      await ctx.reply(enabled
        ? "✅ *TRIVIA ENABLED*\nThis group can now start its own competitions, even when the bot is in Private mode."
        : "🔒 *TRIVIA DISABLED*\nThis group can no longer start Trivia competitions.");
      return;
    }

    if (action === "groups") {
      if (!(await ownerOnly(ctx))) return;
      const groups = await triviaStore.listEnabledGroups();
      await ctx.reply(groups.length
        ? "*TRIVIA-ENABLED GROUPS*\n\n" + groups.map((jid, index) => (index + 1) + ". " + jid).join("\n")
        : "No groups currently have Trivia enabled.");
      return;
    }

    if (action === "status") {
      if (!(await groupOnly(ctx))) return;
      const enabled = await triviaStore.isGroupEnabled(ctx.jid);
      const active = triviaEngine.getActiveGame(ctx.jid);
      await ctx.reply(
        "🧠 *TRIVIA GROUP STATUS*\n\nEnabled: " + (enabled ? "YES" : "NO") +
        "\nCompetition: " + (active ? "RUNNING — " + active.questionNumber + "/" + active.questionCount : "NONE")
      );
      return;
    }

    if (action === "start") {
      if (!(await groupOnly(ctx))) return;
      if (!(await triviaStore.isGroupEnabled(ctx.jid))) {
        await ctx.reply("🔒 Trivia is not enabled for this group. Ask the bot owner to enable it.");
        return;
      }
      if (actionArgs) {
        await ctx.reply("Use *" + prefix + "trivia start* without extra options. I’ll guide you through subject, topic and question count.");
        return;
      }
      const result = await triviaEngine.beginSetup({
        groupJid: ctx.jid,
        senderJid: ctx.senderJid,
        send: payload => ctx.sock.sendMessage(ctx.jid, payload)
      });
      if (!result.ok) {
        const message = result.reason === "already_running"
          ? "A Trivia competition is already running in this group."
          : "There are no approved questions in the Trivia bank yet. Ask the owner to add questions.";
        await ctx.reply("⚠️ " + message);
      }
      return;
    }

    if (action === "cancel") {
      if (!(await groupOnly(ctx))) return;
      const cancelled = triviaEngine.cancelSetup({ groupJid: ctx.jid, senderJid: ctx.senderJid });
      await ctx.reply(cancelled ? "Trivia setup cancelled." : "You do not have an active Trivia setup.");
      return;
    }

    if (action === "stop") {
      if (!(await groupOnly(ctx))) return;
      if (!(await triviaStore.isGroupEnabled(ctx.jid))) {
        await ctx.reply("Trivia is not enabled for this group.");
        return;
      }
      const stopped = await triviaEngine.stopGame(ctx.jid);
      if (!stopped) await ctx.reply("There is no active Trivia competition to stop.");
      return;
    }

    if (action === "leaderboard") {
      if (!(await groupOnly(ctx))) return;
      if (!(await triviaStore.isGroupEnabled(ctx.jid))) {
        await ctx.reply("Trivia is not enabled for this group.");
        return;
      }
      const game = triviaEngine.getActiveGame(ctx.jid);
      await ctx.reply(game ? liveLeaderboard(game) : "There is no active competition. The final leaderboard is posted when a game ends.");
      return;
    }

    if (action === "add") {
      if (!(await ownerOnly(ctx))) return;
      if (!actionArgs) {
        await ctx.reply(
          "*ADD ONE QUESTION*\n\n" +
          "Subject: Biology\nSubcategory: Cell Biology\n" +
          "Question: Your question here?\nA: First option\nB: Second option\n" +
          "C: Third option\nD: Fourth option\nAnswer: B\nExplanation: Why B is correct."
        );
        return;
      }
      try {
        const result = await triviaStore.addQuestions(parseQuestionBlock(actionArgs));
        await ctx.reply("✅ Question added to the official bank. ID: " + result.ids[0] +
          (result.duplicates ? "\nDuplicate questions skipped: " + result.duplicates : ""));
      } catch (error) {
        await ctx.reply("⚠️ Could not add question: " + error.message);
      }
      return;
    }

    if (action === "import") {
      if (!(await ownerOnly(ctx))) return;
      try {
        const questions = await readImportFile(ctx);
        const result = await triviaStore.addQuestions(questions);
        await ctx.reply(
          "✅ *QUESTION BANK IMPORT COMPLETE*\n\n" +
          "New questions: " + result.added +
          "\nDuplicates skipped: " + result.duplicates +
          "\nTotal bank size: " + (await triviaStore.getStats()).questionCount
        );
      } catch (error) {
        await ctx.reply("⚠️ Import failed: " + String(error.message || error).slice(0, 240));
      }
      return;
    }

    if (action === "template") {
      if (!(await ownerOnly(ctx))) return;
      await ctx.reply(
        "Save a JSON file named *trivia-questions.json* with this structure:\n\n" +
        '{"questions":[{"subject":"Biology","subcategory":"Cell Biology",' +
        '"question":"Which organelle modifies and packages proteins?","options":' +
        '{"A":"Lysosome","B":"Golgi apparatus","C":"Ribosome","D":"Nucleolus"},' +
        '"answer":"B","explanation":"The Golgi apparatus modifies, sorts and packages proteins."}]}'
      );
      return;
    }

    if (action === "export") {
      if (!(await ownerOnly(ctx))) return;
      const questions = await triviaStore.listQuestions();
      const data = Buffer.from(JSON.stringify({ questions }, null, 2), "utf8");
      await ctx.sock.sendMessage(ctx.jid, {
        document: data,
        mimetype: "application/json",
        fileName: "Tolu-XMD-Trivia-Question-Bank.json"
      });
      return;
    }

    if (action === "list") {
      if (!(await ownerOnly(ctx))) return;
      const subject = actionArgs;
      const questions = await triviaStore.listQuestions(subject ? { subject } : {});
      const categories = await triviaStore.getCategories();
      const questionRows = questions.slice(0, 20).map(item =>
        "ID: " + item.id + "\n" + item.subject + " · " + item.subcategory +
        "\n" + item.question.slice(0, 100)
      );
      await ctx.reply(
        "*OFFICIAL QUESTION BANK*\n\nTotal questions: " + questions.length +
        "\n\n" + categorySummary(categories) +
        (questionRows.length ? "\n\n*RECENT QUESTIONS*\n" + questionRows.join("\n\n") : "") +
        "\n\nUse " + prefix + "trivia edit <id>, " + prefix + "trivia remove <id>, or " + prefix + "trivia delete for bulk deletion."
      );
      return;
    }

    if (action === "edit") {
      if (!(await ownerOnly(ctx))) return;
      const newline = actionArgs.indexOf("\n");
      const id = newline < 0 ? "" : actionArgs.slice(0, newline).trim();
      const block = newline < 0 ? "" : actionArgs.slice(newline + 1).trim();
      if (!id || !block) {
        await ctx.reply("Usage: " + prefix + "trivia edit <question-id> then provide the updated question fields.");
        return;
      }
      try {
        const updated = await triviaStore.updateQuestion(id, parseQuestionBlock(block));
        await ctx.reply(updated ? "✅ Question updated in the official bank." : "No question was found with that ID.");
      } catch (error) {
        await ctx.reply("⚠️ Could not update question: " + error.message);
      }
      return;
    }

    if (action === "delete") {
      if (!(await ownerOnly(ctx))) return;
      const [modeRaw = "", ...rest] = actionArgs.split(/\s+/);
      const mode = modeRaw.toLowerCase();
      const value = rest.join(" ").trim();
      const key = bulkDeleteKey(ctx);

      if (mode === "cancel") {
        const cancelled = pendingBulkDeletes.delete(key);
        await ctx.reply(cancelled ? "Bulk deletion cancelled. No questions were deleted." : "There is no pending bulk deletion to cancel.");
        return;
      }

      if (mode === "confirm") {
        const pending = pendingBulkDeletes.get(key);
        if (!pending || pending.expiresAt <= Date.now()) {
          pendingBulkDeletes.delete(key);
          await ctx.reply("⌛ No valid bulk deletion is awaiting confirmation. Run the delete command again.");
          return;
        }
        if (!value || value.toUpperCase() !== pending.code) {
          await ctx.reply("❌ Confirmation code does not match. No questions were deleted.");
          return;
        }
        pendingBulkDeletes.delete(key);
        try {
          const result = await triviaStore.removeQuestions({ ids: pending.ids });
          await ctx.reply("✅ *BULK DELETION COMPLETE*\n\nQuestions deleted: " + result.removed +
            "\nQuestions remaining: " + result.remaining);
        } catch (error) {
          await ctx.reply("⚠️ Bulk deletion failed: " + error.message);
        }
        return;
      }

      const scope = parseBulkDeleteScope(actionArgs);
      if (!scope) {
        await ctx.reply("*BULK DELETE USAGE*\n\n" +
          prefix + "trivia delete subject Biology\n" +
          prefix + "trivia delete topic Biology|Cell Biology\n" +
          prefix + "trivia delete ids ID1,ID2\n" +
          prefix + "trivia delete all\n\n" +
          "Confirm with the preview code, or use " + prefix + "trivia delete cancel.");
        return;
      }
      let questions;
      try {
        questions = scope.all ? await triviaStore.listQuestions() : await triviaStore.listQuestions(scope);
      } catch (error) {
        await ctx.reply("⚠️ Could not prepare deletion: " + error.message);
        return;
      }
      if (!questions.length) {
        await ctx.reply("No questions match that deletion scope. Nothing was deleted.");
        return;
      }
      const code = randomBytes(3).toString("hex").toUpperCase();
      const ids = questions.map(question => question.id);
      const total = (await triviaStore.getStats()).questionCount;
      pendingBulkDeletes.set(key, { code, ids, expiresAt: Date.now() + BULK_DELETE_CONFIRM_TTL_MS });
      const label = scope.all ? "ENTIRE QUESTION BANK" : scope.ids ? "SELECTED QUESTION IDs" :
        scope.subcategory ? scope.subject + " · " + scope.subcategory : scope.subject;
      await ctx.reply("⚠️ *BULK DELETION PREVIEW*\n\nScope: " + label +
        "\nQuestions to delete: " + ids.length +
        "\nQuestions that will remain: " + (total - ids.length) +
        "\n\nThis action cannot be undone. To proceed, send:\n*" +
        prefix + "trivia delete confirm " + code + "*\n\n" +
        "Code expires in 2 minutes. Use *" + prefix + "trivia delete cancel* to cancel.");
      return;
    }

    if (action === "remove") {
      if (!(await ownerOnly(ctx))) return;
      const removed = await triviaStore.removeQuestion(actionArgs);
      await ctx.reply(removed ? "✅ Question removed from the official bank." : "No question was found with that ID.");
      return;
    }

    if (action === "settings") {
      if (!(await ownerOnly(ctx))) return;
      const [key, rawValue] = actionArgs.split(/\s+/, 2);
      if (!key) {
        const settings = await triviaStore.getSettings();
        await ctx.reply(
          "*TRIVIA DEFAULT SETTINGS*\n\n" +
          "Questions per game: " + settings.questionCount +
          "\nSeconds per question: " + settings.secondsPerQuestion +
          "\nDelay between questions: " + (settings.interQuestionDelayMs / 1000) + "s" +
          "\nStart cooldown: " + (settings.startCooldownMs / 1000) + "s" +
          "\n\nSet one at a time: " + prefix + "trivia settings count 20 (or time 25, delay 3, cooldown 30)"
        );
        return;
      }
      const settingMap = {
        count: "questionCount",
        time: "secondsPerQuestion",
        delay: "interQuestionDelayMs",
        cooldown: "startCooldownMs"
      };
      const target = settingMap[key.toLowerCase()];
      if (!target || !rawValue || !/^\d+$/.test(rawValue)) {
        await ctx.reply("Usage: " + prefix + "trivia settings count 20 (or time 25, delay 3, cooldown 30).");
        return;
      }
      try {
        const value = Number(rawValue) * (["delay", "cooldown"].includes(key.toLowerCase()) ? 1000 : 1);
        const updated = await triviaStore.updateSettings({ [target]: value });
        await ctx.reply("✅ Trivia setting updated.\n" + target + ": " + updated[target]);
      } catch (error) {
        await ctx.reply("⚠️ " + error.message);
      }
      return;
    }

    await ctx.reply("Unknown Trivia action. Use " + prefix + "trivia help to see available commands.");
  }
};

export default triviaCommand;

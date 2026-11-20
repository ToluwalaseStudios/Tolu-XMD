import {
  requestExternalJson,
  unicodeBox,
  withPoweredFooter
} from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";
const WORMGPT_SYSTEM = [
  "You are a helpful general-purpose assistant.",
  "Give accurate, age-appropriate answers.",
  "Do not provide instructions that enable real-world violence, weapon construction or use, evasion, or attacks.",
  "If asked for such instructions, briefly refuse and offer safe, non-actionable information."
].join(" ");
const WORMGPT_SESSIONS = new Map();

function outputText(payload, limit = 3400) {
  const value = payload?.data ?? payload?.result ?? payload;
  let text;
  if (typeof value === "string") text = value;
  else text = JSON.stringify(value, null, 2);
  if (!text || text === "{}") throw new Error("The service returned an empty response.");
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function findString(payload, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((item, part) => item && item[part], payload);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function runWormGPT(ctx) {
  const prompt = String(ctx.args || "").trim();
  if (!prompt) {
    await ctx.reply("Usage: " + ctx.config.prefix + "wormgpt your message\nUse " + ctx.config.prefix + "wormgpt reset to clear this chat.");
    return;
  }
  const sessionKey = String(ctx.jid || "") + ":" + String(ctx.senderJid || "");
  if (prompt.toLowerCase() === "reset") {
    WORMGPT_SESSIONS.delete(sessionKey);
    await ctx.reply("♻️ WormGPT conversation reset.");
    return;
  }
  const chatId = WORMGPT_SESSIONS.get(sessionKey);
  const payload = await requestExternalJson(API + "/ai/wormgpt", {
    action: "chat",
    prompt,
    message: prompt,
    chatId: chatId || undefined,
    system: WORMGPT_SYSTEM,
    systemPrompt: WORMGPT_SYSTEM,
    system_prompt: WORMGPT_SYSTEM,
    noSystem: false,
    temperature: 0.7,
    max_tokens: 1200
  }, 90000);
  const nextId = findString(payload, ["data.chatId", "chatId", "data.sessionId", "sessionId"]);
  if (nextId) WORMGPT_SESSIONS.set(sessionKey, nextId);
  const answer = findString(payload, ["data.text", "data.reply", "data.response", "text", "reply", "response", "answer"]);
  if (!answer) throw new Error("WormGPT returned no text. Response: " + outputText(payload, 900));
  await ctx.reply(withPoweredFooter(unicodeBox("🧠 WORMGPT", answer, { footer: false }), 3800));
}

function parseMovieArgs(raw) {
  const [actionRaw, ...rest] = String(raw || "").trim().split(/\s+/);
  const action = String(actionRaw || "").toLowerCase();
  const args = rest;
  if (!["home", "trending", "search", "detail", "play", "download"].includes(action)) {
    throw new Error("Usage: moviebox home | trending | search <title> | detail <subjectId> | play <subjectId> [season] [episode] | download <subjectId> [season] [episode]");
  }
  return { action, args };
}

async function runMovieBox(ctx) {
  const { action, args } = parseMovieArgs(ctx.args);
  const params = { action };
  if (action === "search") {
    const keyword = args.join(" ").trim();
    if (!keyword) throw new Error("Usage: " + ctx.config.prefix + "moviebox search <movie title>");
    params.keyword = keyword;
    params.page = 1;
    params.perPage = 10;
  } else if (action === "detail") {
    const subjectId = args[0];
    if (!subjectId) throw new Error("Usage: " + ctx.config.prefix + "moviebox detail <subjectId>");
    params.subjectId = subjectId;
  } else if (action === "play" || action === "download") {
    const subjectId = args[0];
    if (!subjectId) throw new Error("Usage: " + ctx.config.prefix + "moviebox " + action + " <subjectId> [season] [episode]");
    params.subjectId = subjectId;
    params.se = Number.isFinite(Number(args[1])) ? Number(args[1]) : 0;
    params.ep = Number.isFinite(Number(args[2])) ? Number(args[2]) : 0;
  } else if (action === "trending") {
    params.page = 1;
    params.perPage = 10;
  }
  const payload = await requestExternalJson(API + "/movie/MovieBox-pro", params, 90000);
  const body = outputText(payload);
  const title = "🎬 MOVIEBOX PRO · " + action.toUpperCase();
  await ctx.reply(withPoweredFooter(unicodeBox(title, body, { footer: false }), 3800));
}

export default [
  {
    name: "wormgpt",
    aliases: ["worm"],
    category: "AI Chat",
    description: "Chat with OmegaTech WormGPT.",
    run: runWormGPT
  },
  {
    name: "moviebox",
    aliases: ["mbox"],
    category: "Downloads",
    description: "Search movies, view details and request MovieBox playback/download information.",
    run: runMovieBox
  }
];

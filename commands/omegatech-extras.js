import {
  extractApiText,
  requestExternalJson,
  unicodeBox,
  withPoweredFooter
} from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";
const SESSIONS = new Map();
const MODEL_CACHE = new Map();
const DEFAULT_SYSTEM = [
  "You are a helpful, accurate, age-appropriate general-purpose assistant.",
  "Do not provide instructions, strategies, or practical guidance for obtaining, making, using, hiding, or benefiting from weapons, dangerous substances, gambling, or other dangerous activities.",
  "For requests involving these topics, briefly decline and offer safe, factual alternatives.",
  "Be clear when you are uncertain. Do not invent facts."
].join(" ");

function getModelRows(payload) {
  const candidates = [payload?.data?.models, payload?.models, payload?.data, payload?.result];
  const list = candidates.find(Array.isArray) || [];
  return list.map(item => typeof item === "string" ? { id: item, name: item } : {
    id: String(item?.id || item?.model || item?.modelId || item?.name || ""),
    name: String(item?.name || item?.displayName || item?.id || item?.model || "")
  }).filter(item => item.id);
}

function getText(payload) {
  const paths = [
    payload?.data?.reply, payload?.data?.response, payload?.data?.text,
    payload?.reply, payload?.response, payload?.text, payload?.answer,
    payload?.data?.choices?.[0]?.message?.content,
    payload?.choices?.[0]?.message?.content
  ];
  const value = paths.find(item => typeof item === "string" && item.trim());
  return value ? value.trim() : extractApiText(payload);
}

async function runWormGPT(ctx) {
  const raw = String(ctx.args || "").trim();
  if (!raw) {
    await ctx.reply(
      "Usage: " + ctx.config.prefix + "wormgpt <your message>\n" +
      ctx.config.prefix + "wormgpt models — list available models\n" +
      ctx.config.prefix + "wormgpt reset — clear your conversation"
    );
    return;
  }

  const key = String(ctx.jid || "") + ":" + String(ctx.senderJid || "");
  const [first, ...rest] = raw.split(/\s+/);
  const action = first.toLowerCase();

  if (action === "reset") {
    SESSIONS.delete(key);
    await ctx.reply("♻️ WormGPT conversation reset.");
    return;
  }

  if (action === "models") {
    const payload = await requestExternalJson(API + "/ai/wormgpt", { action: "models" }, 45000);
    const models = getModelRows(payload);
    if (!models.length) throw new Error("The provider returned no readable model list.");
    MODEL_CACHE.set(key, models);
    const lines = models.slice(0, 35).map((model, index) => (index + 1) + ". " + model.name + " [" + model.id + "]");
    lines.push("", "Choose by number: " + ctx.config.prefix + "wormgpt 1 | your message");
    await ctx.reply(withPoweredFooter(unicodeBox("🧠 WORMGPT · AVAILABLE MODELS", lines.join("\n"), { footer: false }), 3800));
    return;
  }

  let selectedModel = "";
  let promptRaw = raw;
  const numbered = raw.match(/^(\d+)\s*\|\s*([\s\S]+)$/);
  if (numbered) {
    const models = MODEL_CACHE.get(key);
    if (!models) throw new Error("First run " + ctx.config.prefix + "wormgpt models, then choose a model number.");
    const index = Number(numbered[1]) - 1;
    if (!models[index]) throw new Error("That model number is not in the list. Run wormgpt models again.");
    selectedModel = models[index].id;
    promptRaw = numbered[2].trim();
  }
  const prompt = action === "ask" || action === "chat" ? rest.join(" ").trim() : promptRaw;
  if (!prompt) throw new Error("Enter a message after the command.");
  if (prompt.length > 2500) throw new Error("Keep your message under 2,500 characters.");

  const sessionId = SESSIONS.get(key);
  const payload = await requestExternalJson(API + "/ai/wormgpt", {
    action: "chat",
    message: prompt,
    prompt,
    sessionId: sessionId || undefined,
    system: DEFAULT_SYSTEM,
    systemPrompt: DEFAULT_SYSTEM,
    system_prompt: DEFAULT_SYSTEM,
    noSystem: false,
    temperature: 0.7,
    max_tokens: 1400,
    model: selectedModel || MODEL_CACHE.get(key)?.[0]?.id
  }, 90000);

  if (payload?.success === false || payload?.statusCode >= 400) {
    throw new Error(String(payload?.message || payload?.error || "WormGPT request failed.").slice(0, 220));
  }

  const nextSession = [
    payload?.data?.sessionId, payload?.sessionId,
    payload?.data?.chatId, payload?.chatId
  ].find(value => typeof value === "string" && value.trim());
  if (nextSession) SESSIONS.set(key, nextSession);

  const answer = getText(payload);
  await ctx.reply(withPoweredFooter(
    unicodeBox("🧠 WORMGPT", answer.slice(0, 3300), { footer: false }),
    3800
  ));
}

async function runMovieBox(ctx) {
  const parts = String(ctx.args || "").trim().split(/\s+/);
  const action = String(parts.shift() || "").toLowerCase();
  if (!["home", "trending", "search", "detail", "play", "download"].includes(action)) {
    throw new Error("Usage: " + ctx.config.prefix + "moviebox home | trending | search <title> | detail <subjectId> | play <subjectId> [season] [episode] | download <subjectId> [season] [episode]");
  }
  const params = { action };
  if (action === "search") {
    const keyword = parts.join(" ").trim();
    if (!keyword) throw new Error("Usage: " + ctx.config.prefix + "moviebox search <movie title>");
    params.keyword = keyword; params.page = 1; params.perPage = 10;
  } else if (["detail", "play", "download"].includes(action)) {
    if (!parts[0]) throw new Error("A MovieBox subject ID is required.");
    params.subjectId = parts[0];
    if (action === "play" || action === "download") {
      params.se = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 0;
      params.ep = Number.isFinite(Number(parts[2])) ? Number(parts[2]) : 0;
    }
  } else if (action === "trending") {
    params.page = 1; params.perPage = 10;
  }
  const payload = await requestExternalJson(API + "/movie/MovieBox-pro", params, 90000);
  const value = payload?.data ?? payload?.result ?? payload;
  const output = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await ctx.reply(withPoweredFooter(unicodeBox("🎬 MOVIEBOX · " + action.toUpperCase(), output.slice(0, 3400), { footer: false }), 3800));
}

export default [
  { name: "wormgpt", aliases: ["worm"], category: "AI", description: "Chat with OmegaTech WormGPT; list models and choose by number.", run: runWormGPT },
  { name: "moviebox", aliases: [], category: "Downloads", description: "Browse, search, view details and request MovieBox playback information.", run: runMovieBox }
];

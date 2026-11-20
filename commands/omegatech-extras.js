import {
  extractApiText,
  requestExternalJson,
  unicodeBox,
  withPoweredFooter
} from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";
const SESSIONS = new Map();
const DEFAULT_SYSTEM = [
  "You are a helpful, accurate, age-appropriate general-purpose assistant.",
  "Do not provide instructions, strategies, or practical guidance for obtaining, making, using, hiding, or benefiting from weapons, dangerous substances, gambling, or other dangerous activities.",
  "For requests involving these topics, briefly decline and offer safe, factual alternatives.",
  "Be clear when you are uncertain. Do not invent facts."
].join(" ");

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
    const text = getText(payload);
    await ctx.reply(withPoweredFooter(unicodeBox("🧠 WORMGPT · MODELS", text, { footer: false }), 3800));
    return;
  }

  const prompt = action === "ask" || action === "chat" ? rest.join(" ").trim() : raw;
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
    max_tokens: 1400
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

export default {
  name: "wormgpt",
  aliases: ["worm"],
  category: "AI",
  description: "Chat with OmegaTech WormGPT with conversation memory.",
  run: runWormGPT
};

import { requestExternalJson, extractApiText, unicodeBox, withPoweredFooter } from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";
const sessions = new Map();
const histories = new Map();

function key(ctx, name) { return [ctx.jid, ctx.senderJid, name].join(":"); }
function textArg(ctx, usage, max = 2500) {
  const value = String(ctx.args || "").trim();
  if (!value) throw new Error("Usage: " + ctx.config.prefix + ctx.commandName + " " + usage);
  if (value.length > max) throw new Error("Keep your message under " + max + " characters.");
  return value;
}
function at(obj, paths) {
  for (const path of paths) {
    let value = obj;
    for (const part of path.split(".")) value = value && value[part];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
function reply(ctx, heading, body) {
  return ctx.reply(withPoweredFooter(unicodeBox(heading, body.slice(0, 3300), { footer: false }), 3800));
}
function sessionCommand({ name, label, endpoint, fields, responsePaths, resetWord = "reset" }) {
  return {
    name,
    category: "AI Media",
    description: "Chat using " + label + " with conversation memory.",
    run: async ctx => {
      const input = textArg(ctx, "your question or message", 2500);
      const id = key(ctx, name);
      if (input.toLowerCase() === resetWord) {
        sessions.delete(id);
        histories.delete(id);
        await ctx.reply("♻️ " + label + " conversation reset.");
        return;
      }
      const previous = sessions.get(id) || {};
      const params = fields(input, previous);
      const payload = await requestExternalJson(API + endpoint, params, 90000);
      if (payload?.success === false || payload?.statusCode >= 400) {
        throw new Error(String(payload?.message || payload?.error || label + " request failed.").slice(0, 200));
      }
      const answer = at(payload, responsePaths) || extractApiText(payload);
      const nextSession = at(payload, ["data.sessionId", "sessionId", "session_id"]);
      const nextChat = at(payload, ["data.chatId", "chatId", "data.chat_id", "chat_id"]);
      if (nextSession || nextChat) sessions.set(id, { sessionId: nextSession || previous.sessionId || "", chatId: nextChat || previous.chatId || "" });
      await reply(ctx, "🤖 " + label.toUpperCase(), answer);
    }
  };
}

const commands = [
  {
    name: "deepai",
    aliases: ["deep-ai"],
    category: "AI Media",
    description: "Chat with DeepAI models. Optional syntax: model | message.",
    run: async ctx => {
      const raw = textArg(ctx, "message or model | message", 2500);
      const models = new Set(["standard", "deepseek-v3.2", "gemini-2.5-flash-lite", "gemma-4", "llama-3.3-70b", "gpt-oss-120b", "gpt-5-nano"]);
      const parts = raw.split("|");
      const model = parts.length > 1 && models.has(parts[0].trim().toLowerCase()) ? parts.shift().trim().toLowerCase() : "standard";
      const message = parts.join("|").trim();
      if (!message) throw new Error("Enter a message after the model name.");
      const id = key(ctx, "deepai");
      if (message.toLowerCase() === "reset") { histories.delete(id); await ctx.reply("♻️ DeepAI history cleared."); return; }
      const history = histories.get(id) || [];
      const payload = await requestExternalJson(API + "/ai/Deep-ai", {
        action: "chat", message, model, history: JSON.stringify(history)
      }, 90000);
      if (payload?.success === false || payload?.statusCode >= 400) throw new Error(String(payload?.message || payload?.error || "DeepAI request failed.").slice(0, 200));
      const answer = at(payload, ["data.reply", "data.response", "reply", "response", "answer", "text"]);
      if (!answer) throw new Error("DeepAI returned no text response.");
      histories.set(id, [...history, { role: "user", content: message }, { role: "assistant", content: answer }].slice(-12));
      await reply(ctx, "🤖 DEEPAI · " + model.toUpperCase(), answer);
    }
  },
  sessionCommand({
    name: "chatgpt",
    label: "ChatGPT",
    endpoint: "/ai/Chatgpt-v2",
    fields: (message, old) => ({ action: "chat", message, sessionId: old.sessionId || undefined, chatId: old.chatId || undefined }),
    responsePaths: ["data.reply", "reply", "data.response", "response", "answer"]
  }),
  sessionCommand({
    name: "gemini",
    label: "Gemini",
    endpoint: "/ai/Gemini",
    fields: (message, old) => ({ action: "chat", message, sessionId: old.sessionId || undefined, chatId: old.chatId || undefined }),
    responsePaths: ["data.response", "data.reply", "response", "reply", "answer"]
  }),
  {
    name: "llamacoder",
    aliases: ["llamacode"],
    category: "AI Media",
    description: "Build a web app with LlamaCoder; use followup | instruction to refine the saved project.",
    run: async ctx => {
      const raw = textArg(ctx, "build description | quality (low/medium/high), or followup | instruction", 1800);
      const parts = raw.split("|");
      const action = parts[0].trim().toLowerCase() === "followup" ? "followup" : "create";
      const id = key(ctx, "llamacoder");
      if (action === "followup") {
        const session = sessions.get(id);
        if (!session?.sessionId) throw new Error("No app-building session is saved. Start with !llamacoder describe your app.");
        const prompt = parts.slice(1).join("|").trim();
        if (!prompt) throw new Error("Add the change you want after followup |");
        const payload = await requestExternalJson(API + "/ai/llamacoder", { action, prompt, sessionId: session.sessionId }, 180000);
        const answer = at(payload, ["data.message", "data.reply", "message", "reply", "data.result", "result"]) || JSON.stringify(payload.data || payload).slice(0, 2600);
        const sid = at(payload, ["data.sessionId", "sessionId"]) || session.sessionId;
        sessions.set(id, { sessionId: sid });
        await reply(ctx, "🧑‍💻 LLAMACODER UPDATE", answer);
        return;
      }
      const prompt = parts[0].trim();
      const quality = (parts[1] || "low").trim().toLowerCase();
      if (!prompt) throw new Error("Describe the app you want to build.");
      if (!["low", "medium", "high"].includes(quality)) throw new Error("Quality must be low, medium or high.");
      await ctx.reply("🧑‍💻 LlamaCoder is building your app. This may take a few minutes...");
      const payload = await requestExternalJson(API + "/ai/llamacoder", { action: "create", prompt, quality }, 300000);
      if (payload?.success === false || payload?.statusCode >= 400) throw new Error(String(payload?.message || payload?.error || "LlamaCoder failed.").slice(0, 200));
      const sid = at(payload, ["data.sessionId", "sessionId"]);
      if (sid) sessions.set(id, { sessionId: sid });
      const files = payload?.data?.files || payload?.files || [];
      const links = Array.isArray(files) ? files.slice(0, 5).map(file => {
        const url = file?.url || file?.downloadUrl || file?.download_url;
        return url ? String(file.name || file.filename || file.path || "Generated file") + ": " + url : "";
      }).filter(Boolean) : [];
      const summary = [
        at(payload, ["data.message", "message", "data.reply", "reply"]),
        "Files generated: " + String(payload?.data?.filesCount ?? files.length ?? 0),
        ...links,
        sid ? "Session saved. Continue with: " + ctx.config.prefix + "llamacoder followup | your changes" : ""
      ].filter(Boolean).join("\n");
      await reply(ctx, "🧑‍💻 LLAMACODER · APP BUILDER", summary || JSON.stringify(payload.data || payload).slice(0, 2500));
    }
  }
];

export default commands;

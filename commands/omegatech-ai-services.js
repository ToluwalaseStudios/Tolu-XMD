import { requestExternalJson, extractApiText, unicodeBox, withPoweredFooter, validateHttpsUrl } from "../lib/api-client.js";
import { collectBuildFiles, createBuildArchive } from "../lib/project-archive.js";

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
    endpoint: "/ai/Gemini-premuim",
    fields: (message, old) => ({ message, model: "gemini-flash", language: "en", sessionId: old.sessionId || undefined }),
    responsePaths: ["data.response", "data.reply", "response", "reply", "answer"]
  }),
  {
    name: "buildapp",
    aliases: ["llamacoder", "llamacode"],
    category: "AI Media",
    description: "Build a web app, download its complete project ZIP, and refine it with follow-ups.",
    run: async ctx => {
      const raw = textArg(ctx, "describe your app | quality (low/medium/high), download, or followup | instruction", 1800);
      const parts = raw.split("|");
      const actionWord = parts[0].trim().toLowerCase();
      const id = key(ctx, "buildapp");
      const saved = sessions.get(id);

      async function retrieveSession(sessionId) {
        return requestExternalJson(API + "/ai/llamacoder", {
          action: "get_session",
          sessionId
        }, 90000);
      }

      function previewLinks(payload) {
        const results = [];
        const seen = new Set();
        const visit = (value, depth = 0) => {
          if (!value || typeof value !== "object" || depth > 8) return;
          if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
            return;
          }
          for (const [name, child] of Object.entries(value)) {
            if (typeof child === "string" && /(preview|live|deploy|website|public).*url|url.*(preview|live|deploy|website|public)/i.test(name)) {
              try {
                const url = validateHttpsUrl(child, "Buildapp preview");
                if (!seen.has(url)) { seen.add(url); results.push(url); }
              } catch {}
            } else if (child && typeof child === "object") visit(child, depth + 1);
          }
        };
        visit(payload);
        return results.slice(0, 3);
      }

      async function deliverProject(sessionId, initialPayload = null) {
        let sessionPayload = initialPayload;
        try {
          const fetched = await retrieveSession(sessionId);
          if (fetched?.success === false || fetched?.statusCode >= 400) {
            throw new Error(String(fetched?.message || fetched?.error || "Session retrieval failed."));
          }
          sessionPayload = sessionPayload ? { initial: sessionPayload, session: fetched } : fetched;
        } catch (error) {
          if (!sessionPayload) throw new Error("Could not retrieve the saved project: " + String(error?.message || error).slice(0, 160));
        }

        const files = collectBuildFiles(sessionPayload);
        if (!files.length) {
          throw new Error("The build session is saved, but OmegaTech did not return downloadable file contents. Try !buildapp download again in a moment.");
        }
        const archive = await createBuildArchive(files);
        const previews = previewLinks(sessionPayload);
        const captionLines = [
          "✅ Your generated project is attached as a ZIP archive.",
          "📁 Files included: " + files.length,
          "📦 Extract the ZIP to view and edit the source code.",
          ...previews.map((url, index) => (index === 0 ? "🌐 Preview: " : "🌐 Preview " + (index + 1) + ": ") + url)
        ];
        await ctx.send({
          document: archive,
          mimetype: "application/zip",
          fileName: "Buildapp-project.zip",
          caption: withPoweredFooter(unicodeBox("🧑‍💻 BUILDAPP · PROJECT READY", captionLines.join("\n"), { footer: false }), 1800)
        });
        return files.length;
      }

      if (actionWord === "download" || actionWord === "get") {
        if (!saved?.sessionId) throw new Error("No Buildapp session is saved in this bot session. Create an app first with !buildapp describe your app.");
        await ctx.reply("📦 Retrieving your saved Buildapp project...");
        await deliverProject(saved.sessionId);
        return;
      }

      if (actionWord === "followup") {
        if (!saved?.sessionId) throw new Error("No app-building session is saved. Start with !buildapp describe your app.");
        const prompt = parts.slice(1).join("|").trim();
        if (!prompt) throw new Error("Add the change you want after followup |");
        await ctx.reply("🧑‍💻 Buildapp is updating your project...");
        const payload = await requestExternalJson(API + "/ai/llamacoder", {
          action: "followup", prompt, sessionId: saved.sessionId
        }, 180000);
        if (payload?.success === false || payload?.statusCode >= 400) {
          throw new Error(String(payload?.message || payload?.error || "Buildapp update failed.").slice(0, 200));
        }
        const sid = at(payload, ["data.sessionId", "sessionId"]) || saved.sessionId;
        sessions.set(id, { sessionId: sid });
        const answer = at(payload, ["data.message", "data.reply", "message", "reply"]) || "Your changes have been generated.";
        await reply(ctx, "🧑‍💻 BUILDAPP UPDATE", answer);
        try {
          const count = await deliverProject(sid, payload);
          await ctx.reply("✅ Updated project ZIP sent (" + count + " files).");
        } catch (error) {
          await ctx.reply("Your update was saved, but the ZIP could not be prepared yet. Use !buildapp download to retry. " + String(error?.message || error).slice(0, 180));
        }
        return;
      }

      const prompt = parts[0].trim();
      const quality = (parts[1] || "low").trim().toLowerCase();
      if (!prompt) throw new Error("Describe the app you want to build.");
      if (!["low", "medium", "high"].includes(quality)) throw new Error("Quality must be low, medium or high.");
      await ctx.reply("🧑‍💻 Buildapp is building your app. This may take a few minutes...");
      const payload = await requestExternalJson(API + "/ai/llamacoder", {
        action: "create", prompt, quality
      }, 300000);
      if (payload?.success === false || payload?.statusCode >= 400) {
        throw new Error(String(payload?.message || payload?.error || "Buildapp failed.").slice(0, 200));
      }
      const sid = at(payload, ["data.sessionId", "sessionId", "data.session_id", "session_id"]);
      if (!sid) throw new Error("Buildapp returned a result but no session ID, so the project cannot be retrieved for download.");
      sessions.set(id, { sessionId: sid });
      try {
        const count = await deliverProject(sid, payload);
        await ctx.reply("✅ Build complete. Your ZIP contains " + count + " project files. Use !buildapp followup | your changes to continue editing.");
      } catch (error) {
        const message = String(error?.message || error).slice(0, 220);
        await ctx.reply("Build session saved, but the project archive is not ready yet. Use !buildapp download to retry.\n" + message);
      }
    }
  }
];

export default commands;

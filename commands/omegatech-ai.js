import {
  extractApiText,
  requestExternalJson,
  unicodeBox,
  withPoweredFooter
} from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";
const VIDEO_TIMEOUT_MS = 610000;

function validateRatio(value) {
  const ratio = String(value || "auto").trim().toLowerCase();
  const allowed = new Set(["auto", "1:1", "16:9", "9:16", "4:3", "3:4"]);
  if (!allowed.has(ratio)) throw new Error("Unsupported ratio. Use auto, 1:1, 16:9, 9:16, 4:3 or 3:4.");
  return ratio;
}

function validateHttpsUrl(value, label) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("The " + label + " service returned an invalid URL."); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The " + label + " service returned an unsupported URL.");
  }
  return url.toString();
}

function promptFrom(ctx, example, max = 1800) {
  const value = String(ctx.args || "").trim();
  if (!value) throw new Error("Usage: " + ctx.config.prefix + ctx.commandName + " " + example);
  if (value.length > max) throw new Error("Keep the prompt under " + max + " characters.");
  return value;
}

function valueAt(payload, paths) {
  for (const path of paths) {
    let value = payload;
    for (const key of path.split(".")) value = value && value[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function runClaude(ctx) {
  const prompt = promptFrom(ctx, "your question or message", 3500);
  const payload = await requestExternalJson(API + "/ai/Claude", { text: prompt }, 90000);
  const answer = valueAt(payload, ["result", "data.result", "response", "answer", "reply"]) || extractApiText(payload);
  await ctx.reply(withPoweredFooter(unicodeBox("🧠 CLAUDE", answer.slice(0, 3300), { footer: false }), 3800));
}

async function runTextToVideo(ctx) {
  const raw = promptFrom(ctx, "video description | ratio | sound", 1600);
  const [promptPart, ratioPart, soundPart] = raw.split("|");
  const prompt = String(promptPart || "").trim();
  if (!prompt) throw new Error("Enter a video description.");
  const ratio = validateRatio(ratioPart || "auto");
  const soundText = String(soundPart || "true").trim().toLowerCase();
  if (!["true", "false"].includes(soundText)) throw new Error("Sound must be true or false.");
  await ctx.reply("🎬 Your text-to-video request has been submitted. Generation may take several minutes.");
  void (async () => {
    try {
      const payload = await requestExternalJson(API + "/ai/Txt2video", {
        action: "generate", prompt, ratio, sound: soundText
      }, VIDEO_TIMEOUT_MS);
      if (payload?.success === false || payload?.statusCode >= 400) {
        throw new Error(String(payload?.message || payload?.error || "Text-to-video generation failed.").slice(0, 220));
      }
      const video = valueAt(payload, ["data.videoUrl", "videoUrl", "data.url", "url", "result.videoUrl"]);
      if (!video) throw new Error("The video service finished without returning a video URL.");
      const videoUrl = validateHttpsUrl(video, "generated video");
      await ctx.reply({
        video: { url: videoUrl },
        caption: withPoweredFooter(unicodeBox("🎬 OMEGATECH TEXT-TO-VIDEO", "📝 Prompt: " + prompt.slice(0, 600), { footer: false }), 1000)
      });
    } catch (error) {
      await ctx.reply("❌ Text-to-video failed: " + String(error?.message || error).slice(0, 250));
    }
  })();
}

export default [
  {
    name: "claude",
    aliases: [],
    category: "AI Media",
    description: "Chat with Claude AI through OmegaTech.",
    run: runClaude
  },
  {
    name: "txt2video",
    aliases: ["text2video"],
    category: "AI Media",
    description: "Generate a video from text with optional aspect ratio and sound.",
    run: runTextToVideo
  }
];

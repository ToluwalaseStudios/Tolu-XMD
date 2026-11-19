import { Buffer } from "node:buffer";
import {
  extractApiText,
  extractImageUrls,
  requestExternalJson,
  unicodeBox,
  validateHttpsUrl,
  withPoweredFooter
} from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";
const MAX_PROMPT = 1800;
const VIDEO_TIMEOUT_MS = 610000;

function promptFrom(ctx, example, max = MAX_PROMPT) {
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

function imageUrlFrom(payload) {
  return valueAt(payload, [
    "imageUrl", "image_url", "url", "data.imageUrl", "data.image_url",
    "data.url", "result.imageUrl", "result.image_url", "result.url"
  ]) || extractImageUrls(payload)[0] || "";
}

function validateRatio(value, fallback = "auto") {
  const ratio = String(value || fallback).trim().toLowerCase();
  const allowed = new Set(["auto", "1:1", "16:9", "9:16", "4:3", "3:4"]);
  if (!allowed.has(ratio)) throw new Error("Supported ratios: auto, 1:1, 16:9, 9:16, 4:3, 3:4.");
  return ratio;
}

async function sendImageUrl(ctx, title, prompt, value) {
  const url = validateHttpsUrl(value, "generated image");
  await ctx.reply({
    image: { url },
    caption: withPoweredFooter(unicodeBox(title, "📝 Prompt: " + prompt.slice(0, 650), { footer: false }), 1000)
  });
}

async function sendImagePayload(ctx, title, prompt, payload) {
  const url = imageUrlFrom(payload);
  if (url) return sendImageUrl(ctx, title, prompt, url);

  const encoded = valueAt(payload, ["imageBase64", "base64", "data.imageBase64", "data.base64"]);
  if (encoded) {
    const clean = encoded.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    const buffer = Buffer.from(clean, "base64");
    if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
      throw new Error("The image service returned an empty or oversized image.");
    }
    await ctx.reply({
      image: buffer,
      mimetype: "image/png",
      caption: withPoweredFooter(unicodeBox(title, "📝 Prompt: " + prompt.slice(0, 650), { footer: false }), 1000)
    });
    return;
  }
  throw new Error("The image service did not return an image URL or image data.");
}

async function runFreegen(ctx) {
  const raw = promptFrom(ctx, "describe the image you want | optional ratio");
  const [promptPart, ratioPart] = raw.split("|");
  const prompt = String(promptPart || "").trim();
  if (!prompt) throw new Error("Enter an image description.");
  const ratio = validateRatio(ratioPart || "1:1", "1:1");
  const url = new URL(API + "/ai/Freegen");
  url.searchParams.set("action", "generate");
  url.searchParams.set("prompt", prompt);
  url.searchParams.set("ratio", ratio);

  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "image/png,application/json" },
      signal: AbortSignal.timeout(120000)
    });
  } catch {
    throw new Error("Freegen could not be reached. Please try again.");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.message || parsed?.error?.message || parsed?.error || parsed?.detail || "";
    } catch {
      detail = body.replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim();
    }
    throw new Error("Freegen HTTP " + response.status +
      (detail ? ": " + String(detail).slice(0, 240) : " (provider did not explain the failure)."));
  }
  const type = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (type.includes("image/png") || type.includes("image/jpeg") || type.includes("image/webp")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
      throw new Error("Freegen returned an empty or oversized image.");
    }
    const mimetype = type.includes("jpeg") ? "image/jpeg" : type.includes("webp") ? "image/webp" : "image/png";
    await ctx.reply({
      image: buffer,
      mimetype,
      caption: withPoweredFooter(unicodeBox("🆓 OMEGATECH FREEGEN IMAGE", "📝 Prompt: " + prompt.slice(0, 650), { footer: false }), 1000)
    });
    return;
  }
  let payload;
  try { payload = await response.json(); } catch {
    throw new Error("Freegen returned an unsupported response instead of a PNG image.");
  }
  if (payload?.success === false || payload?.statusCode >= 400) {
    throw new Error(String(payload?.message || payload?.error || "Freegen could not generate the image.").slice(0, 220));
  }
  await sendImagePayload(ctx, "🆓 OMEGATECH FREEGEN IMAGE", prompt, payload);
}

async function runAiGen(ctx) {
  const raw = promptFrom(ctx, "image description | model | ratio");
  const [promptPart, modelPart, ratioPart] = raw.split("|");
  const prompt = String(promptPart || "").trim();
  const model = String(modelPart || "photorealistic").trim().toLowerCase();
  const ratio = validateRatio(ratioPart || "1:1", "1:1");
  if (!prompt) throw new Error("Enter an image description before the optional settings.");
  if (model.length > 60 || !/^[a-z0-9_-]+$/.test(model)) throw new Error("Use a simple model/style name such as photorealistic.");
  let payload;
  try {
    payload = await requestExternalJson(API + "/ai/Ai-gen-image", { prompt, model, ratio }, 180000);
  } catch (error) {
    const detail = String(error?.message || error);
    if (/ajax nonce|nonce/i.test(detail)) {
      throw new Error("OmegaTech's image endpoint rejected the request because its AJAX nonce is missing. This is a provider-side requirement; the bot cannot safely invent a nonce. The provider must expose a supported server-to-server request method.");
    }
    throw error;
  }
  if (payload?.success === false || payload?.statusCode >= 400) {
    throw new Error(String(payload?.message || payload?.error || "AI image generation failed.").slice(0, 220));
  }
  await sendImagePayload(ctx, "🎨 OMEGATECH AI IMAGE", prompt, payload);
}

async function runClaude(ctx) {
  const prompt = promptFrom(ctx, "your question or message", 3500);
  const payload = await requestExternalJson(API + "/ai/Claude", { text: prompt }, 90000);
  const answer = valueAt(payload, ["result", "data.result", "response", "answer", "reply"]) || extractApiText(payload);
  await ctx.reply(withPoweredFooter(unicodeBox("🧠 OMEGATECH CLAUDE AI", answer.slice(0, 3300), { footer: false }), 3800));
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

async function runAiVideo(ctx) {
  const raw = promptFrom(ctx, "video description | optional image URL", 1600);
  const [promptPart, imagePart] = raw.split("|");
  const prompt = String(promptPart || "").trim();
  if (!prompt) throw new Error("Enter a video description.");
  const params = { prompt, timeout: 600 };
  if (imagePart && imagePart.trim()) params.imageUrl = validateHttpsUrl(imagePart.trim(), "source image");
  await ctx.reply("🎥 Your AI video request has been submitted. The provider may take up to 10 minutes.");
  void (async () => {
    try {
      const payload = await requestExternalJson(API + "/ai/Ai-video", params, VIDEO_TIMEOUT_MS);
      if (payload?.success === false || payload?.statusCode >= 400) {
        throw new Error(String(payload?.message || payload?.error || "AI video generation failed.").slice(0, 220));
      }
      const video = valueAt(payload, ["videoUrl", "data.videoUrl", "result.videoUrl", "url"]);
      if (!video) throw new Error("The video service finished without returning a video URL.");
      const videoUrl = validateHttpsUrl(video, "generated video");
      let mediaResponse;
      try {
        mediaResponse = await fetch(videoUrl, {
          headers: { accept: "video/mp4,video/webm,video/*;q=0.9,*/*;q=0.1" },
          signal: AbortSignal.timeout(90000),
          redirect: "follow"
        });
      } catch {
        throw new Error("The provider returned a video link, but the actual file could not be downloaded.");
      }
      if (!mediaResponse.ok) {
        throw new Error("The generated video link returned HTTP " + mediaResponse.status + ".");
      }
      const declaredSize = Number(mediaResponse.headers.get("content-length") || 0);
      if (declaredSize > 64 * 1024 * 1024) {
        throw new Error("The generated video exceeds the bot's 64 MB sending limit.");
      }
      const videoBuffer = Buffer.from(await mediaResponse.arrayBuffer());
      if (!videoBuffer.length || videoBuffer.length > 64 * 1024 * 1024) {
        throw new Error("The generated video is empty or exceeds the 64 MB sending limit.");
      }
      const contentType = String(mediaResponse.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const isMp4 = videoBuffer.length > 12 && videoBuffer.toString("ascii", 4, 8) === "ftyp";
      const isWebm = videoBuffer.length >= 4 &&
        videoBuffer[0] === 0x1a && videoBuffer[1] === 0x45 &&
        videoBuffer[2] === 0xdf && videoBuffer[3] === 0xa3;
      if (!isMp4 && !isWebm) {
        throw new Error("OmegaTech returned a link, but its contents are not a valid MP4 or WebM video. No broken video was sent.");
      }
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        throw new Error("OmegaTech returned a webpage/API response instead of a playable video.");
      }
      await ctx.send({
        video: videoBuffer,
        mimetype: isMp4 ? "video/mp4" : "video/webm",
        fileName: isMp4 ? "omegatech-ai-video.mp4" : "omegatech-ai-video.webm",
        caption: withPoweredFooter(unicodeBox("🎥 OMEGATECH AI VIDEO", "📝 Prompt: " + prompt.slice(0, 600), { footer: false }), 1000)
      });
    } catch (error) {
      await ctx.reply("❌ AI video generation failed: " + String(error?.message || error).slice(0, 250));
    }
  })();
}

export default [
  {
    name: "claudeomega",
    aliases: ["omegaclaude"],
    category: "AI Media",
    description: "Chat with the OmegaTech Claude AI endpoint.",
    run: runClaude
  },
  {
    name: "freegen",
    aliases: ["freeimage"],
    category: "AI Media",
    description: "Generate an image using OmegaTech Freegen (PNG endpoint).",
    run: runFreegen
  },
  {
    name: "aigen",
    aliases: ["omegimage"],
    category: "AI Media",
    description: "Generate an AI image with a selectable model/style and aspect ratio.",
    run: runAiGen
  },
  {
    name: "txt2video",
    aliases: ["text2video"],
    category: "AI Media",
    description: "Generate a video from text with optional aspect ratio and sound.",
    run: runTextToVideo
  },
  {
    name: "aivideo",
    aliases: ["image2video"],
    category: "AI Media",
    description: "Generate a video from a prompt, optionally guided by an image URL.",
    run: runAiVideo
  }
];

import { Buffer } from "node:buffer";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { getContextInfo, unwrapMessage } from "../lib/message-utils.js";
import { requestExternalJson, unicodeBox, withPoweredFooter, safeFileName } from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";

function mediaNode(message) {
  const body = unwrapMessage(message?.message || message);
  for (const key of ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"]) {
    if (body?.[key]) return { key, value: body[key] };
  }
  return null;
}

async function runPone(ctx) {
  let target = ctx.msg;
  const info = getContextInfo(ctx.msg?.message);
  if (info?.stanzaId) {
    target = ctx.getMessageByKey({ remoteJid: ctx.jid, id: info.stanzaId });
    if (!target) throw new Error("I couldn't find the replied-to media. Reply to the file again and retry.");
  }
  const media = mediaNode(target);
  if (!media) throw new Error("Attach a file to this command or reply to an image, video, audio or document with !upload.");
  let bytes;
  try {
    bytes = await downloadMediaMessage(target, "buffer", {}, {
      reuploadRequest: ctx.sock.updateMediaMessage
    });
  } catch {
    throw new Error("WhatsApp could not retrieve that attachment. Try sending it again.");
  }
  const buffer = Buffer.from(bytes);
  if (!buffer.length) throw new Error("The attachment is empty.");
  if (buffer.length > 45 * 1024 * 1024) throw new Error("File uploader is limited to 45 MB per file.");
  const node = media.value || {};
  const mime = String(node.mimetype || "application/octet-stream");
  const original = String(node.fileName || node.file_name || (media.key + "-" + Date.now()));
  const filename = safeFileName(original, "toluwalase-upload");
  const form = new FormData();
  form.append("action", "upload");
  form.append("file", new Blob([buffer], { type: mime }), filename);
  let response;
  try {
    response = await fetch(API + "/tools/Pone-uploader", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120000)
    });
  } catch {
    throw new Error("Could not reach File uploader. Try again later.");
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("File uploader returned an unreadable response."); }
  if (!response.ok || payload?.success === false || payload?.statusCode >= 400) {
    throw new Error(String(payload?.message || payload?.error || "Pone upload failed.").slice(0, 200));
  }
  const data = payload?.data || payload?.result || payload;
  const file = Array.isArray(data?.files) ? data.files[0] : data?.file || data;
  const url = String(file?.url || file?.downloadUrl || file?.link || "").trim();
  if (!/^https:\/\//i.test(url)) throw new Error("Pone did not return a valid public file URL.");
  const deleteUrl = String(file?.deleteUrl || file?.delete_url || "").trim();
  const lines = ["📄 File: " + filename, "🔗 URL: " + url];
  if (deleteUrl.startsWith("https://")) lines.push("🗑 Delete link (keep private): " + deleteUrl);
  await ctx.reply(withPoweredFooter(unicodeBox("☁️ FILE UPLOADER", lines.join("\n"), { footer: false }), 2500));
}

function findTrack(payload) {
  const queue = [payload], seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { queue.push(...value); continue; }
    const id = value.videoId || value.video_id || value.videoid ||
      (typeof value.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(value.id) ? value.id : "");
    if (typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id)) return { ...value, videoId: id };
    for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
  }
  return null;
}

async function runMusicSearch(ctx) {
  const query = String(ctx.args || "").trim();
  if (!query) throw new Error("Usage: " + ctx.config.prefix + "play song title or artist");
  if (query.length > 180) throw new Error("Keep the search under 180 characters.");
  const payload = await requestExternalJson(API + "/download/play", { action: "search", query }, 60000);
  const track = findTrack(payload);
  if (!track) throw new Error("YouTube Music search returned no matching track.");
  const title = String(track.title || track.name || track.trackName || query).slice(0, 160);
  const artist = String(track.artist || track.artistName || track.channelName || track.author || "").slice(0, 120);
  const url = "https://music.youtube.com/watch?v=" + track.videoId;
  const lines = ["🎵 " + title, artist ? "🎤 " + artist : "", "▶️ Listen: " + url, "🆔 Video ID: " + track.videoId].filter(Boolean);
  await ctx.reply(withPoweredFooter(unicodeBox("🎧 YOUTUBE MUSIC SEARCH", lines.join("\n"), { footer: false }), 1800));
}

export default [
  {
    name: "play",
    aliases: ["musicsearch"],
    category: "Downloads",
    description: "Search YouTube Music and return the listening link and video ID (does not download media).",
    run: runMusicSearch
  },
  {
    name: "upload",
    aliases: ["uploadfile"],
    category: "Downloads",
    description: "Upload an attached or replied-to file to Pone and return its public link.",
    run: runPone
  }
];

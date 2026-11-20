import { Buffer } from "node:buffer";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { getContextInfo, unwrapMessage } from "../lib/message-utils.js";
import { unicodeBox, withPoweredFooter, safeFileName } from "../lib/api-client.js";

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

export default [
  {
    name: "upload",
    aliases: ["uploadfile"],
    category: "Downloads",
    description: "Upload an attached or replied-to file to Pone and return its public link.",
    run: runPone
  }
];

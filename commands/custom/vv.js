import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { POWERED_FOOTER } from "../../lib/api-client.js";
import { getViewOnceReactionEmoji, setViewOnceReactionEmoji } from "../../lib/bot-settings.js";
import {
  getContextInfo,
  hasViewOnceMarker,
  normalizeJid,
  unwrapMessage
} from "../../lib/message-utils.js";

function getQuotedReference(ctx) {
  const info = getContextInfo(ctx.msg?.message);
  if (!info?.stanzaId) return null;
  return info;
}

/**
 * Prefer the original WebMessageInfo retained by the runtime. WhatsApp's
 * embedded quotedMessage is only a context snippet and may omit mediaKey or
 * other fields required by Baileys' media decrypt/reupload pipeline.
 */
export function resolveQuotedMessage(ctx) {
  const info = getQuotedReference(ctx);
  if (!info) return null;

  const remoteJid = String(ctx.msg?.key?.remoteJid || ctx.jid || "");
  const remoteJidAlt = String(ctx.msg?.key?.remoteJidAlt || "");
  const id = String(info.stanzaId);
  const stored = ctx.getMessageByKey?.({ remoteJid, remoteJidAlt, id });
  const requestedJids = new Set([remoteJid, remoteJidAlt].map(normalizeJid).filter(Boolean));
  const storedJids = new Set([
    stored?.key?.remoteJid,
    stored?.key?.remoteJidAlt
  ].map(normalizeJid).filter(Boolean));
  const chatMatches = [...requestedJids].some(jid => storedJids.has(jid));

  if (stored?.key?.id === id && stored?.message && chatMatches) {
    return {
      message: stored,
      key: stored.key,
      source: "stored"
    };
  }

  // Compatibility fallback for messages that are no longer in the short-lived
  // store. Prefer the richer PN/alternate participant fields when available.
  if (!info.quotedMessage) return null;

  const participant = normalizeJid(
    info.participantPn || info.participantAlt || info.participant || ""
  );
  const selfIds = [
    ctx.sock?.user?.id,
    ctx.sock?.user?.lid
  ].map(normalizeJid).filter(Boolean);

  const key = {
    remoteJid,
    id,
    fromMe: Boolean(participant && selfIds.includes(participant))
  };
  if (remoteJidAlt) key.remoteJidAlt = remoteJidAlt;
  if (participant) key.participant = participant;

  return {
    message: {
      key,
      message: info.quotedMessage,
      messageTimestamp: info.timestamp
    },
    key,
    source: "quoted"
  };
}

function viewOnceMedia(message) {
  const body = unwrapMessage(message);
  if (body.imageMessage) return { kind: "image", media: body.imageMessage };
  if (body.videoMessage) return { kind: "video", media: body.videoMessage };
  if (body.audioMessage) return { kind: "audio", media: body.audioMessage };
  if (body.documentMessage) return { kind: "document", media: body.documentMessage };
  return null;
}

// Baileys may represent view-once media either with a viewOnceMessage*
 // wrapper or as a media node carrying the protobuf viewOnce flag. Use the
 // shared recursive detector so both wire representations are accepted.
export function hasViewOnceWrapper(message) {
  return hasViewOnceMarker(message);
}

const MAX_RECOVERED_MEDIA_ENTRIES = 50;
const MAX_RECOVERED_MEDIA_BYTES = 64 * 1024 * 1024;
const recoveredMediaCache = new Map();
let recoveredMediaBytes = 0;

function recoveredMediaKey(key) {
  return key && key.remoteJid && key.id
    ? String(key.remoteJid) + ":" + String(key.id)
    : "";
}

function getCachedRecoveredMedia(key) {
  const cacheKey = recoveredMediaKey(key);
  const entry = cacheKey && recoveredMediaCache.get(cacheKey);
  if (!entry) return null;
  recoveredMediaCache.delete(cacheKey);
  recoveredMediaCache.set(cacheKey, entry);
  return entry.result;
}

function rememberRecoveredMedia(key, result) {
  const cacheKey = recoveredMediaKey(key);
  const buffer = result?.buffer;
  if (!cacheKey || !Buffer.isBuffer(buffer) || !buffer.length ||
      buffer.length > MAX_RECOVERED_MEDIA_BYTES) return;

  const previous = recoveredMediaCache.get(cacheKey);
  if (previous) {
    recoveredMediaBytes -= previous.size;
    recoveredMediaCache.delete(cacheKey);
  }

  recoveredMediaCache.set(cacheKey, { result, size: buffer.length });
  recoveredMediaBytes += buffer.length;

  while (recoveredMediaCache.size > MAX_RECOVERED_MEDIA_ENTRIES ||
         recoveredMediaBytes > MAX_RECOVERED_MEDIA_BYTES) {
    const oldestKey = recoveredMediaCache.keys().next().value;
    const oldest = recoveredMediaCache.get(oldestKey);
    if (!oldest) break;
    recoveredMediaBytes -= oldest.size;
    recoveredMediaCache.delete(oldestKey);
  }
}

export async function recoverViewOnce(ctx) {
  const reference = resolveQuotedMessage(ctx);
  if (!reference) {
    return {
      error: "Reply to a view-once image, video, voice note or document with " +
        ctx.config.prefix + ctx.command + "."
    };
  }

  const { message: originalMessage, key } = reference;
  const cachedResult = getCachedRecoveredMedia(key);
  if (cachedResult) return cachedResult;

  const quoted = originalMessage.message;
  if (!hasViewOnceWrapper(quoted)) {
    return { error: "The replied-to message is not view-once media." };
  }

  const found = viewOnceMedia(quoted);
  if (!found) {
    return {
      error: "That view-once message carries no downloadable media (view-once stickers and text are not supported)."
    };
  }

  let buffer;
  let downloadError = null;
  try {
    buffer = await downloadMediaMessage(
      originalMessage,
      "buffer",
      {},
      { reuploadRequest: message => ctx.sock.updateMediaMessage(message) }
    );
  } catch (error) {
    downloadError = error;
  }

  // Try Baileys' lower-level stream API if the complete-message downloader fails.
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    try {
      const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
      const stream = await downloadContentFromMessage(found.media, found.kind);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      buffer = Buffer.concat(chunks);
    } catch (fallbackError) {
      const detail = String(fallbackError?.message || downloadError?.message || "unknown download error")
        .replace(/[\r\n\t]+/g, " ").slice(0, 180);
      return {
        error: "I couldn't download this media (Baileys: " + detail +
          "). The bot must have received and stored the original full message."
      };
    }
  }

  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { error: "WhatsApp did not return the view-once media data." };
  }

  const result = { ...found, buffer };
  rememberRecoveredMedia(key, result);
  return result;
}

export function viewOncePayload(result) {
  const content = { [result.kind]: result.buffer };
  const caption = String(result.media?.caption || "").trim();

  if (["image", "video", "document"].includes(result.kind) && caption) {
    content.caption = caption.slice(0, 1000);
  }
  if (result.kind === "image" || result.kind === "video") {
    content.mimetype = result.media?.mimetype ||
      (result.kind === "image" ? "image/jpeg" : "video/mp4");
  }
  if (result.kind === "audio") {
    content.mimetype = result.media?.mimetype || "audio/mpeg";
    content.ptt = Boolean(result.media?.ptt);
  }
  if (result.kind === "document") {
    content.mimetype = result.media?.mimetype || "application/octet-stream";
    content.fileName = String(result.media?.fileName || "view-once").slice(0, 180);
  }
  return content;
}

export function buildViewOnceCaption(result) {
  const originalCaption = String(result?.media?.caption || "").trim().slice(0, 750);
  return [
    "Media extracted from view-once successfully ✅",
    ...(originalCaption ? [originalCaption] : []),
    POWERED_FOOTER
  ].join("\n\n");
}

export async function sendBrandedViewOnce(ctx, result) {
  const payload = viewOncePayload(result);
  const caption = buildViewOnceCaption(result);

  if (result.kind === "audio") {
    await ctx.send(payload);
    await ctx.send({ text: caption });
    return;
  }

  payload.caption = caption;
  await ctx.send(payload);
}

export default [
  {
    name: "vvreact",
    aliases: ["vvemoji"],
    category: "Media & Tools",
    description: "Set an emoji reaction that automatically sends view-once media to your DM.",
    run: async ctx => {
      if (!ctx.owner) {
        await ctx.reply("⛔ Only the bot owner can configure the view-once reaction.");
        return;
      }

      const value = String(ctx.args || "").trim();
      if (!value) {
        const current = await getViewOnceReactionEmoji();
        await ctx.reply(
          "*VIEW-ONCE REACTION TRIGGER*\n\n" +
          "Status: " + (current ? "ON — " + current : "OFF") + "\n\n" +
          "Set: " + ctx.config.prefix + "vvreact <emoji>\n" +
          "Disable: " + ctx.config.prefix + "vvreact off\n\n" +
          "React to a view-once message with your selected emoji and it will be sent to your DM."
        );
        return;
      }

      try {
        const saved = await setViewOnceReactionEmoji(value);
        await ctx.reply(saved
          ? "✅ View-once reaction trigger set to " + saved + ".\nReact to a view-once message with it and the media will be sent to your DM."
          : "✅ Automatic view-once reactions are now OFF.");
      } catch (error) {
        await ctx.reply("⚠️ " + error.message + "\nExample: " + ctx.config.prefix + "vvreact ⚡");
      }
    }
  },
  {
    name: "vv",
    category: "Media & Tools",
    description: "Recover a replied-to view-once media message into this chat.",
    run: async ctx => {
      const result = await recoverViewOnce(ctx);
      if (result.error) {
        await ctx.reply("⚠️ " + result.error);
        return;
      }
      await sendBrandedViewOnce(ctx, result);
    }
  },
  {
    name: "vv2",
    category: "Media & Tools",
    description: "Recover a replied-to view-once media message into your DM with the bot.",
    run: async ctx => {
      const result = await recoverViewOnce(ctx);
      if (result.error) {
        await ctx.reply("⚠️ " + result.error);
        return;
      }

      const target = normalizeJid(ctx.senderJid || "");
      if (!target) {
        await ctx.reply("⚠️ Could not resolve your WhatsApp ID for the DM.");
        return;
      }

      try {
        await ctx.sock.sendMessage(target, viewOncePayload(result));
        await ctx.reply("✅ The media was sent to your private chat with Toluwalase XMD.");
      } catch (error) {
        await ctx.reply("⚠️ Could not send the media to your DM: " +
          String(error?.message || error).slice(0, 180));
      }
    }
  }
];

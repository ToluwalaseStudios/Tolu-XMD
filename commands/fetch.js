import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { safeFileName, unicodeBox, validateHttpUrl } from "../lib/api-client.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 45000;
const MAX_REDIRECTS = 5;

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase().split("%")[0];
  if (value === "::" || value === "::1" || value.startsWith("fc") ||
      value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff")) return true;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    parts[0] >= 224 || (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

async function validatePublicUrl(value) {
  const safe = validateHttpUrl(value, "download");
  const url = new URL(safe);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Links to private or local network addresses are blocked.");
    return url;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("The link's host could not be resolved.");
  }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error("This link resolves to a private or restricted network address and was blocked.");
  }
  return url;
}

async function fetchPublic(urlValue, maxBytes) {
  let url = await validatePublicUrl(urlValue);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Toluwalase-XMD/1.0)",
          accept: "*/*"
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error("The download took too long. Try a smaller file or another link.");
      }
      throw new Error("Could not reach that link. Check that it is public and try again.");
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The website returned an invalid redirect.");
      if (attempt === MAX_REDIRECTS) throw new Error("The link redirected too many times.");
      url = await validatePublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error("The website returned HTTP " + response.status + ".");
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) throw new Error("That file is larger than the " + Math.round(maxBytes / 1024 / 1024) + " MB limit.");

    const chunks = [];
    let total = 0;
    if (!response.body) throw new Error("The website returned an empty response.");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("That file is larger than the " + Math.round(maxBytes / 1024 / 1024) + " MB limit.");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) throw new Error("The website returned an empty file.");
    return {
      buffer,
      contentType: String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(),
      disposition: response.headers.get("content-disposition") || "",
      finalUrl: url.toString()
    };
  }
  throw new Error("Could not follow the download link.");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function pageCandidates(html, baseUrl) {
  const candidates = [];
  const add = (value, score = 5) => {
    if (!value || typeof value !== "string") return;
    try {
      const url = new URL(decodeHtml(value.trim()), baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (url.href === baseUrl) return;
      const item = { url: url.toString(), score };
      if (!candidates.some(existing => existing.url === item.url)) candidates.push(item);
    } catch {}
  };

  const metaPattern = /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:(?:audio|video|image)|twitter:(?:player:stream|image))["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) add(match[1], 0);
  const reverseMeta = /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:(?:audio|video|image)|twitter:(?:player:stream|image))["'][^>]*>/gi;
  for (const match of html.matchAll(reverseMeta)) add(match[1], 0);

  const mediaPattern = /<(?:audio|video|source|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(mediaPattern)) add(match[1], 1);
  const anchorPattern = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attrs = (match[1] + " " + match[3]).toLowerCase();
    const url = match[2];
    const fileLike = /\.(?:mp3|m4a|aac|ogg|opus|wav|flac|mp4|mov|webm|mkv|jpg|jpeg|png|gif|webp|pdf|epub|docx?|pptx?|xlsx?|zip|rar|7z)(?:[?#]|$)/i.test(url);
    add(url, /\bdownload\b/.test(attrs) ? 0 : fileLike ? 2 : 6);
  }

  const scriptUrlPattern = /["']((?:https?:)?\/\/[^"'\s<>]+\.(?:mp3|m4a|aac|ogg|opus|wav|flac|mp4|mov|webm|mkv|jpg|jpeg|png|gif|webp|pdf|epub|docx?|pptx?|xlsx?|zip|rar|7z)(?:\?[^"'\s<>]*)?)["']/gi;
  for (const match of html.matchAll(scriptUrlPattern)) add(match[1], 3);

  return candidates.sort((a, b) => a.score - b.score).slice(0, 12);
}

function fileExtension(url, disposition, contentType) {
  const name = disposition.match(/filename\*?=(?:UTF-8''|["']?)([^;"']+)/i)?.[1];
  const fromName = String(name || "").split(/[\\/]/).pop();
  const fromUrl = new URL(url).pathname.split("/").pop();
  const candidate = (fromName || fromUrl || "").match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  if (candidate) return candidate;
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg",
    "audio/opus": "opus", "audio/wav": "wav", "audio/flac": "flac",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "application/pdf": "pdf", "application/zip": "zip",
    "application/epub+zip": "epub", "application/vnd.rar": "rar",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc", "text/plain": "txt"
  };
  return map[contentType] || "bin";
}

function detectFile(buffer, contentType, extension) {
  const ascii = (start, end) => buffer.toString("ascii", start, end);
  if (ascii(0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  if (ascii(0, 4) === "fLaC") return { kind: "audio", mime: "audio/flac", ext: "flac" };
  if (ascii(0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg", ext: "ogg" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { kind: "audio", mime: "audio/wav", ext: "wav" };
  if (ascii(4, 8) === "ftyp") return { kind: contentType.startsWith("audio/") ? "audio" : "video", mime: contentType.startsWith("audio/") ? "audio/mp4" : "video/mp4", ext: contentType.startsWith("audio/") ? "m4a" : "mp4" };
  if (buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9)) return { kind: "audio", mime: "audio/aac", ext: "aac" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return { kind: "image", mime: "image/png", ext: "png" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { kind: "image", mime: "image/webp", ext: "webp" };
  if (ascii(0, 4) === "%PDF") return { kind: "document", mime: "application/pdf", ext: "pdf" };
  if (ascii(0, 4) === "PK\x03\x04") return { kind: "document", mime: contentType || "application/zip", ext: extension === "epub" || extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : "zip" };
  if (contentType.startsWith("image/")) return { kind: "image", mime: contentType, ext: extension };
  if (contentType.startsWith("audio/")) return { kind: "audio", mime: contentType, ext: extension };
  if (contentType.startsWith("video/")) return { kind: "video", mime: contentType, ext: extension };
  return { kind: "document", mime: contentType || "application/octet-stream", ext: extension || "bin" };
}

function filenameFrom(url, disposition, extension) {
  const supplied = disposition.match(/filename\*?=(?:UTF-8''|["']?)([^;"']+)/i)?.[1];
  let name = supplied ? decodeURIComponent(supplied.replace(/^["']|["']$/g, "")) : "";
  if (!name) name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "download");
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 90);
  if (!name || name === "download" || !/\.[a-z0-9]{1,8}$/i.test(name)) name = (name || "download") + "." + extension;
  return safeFileName(name, "download." + extension);
}

async function retrieveLink(input) {
  const initial = await validatePublicUrl(input);
  let result = await fetchPublic(initial.toString(), MAX_FILE_BYTES);
  if (!result.contentType.includes("text/html") && !result.contentType.includes("application/xhtml")) {
    return result;
  }

  const html = result.buffer.toString("utf8");
  if (html.length > MAX_PAGE_BYTES) throw new Error("That webpage is too large to inspect.");
  const candidates = pageCandidates(html, result.finalUrl);
  if (!candidates.length) {
    throw new Error("I opened the webpage, but could not find a public downloadable file on it.");
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      result = await fetchPublic(candidate.url, MAX_FILE_BYTES);
      if (result.contentType.includes("text/html")) continue;
      return result;
    } catch (error) {
      failures.push(String(error?.message || error));
    }
  }
  throw new Error(failures[0] || "The webpage did not expose a downloadable file.");
}

async function runFetch(ctx) {
  const raw = String(ctx.args || "").trim();
  const input = raw.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.!?]+$/, "");
  if (!input) throw new Error("Usage: " + ctx.config.prefix + ctx.commandName + " https://link-to-file-or-webpage");
  if (input.length > 3000) throw new Error("That link is too long.");

  await ctx.reply(unicodeBox("📥 UNIVERSAL DOWNLOAD", "🔗 Opening your link and looking for its downloadable file..."));
  const result = await retrieveLink(input);
  const extension = fileExtension(result.finalUrl, result.disposition, result.contentType);
  const media = detectFile(result.buffer, result.contentType, extension);
  if (media.kind === "video" && result.buffer.length > 64 * 1024 * 1024) {
    throw new Error("That video exceeds the 64 MB limit.");
  }
  const fileName = filenameFrom(result.finalUrl, result.disposition, media.ext);
  const caption = unicodeBox("✅ DOWNLOAD COMPLETE", [
    "📄 " + fileName,
    "📦 " + (result.buffer.length / (1024 * 1024)).toFixed(2) + " MB",
    "⚡ Powered by Toluwalase Studios"
  ].join("\n"));

  if (media.kind === "image") {
    await ctx.send({ image: result.buffer, mimetype: media.mime, fileName, caption });
  } else if (media.kind === "audio") {
    await ctx.send({ audio: result.buffer, mimetype: media.mime, fileName, ptt: false });
    await ctx.reply(caption);
  } else if (media.kind === "video") {
    await ctx.send({ video: result.buffer, mimetype: media.mime, fileName, caption });
  } else {
    await ctx.send({ document: result.buffer, mimetype: media.mime, fileName, caption });
  }
}

export default {
  name: "fetch",
  aliases: ["download", "dl"],
  category: "Downloads",
  description: "Download a public file from a direct link or try to find a downloadable file on a webpage.",
  run: runFetch
};

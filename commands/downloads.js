import { Buffer } from "node:buffer";
import {
  requestApiJson,
  requestExternalJson,
  safeFileName,
  unicodeBox,
  validateHttpsUrl
} from "../lib/api-client.js";

const AIO_FILE_API = "https://api.zukoxmd.my.id/api/v1/aio/file";

const PLATFORM_HOSTS = Object.freeze({
  fb: ["facebook.com", "fb.com", "fb.watch"],
  twitter: ["x.com", "twitter.com", "t.co"],
  instagram: ["instagram.com", "instagr.am"],
  ytmp4: ["youtube.com", "youtu.be"],
  tiktok: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]
});

function requirePlatformUrl(ctx, label, allowedHosts) {
  const raw = String(ctx.args || "").trim().split(/\s+/)[0];
  if (!raw) throw new Error("Usage: " + ctx.config.prefix + ctx.commandName + " https://...");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid " + label + " link.");
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some(suffix => host === suffix || host.endsWith("." + suffix));
  if (url.protocol !== "https:" || url.username || url.password || !allowed) {
    throw new Error("That is not a supported public " + label + " URL.");
  }
  return url.toString();
}

function responseData(payload) {
  return payload?.data?.data || payload?.data || payload?.result || payload || {};
}

function safeMediaUrl(value, label = "media") {
  try {
    return validateHttpsUrl(value, label);
  } catch {
    return "";
  }
}

function chooseMedia(data) {
  const medias = Array.isArray(data?.medias) ? data.medias :
    Array.isArray(data?.media) ? data.media : [];
  const bestIndex = Number(data?.best?.index);
  const bestMatch = Number.isInteger(bestIndex)
    ? medias.find(item => Number(item?.index) === bestIndex)
    : null;
  const candidates = [bestMatch, data?.best, ...medias, data];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const url = [item.url, item.directUrl, item.downloadUrl, item.proxyUrl]
      .map(value => safeMediaUrl(value))
      .find(Boolean);
    if (url) return { item, url };
  }
  return null;
}

function extensionOf(item, url) {
  const declared = String(item?.extension || item?.ext || "").toLowerCase().replace(/^\./, "");
  if (/^[a-z0-9]{2,8}$/.test(declared)) return declared;
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]{2,8})$/i)?.[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function mediaKind(item, extension, fallbackKind = "document") {
  const type = String(item?.type || item?.mimeType || item?.mime || "").toLowerCase();
  if (item?.isImage || type.includes("image") || ["jpg", "jpeg", "png", "webp", "gif"].includes(extension)) return "image";
  if (item?.isAudio || type.includes("audio") || ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"].includes(extension)) return "audio";
  if (item?.isVideo || type.includes("video") || ["mp4", "m4v", "mov", "webm", "mkv", "3gp"].includes(extension)) return "video";
  return fallbackKind;
}

async function fetchMediaFile(url, expectedKind = "document") {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "video/mp4,video/*,audio/*,image/*,application/octet-stream;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(90000),
      redirect: "follow"
    });
  } catch {
    throw new Error("Could not retrieve the actual media file from the provider.");
  }

  if (!response.ok) throw new Error("The media provider returned HTTP " + response.status + ".");
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 64 * 1024 * 1024) {
    throw new Error("The media file is larger than the bot's 64 MB download limit.");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("The provider returned an empty media file.");
  if (bytes.length > 64 * 1024 * 1024) {
    throw new Error("The media file is larger than the bot's 64 MB download limit.");
  }

  const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const is = (offset, signature) => signature.every((value, index) => bytes[offset + index] === value);
  const mp4 = bytes.length > 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  const wav = bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WAVE";
  const aac = bytes.length > 2 && bytes[0] === 0xff &&
    (bytes[1] === 0xf1 || bytes[1] === 0xf9);
  const webm = is(0, [0x1a, 0x45, 0xdf, 0xa3]);
  const mp3 = bytes.toString("ascii", 0, 3) === "ID3" ||
    (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const ogg = is(0, [0x4f, 0x67, 0x67, 0x53]);
  const flac = bytes.toString("ascii", 0, 4) === "fLaC";
  const jpeg = is(0, [0xff, 0xd8, 0xff]);
  const png = is(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";

  if (mp4 && (expectedKind === "audio" || type.startsWith("audio/"))) {
    return { buffer: bytes, mimetype: "audio/mp4", extension: "m4a", kind: "audio" };
  }
  if (mp4) return { buffer: bytes, mimetype: "video/mp4", extension: "mp4", kind: "video" };
  if (webm && (expectedKind === "audio" || type.startsWith("audio/"))) {
    return { buffer: bytes, mimetype: "audio/webm", extension: "webm", kind: "audio" };
  }
  if (webm) return { buffer: bytes, mimetype: "video/webm", extension: "webm", kind: "video" };
  if (aac) return { buffer: bytes, mimetype: "audio/aac", extension: "aac", kind: "audio" };
  if (mp3) return { buffer: bytes, mimetype: "audio/mpeg", extension: "mp3", kind: "audio" };
  if (ogg) return { buffer: bytes, mimetype: "audio/ogg", extension: "ogg", kind: "audio" };
  if (flac) return { buffer: bytes, mimetype: "audio/flac", extension: "flac", kind: "audio" };
  if (wav) return { buffer: bytes, mimetype: "audio/wav", extension: "wav", kind: "audio" };
  if (type.startsWith("audio/")) {
    const audioExtensions = {
      "audio/mpeg": ["mp3", "audio/mpeg"],
      "audio/mp3": ["mp3", "audio/mpeg"],
      "audio/mp4": ["m4a", "audio/mp4"],
      "audio/aac": ["aac", "audio/aac"],
      "audio/ogg": ["ogg", "audio/ogg"],
      "audio/opus": ["opus", "audio/opus"],
      "audio/flac": ["flac", "audio/flac"],
      "audio/wav": ["wav", "audio/wav"],
      "audio/webm": ["webm", "audio/webm"]
    };
    const [extension, mimetype] = audioExtensions[type] || ["bin", type];
    return { buffer: bytes, mimetype, extension, kind: "audio" };
  }
  if (jpeg) return { buffer: bytes, mimetype: "image/jpeg", extension: "jpg", kind: "image" };
  if (png) return { buffer: bytes, mimetype: "image/png", extension: "png", kind: "image" };
  if (webp) return { buffer: bytes, mimetype: "image/webp", extension: "webp", kind: "image" };

  if (type.includes("text/html") || type.includes("application/json") ||
      bytes.toString("utf8", 0, Math.min(bytes.length, 120)).trimStart().startsWith("<")) {
    throw new Error("The provider returned a webpage or API response instead of the actual video. Try another link.");
  }
  throw new Error("The provider returned an unsupported or damaged media file. No broken attachment was sent.");
}

async function sendDownloadedMedia(ctx, url, title, item = {}, fallbackKind = "document") {
  const cleanTitle = String(title || "Toluwalase-XMD download").replace(/[\r\n*_\x60~]/g, " ").trim().slice(0, 150);
  const caption = unicodeBox("📥 DOWNLOAD READY", [
    "✅ *" + cleanTitle + "*",
    item.quality ? "✨ Quality: " + String(item.quality).slice(0, 50) : "",
    item.size ? "📦 Size: " + String(item.size).slice(0, 50) : ""
  ].filter(Boolean).join("\n"), { footer: true });

  const media = await fetchMediaFile(url, fallbackKind);
  const fileName = safeFileName(cleanTitle, "Toluwalase-XMD-download") + "." + media.extension;

  if (media.kind === "video") {
    await ctx.send({ video: media.buffer, mimetype: media.mimetype, fileName, caption });
  } else if (media.kind === "audio") {
    await ctx.send({ audio: media.buffer, mimetype: media.mimetype, fileName, ptt: false });
    await ctx.reply(caption);
  } else if (media.kind === "image") {
    await ctx.send({ image: media.buffer, mimetype: media.mimetype, fileName, caption });
  } else {
    throw new Error("The provider returned a file type WhatsApp cannot preview as media.");
  }
}
async function runAio(ctx, sourceUrl, label = "ALL-IN-ONE") {
  await ctx.reply(unicodeBox("📥 " + label + " DOWNLOAD",
    "🔗 Source: " + sourceUrl + "\n\nFetching the actual media file...", { footer: false }));
  const fileUrl = new URL(AIO_FILE_API);
  fileUrl.searchParams.set("url", sourceUrl);
  await sendDownloadedMedia(ctx, fileUrl.toString(), label + " media");
}

function findSpotifyTrack(payload) {
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const title = value.name || value.title || value.trackName;
    const spotifyUrl = value.external_urls?.spotify || value.spotifyUrl ||
      value.trackUrl || value.url;
    const trackId = value.id || value.trackId;
    if (typeof title === "string" && title.trim() &&
        (typeof spotifyUrl === "string" && /open\.spotify\.com\/track\//i.test(spotifyUrl) ||
         typeof trackId === "string" && /^[A-Za-z0-9]{22}$/.test(trackId))) return value;
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

function findAudioDownloadUrl(payload) {
  const queue = [payload];
  const seen = new Set();
  const candidates = [];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /^https:\/\//i.test(child)) {
        const priority = /mp3|audio|download|file|url|link/i.test(key) ? 0 : 1;
        candidates.push({ url: child, priority });
      } else if (child && typeof child === "object") {
        queue.push(child);
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  for (const candidate of candidates) {
    const url = safeMediaUrl(candidate.url, "full song audio");
    if (url) return url;
  }
  return "";
}

function findYouTubeMusicTrack(payload) {
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const videoId = value.videoId || value.video_id || value.videoid ||
      value.youtubeId || value.youtube_id ||
      (typeof value.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(value.id) ? value.id : "");
    if (typeof videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return { ...value, videoId };
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

async function downloadFromAppleMusic(query) {
  const catalog = await requestExternalJson("https://itunes.apple.com/search", { term: query, entity: "song", limit: 10, country: "ng" }, 45000);
  const tracks = Array.isArray(catalog?.results) ? catalog.results : [];
  if (!tracks.length) throw new Error("Apple Music search returned no matching tracks.");
  const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const track = tracks.find(item => String(item.trackName || "").toLowerCase() === normalized) || tracks.find(item => (String(item.trackName || "") + " " + String(item.artistName || "")).toLowerCase().includes(normalized)) || tracks[0];
  const trackUrl = safeMediaUrl(track.trackViewUrl, "Apple Music track page");
  if (!trackUrl) throw new Error("Apple Music search did not return a valid track page.");
  const payload = await requestExternalJson("https://api.omegatech.app/api/Search/Applemusic", { action: "download", query, url: trackUrl }, 90000);
  const audioUrl = findAudioDownloadUrl(payload);
  if (!audioUrl) throw new Error("Apple Music provider returned no audio download URL.");
  const data = responseData(payload);
  return { audioUrl, title: [data.title || track.trackName || query, data.artist || track.artistName || ""].filter(Boolean).join(" - ") };
}
async function downloadFromYouTubeMusic(query) {
  const search = await requestExternalJson(
    "https://api.omegatech.app/api/download/play",
    { action: "search", query },
    60000
  );
  const track = findYouTubeMusicTrack(search);
  if (!track) throw new Error("The alternate music search returned no playable track.");
  const download = await requestExternalJson(
    "https://api.omegatech.app/api/download/play",
    { action: "download", videoId: track.videoId, format: "mp3" },
    90000
  );
  const audioUrl = findAudioDownloadUrl(download);
  if (!audioUrl) {
    const detail = String(download?.message || download?.error || "").slice(0, 160);
    throw new Error(detail || "The alternate music provider did not return an audio file.");
  }
  const title = String(track.title || track.name || track.trackName || query)
    .replace(/[\r\n*_\x60~]/g, " ").slice(0, 130);
  const artist = String(track.artist || track.artistName || track.channelName || track.author || "")
    .replace(/[\r\n*_\x60~]/g, " ").slice(0, 100);
  return { audioUrl, title: artist ? title + " - " + artist : title };
}

function providerItems(payload) {
  const data = payload?.data?.data || payload?.data || payload?.result || payload;
  return Array.isArray(data?.items) ? data.items : [];
}

function findProviderAudioUrl(payload) {
  const queue = [payload], seen = new Set(), found = [];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { queue.push(...value); continue; }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /^https:\/\//i.test(child)) {
        const k = key.toLowerCase();
        if (/audio|mp3|stream|download|media|file|source|url/i.test(k) &&
            !/image|thumbnail|cover|artwork|photo|youtube|page|webpage/i.test(k)) {
          found.push({ url: child, score: /mp3|audio|stream|download/i.test(k) ? 0 : 1 });
        }
      } else if (child && typeof child === "object") queue.push(child);
    }
  }
  found.sort((a, b) => a.score - b.score);
  for (const item of found) {
    const url = safeMediaUrl(item.url, "song audio");
    if (url) return url;
  }
  return "";
}

function bestAudiomackItem(items, query) {
  const q = query.toLowerCase();
  return items.find(item => String(item.title || "").toLowerCase() === q) ||
    items.find(item => (String(item.title || "") + " " + String(item.artist || "")).toLowerCase().includes(q)) ||
    items.find(item => item.type === "song") || items[0];
}

function bestCeenaijaItem(items, query) {
  const q = query.toLowerCase();
  return items.find(item => String(item.song || "").toLowerCase() === q) ||
    items.find(item => (String(item.song || "") + " " + String(item.artist || "")).toLowerCase().includes(q)) ||
    items.find(item => item.hasAudio) || items[0];
}

async function downloadFromAudiomack(query) {
  const search = await requestExternalJson(
    "https://api.omegatech.app/api/download/audiomack",
    { action: "search", q: query, show: "songs", limit: 10, page: 1 },
    45000
  );
  const item = bestAudiomackItem(providerItems(search), query);
  if (!item) throw new Error("Audiomack search returned no songs.");
  const params = { action: "stream" };
  if (item.artistSlug) params.artist = item.artistSlug;
  if (item.slug) params.slug = item.slug;
  if (!item.artistSlug || !item.slug) {
    if (item.pageUrl) params.url = item.pageUrl;
    else if (item.id) params.id = item.id;
  }
  const stream = await requestExternalJson(
    "https://api.omegatech.app/api/download/audiomack",
    params,
    90000
  );
  const audioUrl = findProviderAudioUrl(stream);
  if (!audioUrl) throw new Error("Audiomack stream response contained no audio URL.");
  return { audioUrl, title: [item.title, item.artist].filter(Boolean).join(" - ") || query };
}

async function downloadFromCeenaija(query) {
  const search = await requestExternalJson(
    "https://api.omegatech.app/api/download/ceenaija",
    { action: "search", q: query, page: 1, limit: 10 },
    45000
  );
  const item = bestCeenaijaItem(providerItems(search), query);
  if (!item) throw new Error("Ceenaija search returned no songs.");
  if (item.hasAudio === false) throw new Error("The selected Ceenaija result has no audio.");
  const params = { action: "info" };
  if (item.id != null) params.id = item.id;
  else if (item.link) params.url = item.link;
  else throw new Error("Ceenaija result did not include an info identifier.");
  const info = await requestExternalJson(
    "https://api.omegatech.app/api/download/ceenaija",
    params,
    90000
  );
  const audioUrl = findProviderAudioUrl(info);
  if (!audioUrl) throw new Error("Ceenaija info response contained no audio URL.");
  return {
    audioUrl,
    title: item.fullTitle || [item.song, item.artist].filter(Boolean).join(" - ") || query
  };
}

async function runSong(ctx) {
  const query = String(ctx.args || "").trim();
  if (!query) throw new Error("Usage: " + ctx.config.prefix + ctx.commandName + " song title or artist");
  if (query.length > 180) throw new Error("Keep the song search under 180 characters.");
  await ctx.reply("🎵 Searching available music providers for your song...");
  const failures = [];
  for (const [provider, downloader] of [
    ["Apple Music", downloadFromAppleMusic],
    ["OmegaTech Play", downloadFromYouTubeMusic],
    ["Audiomack", downloadFromAudiomack],
    ["Ceenaija", downloadFromCeenaija]
  ]) {
    try {
      const result = await downloader(query);
      const cleanTitle = String(result.title).replace(/[\r\n*_~]/g, " ").slice(0, 150);
      await ctx.reply("⬇️ Found *" + cleanTitle + "* on " + provider + ". Sending the audio...");
      await sendDownloadedMedia(ctx, result.audioUrl, result.title, {
        isAudio: true, type: "audio/mpeg", extension: "mp3"
      }, "audio");
      return;
    } catch (error) {
      failures.push(provider + ": " + String(error?.message || error).slice(0, 150));
    }
  }
  throw new Error("Could not retrieve the full audio from the configured providers. " + failures.join(" | "));
}

async function runYouTubeVideo(ctx) {
  const url = requirePlatformUrl(ctx, "YouTube", PLATFORM_HOSTS.ytmp4);
  await ctx.reply("🎬 Preparing the YouTube video download...");
  const payload = await requestApiJson("ytv", { url }, 90000);
  const data = payload?.results || payload?.result || payload?.data || {};
  const downloadUrl = safeMediaUrl(data.downloadUrl || data.download || data.url, "video");
  if (!downloadUrl) throw new Error("No valid video download URL was returned.");
  await sendDownloadedMedia(ctx, downloadUrl, data.title || "YouTube video", {
    type: "video/mp4",
    extension: "mp4",
    quality: data.quality || "available"
  });
}

export default [
  {
    name: "aio",
    category: "Downloads",
    description: "Download supported public media links through the LUMINA all-in-one provider.",
    run: async ctx => {
      const url = requirePlatformUrl(ctx, "supported media", [
        ...PLATFORM_HOSTS.fb, ...PLATFORM_HOSTS.twitter, ...PLATFORM_HOSTS.instagram,
        ...PLATFORM_HOSTS.ytmp4, ...PLATFORM_HOSTS.tiktok
      ]);
      await runAio(ctx, url);
    }
  },
  {
    name: "fb",
    category: "Downloads",
    description: "Download a Facebook video using the all-in-one media provider.",
    run: async ctx => runAio(ctx, requirePlatformUrl(ctx, "Facebook", PLATFORM_HOSTS.fb), "FACEBOOK")
  },
  {
    name: "twitter",
    category: "Downloads",
    description: "Download a public X/Twitter video using the all-in-one media provider.",
    run: async ctx => runAio(ctx, requirePlatformUrl(ctx, "X/Twitter", PLATFORM_HOSTS.twitter), "X / TWITTER")
  },
  {
    name: "instagram",
    category: "Downloads",
    description: "Download public Instagram media using the all-in-one media provider.",
    run: async ctx => runAio(ctx, requirePlatformUrl(ctx, "Instagram", PLATFORM_HOSTS.instagram), "INSTAGRAM")
  },
  {
    name: "ytmp4",
    category: "Downloads",
    description: "Download public YouTube media using the all-in-one media provider.",
    run: async ctx => runAio(ctx, requirePlatformUrl(ctx, "YouTube", PLATFORM_HOSTS.ytmp4), "YOUTUBE")
  },
  {
    name: "tiktok",
    aliases: ["ttdl"],
    category: "Downloads",
    description: "Download public TikTok media using the all-in-one media provider.",
    run: async ctx => runAio(ctx, requirePlatformUrl(ctx, "TikTok", PLATFORM_HOSTS.tiktok), "TIKTOK")
  },
  {
    name: "song",
    aliases: ["play2", "ytsearch", "musicsearch"],
    category: "Downloads",
    description: "Search configured music providers and send audio for content you are authorised to download.",
    run: runSong
  },
  {
    name: "ytvideo",
    category: "Downloads",
    description: "Download an authorised YouTube video using its URL.",
    run: runYouTubeVideo
  }
];

import { Buffer } from "node:buffer";

const MAX_FILES = 80;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

function safeArchivePath(value, fallback) {
  const normalized = String(value || fallback || "generated-file")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(part => part && part !== "." && part !== "..")
    .map(part => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").slice(0, 100))
    .join("/");
  return normalized.slice(0, 240) || "generated-file";
}

function fileRecord(value, fallbackName = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = value.path || value.filePath || value.filename || value.fileName || value.name || fallbackName;
  const content = value.content ?? value.contents ?? value.code ?? value.source ?? value.text;
  const url = value.downloadUrl || value.download_url || value.fileUrl || value.file_url || value.url;
  if (!name || (typeof content !== "string" && !Buffer.isBuffer(content) && typeof url !== "string")) return null;
  return { name: safeArchivePath(name, fallbackName), content, url, encoding: value.encoding };
}

export function collectBuildFiles(payload) {
  const found = [];
  const seen = new Set();
  const visit = (value, depth = 0, hinted = false, fallbackName = "") => {
    if (depth > 9 || value == null || found.length >= MAX_FILES) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, true);
      return;
    }
    if (typeof value === "string") {
      if (hinted && fallbackName && value.trim()) {
        found.push({ name: safeArchivePath(fallbackName), content: value });
      }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (hinted) {
      const record = fileRecord(value, fallbackName);
      if (record) {
        found.push(record);
        return;
      }
      for (const [name, child] of Object.entries(value)) {
        if (typeof child === "string" && /\.(html?|css|js|jsx|tsx?|json|md|svg|txt|ya?ml|xml|sql|py|java|kt|sh|env\.example)$/i.test(name)) {
          found.push({ name: safeArchivePath(name), content: child });
        } else if (child && typeof child === "object") {
          visit(child, depth + 1, true, name);
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (/^(files?|generatedFiles|projectFiles|fileMap|artifacts|outputFiles)$/i.test(key)) {
        visit(child, depth + 1, true);
      } else if (child && typeof child === "object" && /^(data|result|project|session|output|response)$/i.test(key)) {
        visit(child, depth + 1, false);
      }
    }
  };
  visit(payload);
  const unique = new Map();
  for (const file of found) {
    if (!unique.has(file.name)) unique.set(file.name, file);
  }
  return [...unique.values()].slice(0, MAX_FILES);
}

async function fileBytes(file) {
  if (Buffer.isBuffer(file.content)) return file.content;
  if (typeof file.content === "string") {
    return file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8");
  }
  if (typeof file.url !== "string") throw new Error("A generated project file has no content or download URL.");
  let url;
  try { url = new URL(file.url); } catch { throw new Error("Buildapp returned an invalid file URL."); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.hostname === "localhost" ||
      url.hostname.endsWith(".local") || url.hostname.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) {
    throw new Error("Buildapp returned an unsupported project file URL.");
  }
  const response = await fetch(url, {
    redirect: "follow",
    headers: { accept: "application/octet-stream,*/*;q=0.8" },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error("Could not download generated file " + file.name + " (HTTP " + response.status + ").");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_FILE_BYTES) throw new Error("Generated file " + file.name + " exceeds the 4 MB per-file limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Generated file " + file.name + " was empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Generated file " + file.name + " exceeds the 4 MB per-file limit.");
  return bytes;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export async function createBuildArchive(files) {
  if (!Array.isArray(files) || !files.length) throw new Error("Buildapp did not return any downloadable project files.");
  const localParts = [];
  const centralParts = [];
  const stamp = dosDateTime();
  let offset = 0;
  let total = 0;

  for (const file of files.slice(0, MAX_FILES)) {
    const name = safeArchivePath(file.name);
    const nameBytes = Buffer.from(name, "utf8");
    const data = await fileBytes(file);
    total += data.length;
    if (data.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error("The generated project exceeds the 24 MB WhatsApp archive limit.");
    }
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

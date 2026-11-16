const WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "deviceSentMessage"
];

export function normalizeJid(value) {
  if (typeof value !== "string" || !value.includes("@")) return "";
  const [name, ...domain] = value.trim().toLowerCase().split("@");
  return name.split(":")[0] + "@" + domain.join("@");
}

export function numberFromJid(value) {
  return String(value || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

export function unwrapMessage(message) {
  let current = message;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth += 1) {
    const wrapper = WRAPPER_KEYS.find(key => current[key] && current[key].message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current || {};
}

export function messageText(message) {
  const value = unwrapMessage(message);
  return String(
    value.conversation ||
    value.extendedTextMessage?.text ||
    value.imageMessage?.caption ||
    value.videoMessage?.caption ||
    value.documentMessage?.caption ||
    value.buttonsResponseMessage?.selectedDisplayText ||
    value.listResponseMessage?.title ||
    value.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  ).trim();
}

export function getContextInfo(message) {
  const preferredKeys = [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
    "buttonsResponseMessage",
    "listResponseMessage",
    "templateButtonReplyMessage"
  ];
  const seen = new Set();

  function find(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return null;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return null;
    seen.add(value);

    if (value.contextInfo && typeof value.contextInfo === "object") {
      return value.contextInfo;
    }

    for (const key of preferredKeys) {
      const found = find(value[key], depth + 1);
      if (found) return found;
    }

    for (const [key, child] of Object.entries(value)) {
      if (preferredKeys.includes(key) || key === "contextInfo") continue;
      const found = find(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return find(message);
}

export function getMessageSender(msg, sock) {
  const key = msg?.key || {};
  if (key.participant) return normalizeJid(key.participantAlt || key.participant);
  if (key.fromMe) return normalizeJid(sock?.user?.id || sock?.user?.lid || key.remoteJid);
  return normalizeJid(key.remoteJidAlt || key.remoteJid);
}


export function hasViewOnceMarker(message) {
  const wrapperKeys = new Set([
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension"
  ]);
  const mediaKeys = new Set([
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage"
  ]);
  const seen = new Set();

  function inspect(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) {
      return false;
    }
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (wrapperKeys.has(key)) return true;
      if (mediaKeys.has(key) && child && typeof child === "object" &&
          child.viewOnce === true) return true;
      if (child && typeof child === "object" && key !== "contextInfo" &&
          inspect(child, depth + 1)) return true;
    }
    return false;
  }

  return inspect(message);
}

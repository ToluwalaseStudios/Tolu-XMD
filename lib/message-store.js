import { normalizeJid } from "./message-utils.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

function makeKey(key) {
  const jid = normalizeJid(key?.remoteJid || "");
  const id = String(key?.id || "");
  return jid && id ? jid + ":" + id : "";
}

/** Short-lived in-memory store of incoming Baileys WebMessageInfo objects. */
export function createRecentMessageStore({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now()
} = {}) {
  const entries = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.savedAt < cutoff) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  function remember(message) {
    const key = makeKey(message?.key);
    if (!key || !message?.message) return false;
    prune();
    entries.delete(key);
    entries.set(key, { message, savedAt: now() });
    prune();
    return true;
  }

  function get(key) {
    prune();
    const cacheKey = makeKey(key);
    const entry = cacheKey && entries.get(cacheKey);
    if (!entry) return null;
    entries.delete(cacheKey);
    entries.set(cacheKey, entry);
    return entry.message;
  }

  return { remember, get, clear: () => entries.clear(), get size() { prune(); return entries.size; } };
}

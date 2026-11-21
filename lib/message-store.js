import { normalizeJid } from "./message-utils.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1500;

function messageAliases(key) {
  return [...new Set([
    normalizeJid(key?.remoteJid || ""),
    normalizeJid(key?.remoteJidAlt || "")
  ].filter(Boolean))];
}

function aliasKey(jid, id) {
  return jid && id ? jid + ":" + id : "";
}

/**
 * Short-lived store of full incoming Baileys WebMessageInfo objects.
 * Both PN and LID chat identifiers are indexed when Baileys supplies them.
 */
export function createRecentMessageStore({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now()
} = {}) {
  const entries = new Map();
  const aliases = new Map();

  function removeEntry(primaryKey, entry) {
    entries.delete(primaryKey);
    for (const jid of entry.jids) {
      const indexedKey = aliasKey(jid, entry.id);
      if (aliases.get(indexedKey) === primaryKey) aliases.delete(indexedKey);
    }
  }

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.savedAt < cutoff) removeEntry(key, entry);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.entries().next().value;
      if (!oldest) break;
      removeEntry(oldest[0], oldest[1]);
    }
  }

  function remember(message) {
    const id = String(message?.key?.id || "");
    const jids = messageAliases(message?.key);
    if (!id || !jids.length || !message?.message) return false;

    prune();
    const existingPrimaryKey = jids
      .map(jid => aliases.get(aliasKey(jid, id)))
      .find(Boolean);
    if (existingPrimaryKey) {
      const previous = entries.get(existingPrimaryKey);
      if (previous) removeEntry(existingPrimaryKey, previous);
    }

    const primaryKey = aliasKey(jids[0], id);
    const entry = { message, id, jids, savedAt: now() };
    entries.set(primaryKey, entry);
    for (const jid of jids) aliases.set(aliasKey(jid, id), primaryKey);
    prune();
    return true;
  }

  function findEntry(key) {
    const id = String(key?.id || "");
    if (!id) return null;
    for (const jid of messageAliases(key)) {
      const primaryKey = aliases.get(aliasKey(jid, id));
      const entry = primaryKey ? entries.get(primaryKey) : null;
      if (entry) return [primaryKey, entry];
    }
    return null;
  }

  function get(key) {
    prune();
    const found = findEntry(key);
    if (!found) return null;
    const [primaryKey, entry] = found;
    entries.delete(primaryKey);
    entries.set(primaryKey, entry);
    return entry.message;
  }

  function getMessage(key) {
    return get(key)?.message || undefined;
  }

  return {
    remember,
    get,
    getMessage,
    clear: () => {
      entries.clear();
      aliases.clear();
    },
    get size() {
      prune();
      return entries.size;
    }
  };
}

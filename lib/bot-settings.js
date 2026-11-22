
import path from "node:path";
import { createJsonStateStore } from "./state-store.js";

const dataDirectory = path.resolve(
  process.env.TOLUWALASE_DATA_DIR || process.env.FEI_DATA_DIR || "./data"
);

const store = createJsonStateStore({
  filePath: path.join(dataDirectory, "bot-settings.json"),
  defaults: {
    prefix: "!",
    mode: String(process.env.BOT_MODE || "public").toLowerCase() === "private" ? "private" : "public"
  }
});

export async function getBotPrefix(fallback = "!") {
  const state = await store.load();

  return typeof state.prefix === "string" && state.prefix.trim()
    ? state.prefix.trim()
    : fallback;
}

export async function setBotPrefix(value) {
  const prefix = String(value || "").trim();

  if (!prefix || prefix.length > 3 || /\s/.test(prefix)) {
    throw new Error("Prefix must contain 1–3 non-space characters.");
  }

  await store.set("prefix", prefix);
  return prefix;
  }


export async function getBotMode(fallback = "public") {
  const state = await store.load();
  const mode = String(state.mode || "").toLowerCase();
  return mode === "private" || mode === "public" ? mode : fallback;
}

export async function setBotMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode !== "public" && mode !== "private") {
    throw new Error("Mode must be either public or private.");
  }
  await store.set("mode", mode);
  return mode;
}


/** Return the configured single-emoji trigger, or an empty string when disabled. */
export async function getViewOnceReactionEmoji() {
  const state = await store.load();
  return typeof state.viewOnceReactionEmoji === "string"
    ? state.viewOnceReactionEmoji
    : "";
}

export async function setViewOnceReactionEmoji(value) {
  const emoji = String(value || "").trim();
  if (emoji && emoji.toLowerCase() !== "off") {
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)];
    if (segments.length !== 1 || !/[\\p{Extended_Pictographic}\\p{Regional_Indicator}]/u.test(emoji)) {
      throw new Error("Enter exactly one emoji, or use off to disable the trigger.");
    }
  }
  const saved = emoji.toLowerCase() === "off" ? "" : emoji;
  await store.set("viewOnceReactionEmoji", saved);
  return saved;
}

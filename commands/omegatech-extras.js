import {
  requestExternalJson,
  unicodeBox,
  withPoweredFooter
} from "../lib/api-client.js";

const API = "https://api.omegatech.app/api";

function outputText(payload, limit = 3400) {
  const value = payload?.data ?? payload?.result ?? payload;
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text || text === "{}") throw new Error("MovieBox returned an empty response.");
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function parseMovieArgs(raw) {
  const [actionRaw, ...rest] = String(raw || "").trim().split(/\s+/);
  const action = String(actionRaw || "").toLowerCase();
  if (!["home", "trending", "search", "detail", "play", "download"].includes(action)) {
    throw new Error("Usage: " + "moviebox home | trending | search <title> | detail <subjectId> | play <subjectId> [season] [episode] | download <subjectId> [season] [episode]");
  }
  return { action, args: rest };
}

async function runMovieBox(ctx) {
  const { action, args } = parseMovieArgs(ctx.args);
  const params = { action };
  if (action === "search") {
    const keyword = args.join(" ").trim();
    if (!keyword) throw new Error("Usage: " + ctx.config.prefix + "moviebox search <movie title>");
    params.keyword = keyword;
    params.page = 1;
    params.perPage = 10;
  } else if (action === "detail") {
    if (!args[0]) throw new Error("Usage: " + ctx.config.prefix + "moviebox detail <subjectId>");
    params.subjectId = args[0];
  } else if (action === "play" || action === "download") {
    if (!args[0]) throw new Error("Usage: " + ctx.config.prefix + "moviebox " + action + " <subjectId> [season] [episode]");
    params.subjectId = args[0];
    params.se = Number.isFinite(Number(args[1])) ? Number(args[1]) : 0;
    params.ep = Number.isFinite(Number(args[2])) ? Number(args[2]) : 0;
  } else if (action === "trending") {
    params.page = 1;
    params.perPage = 10;
  }
  const payload = await requestExternalJson(API + "/movie/MovieBox-pro", params, 90000);
  await ctx.reply(withPoweredFooter(
    unicodeBox("🎬 MOVIEBOX PRO · " + action.toUpperCase(), outputText(payload), { footer: false }),
    3800
  ));
}

export default {
  name: "moviebox",
  aliases: ["mbox"],
  category: "Downloads",
  description: "Search movies, view details and request MovieBox playback/download information.",
  run: runMovieBox
};

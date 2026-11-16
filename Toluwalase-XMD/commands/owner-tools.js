import { setBotPrefix, getBotPrefix, getBotMode, setBotMode } from "../lib/bot-settings.js";

const setPrefixCommand = {
  name: "setprefix",
  category: "Owner",
  description: "Change the bot command prefix.",
  run: async ctx => {
    if (!ctx.owner) return ctx.reply("⛔ Only the bot owner can change the prefix.");
    const newPrefix = String(ctx.args || "").trim();
    if (!newPrefix) {
      const current = await getBotPrefix(ctx.config.prefix || "!");
      return ctx.reply("Current prefix: " + current + "\nUsage: " + current + "setprefix <new prefix>");
    }
    try {
      const prefix = await setBotPrefix(newPrefix);
      await ctx.reply("✅ *PREFIX UPDATED*\n\nNew prefix: " + prefix + "\nExample: " + prefix + "menu");
    } catch (error) { await ctx.reply("❌ " + error.message); }
  }
};

const modeCommand = {
  name: "mode",
  category: "Owner",
  description: "View or change public/private bot mode.",
  run: async ctx => {
    if (!ctx.owner) return ctx.reply("⛔ Only the bot owner can manage bot mode.");
    const requested = String(ctx.args || "").trim().toLowerCase();
    if (!requested) {
      const current = await getBotMode(ctx.config.defaultMode || "public");
      return ctx.reply("⚙️ *BOT MODE*\n\nCurrent mode: *" + current.toUpperCase() + "*\n\nUsage: " + ctx.config.prefix + "mode public\n        " + ctx.config.prefix + "mode private");
    }
    try {
      const mode = await setBotMode(requested);
      await ctx.reply("✅ *BOT MODE UPDATED*\n\nThe bot is now *" + mode.toUpperCase() + "*.\n" + (mode === "public" ? "All users can use available commands." : "Only the bot owner can use commands."));
    } catch (error) { await ctx.reply("❌ " + error.message); }
  }
};

export default [setPrefixCommand, modeCommand];

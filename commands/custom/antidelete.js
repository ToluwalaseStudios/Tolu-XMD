import {
  getAntiDeleteSettings,
  setAntiDeleteEnabled
} from "../../lib/anti-delete.js";

function statusText(prefix, enabled) {
  return "🗑️ *AUTOMATIC ANTI-DELETE*\n" +
    "• Status: " + (enabled ? "ON ✅" : "OFF 🔕") + "\n" +
    "• Delivery: your personal DM only\n" +
    "• View-once: always excluded\n\n" +
    "*Usage*\n" +
    "• " + prefix + "antidelete on — enable for all chats\n" +
    "• " + prefix + "antidelete off — disable\n\n" +
    "_When enabled, ordinary deleted messages are automatically sent to your DM. Messages are temporarily cached in memory._";
}

export default {
  name: "antidelete",
  aliases: ["antidel"],
  category: "Chat & Privacy",
  description: "Automatically send deleted messages to the owner's personal DM, excluding view-once.",
  run: async ctx => {
    if (!ctx.owner) {
      await ctx.reply("⛔ Only the bot owner can manage automatic anti-delete.");
      return;
    }

    const args = String(ctx.args || "").trim().toLowerCase();
    if (!args) {
      const current = await getAntiDeleteSettings(ctx.jid);
      await ctx.reply(statusText(ctx.config.prefix, current.enabled));
      return;
    }

    if (args !== "on" && args !== "off") {
      const current = await getAntiDeleteSettings(ctx.jid);
      await ctx.reply("Usage: " + ctx.config.prefix + "antidelete on/off\n\n" +
        statusText(ctx.config.prefix, current.enabled));
      return;
    }

    const current = await setAntiDeleteEnabled(ctx.jid, args === "on");
    await ctx.reply("✅ Automatic anti-delete is now *" + (current.enabled ? "ON" : "OFF") + "*.\n\n" +
      "Deleted messages from all chats will " +
      (current.enabled ? "be sent automatically to your personal DM (view-once excluded)." : "no longer be forwarded.") );
  }
};

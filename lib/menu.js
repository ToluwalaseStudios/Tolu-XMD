export function getSectionCommands(section, commands = []) {
  const visible = commands.filter(command => !command.hidden);

  if (Array.isArray(section.commandNames)) {
    const selected = new Set(section.commandNames.map(value => String(value).toLowerCase()));
    return visible.filter(command => selected.has(String(command.name).toLowerCase()));
  }

  const categories = Array.isArray(section.categories) && section.categories.length
    ? section.categories
    : [section.key];
  const excluded = new Set(section.excludeNames || []);

  return visible.filter(command =>
    categories.includes(command.category) && !excluded.has(command.name)
  );
}

function commandRows(commands, prefix) {
  const rows = [];
  for (let index = 0; index < commands.length; index += 2) {
    const left = prefix + commands[index].name;
    const right = commands[index + 1] ? prefix + commands[index + 1].name : "";
    rows.push("┃  " + left.padEnd(19, " ") + right);
  }
  return rows;
}

export function buildMenu({ commands = [], config = {}, theme = {} } = {}) {
  const menu = theme.menu || {};
  const sections = Array.isArray(theme.sections) ? theme.sections : [];
  const prefix = String(config.prefix || "!");
  const safeName = String(theme.botTitle || config.name || "Toluwalase XMD")
    .replace(/[\\r\\n]/g, " ").slice(0, 60);
  const visibleCommands = commands.filter(command => !command.hidden);
  const top = menu.top || "╭━━━━━━━━━━〔 ";
  const titleEnd = menu.titleEnd || " 〕━━━━━━━━━━╮";
  const bottom = menu.bottom || "╰━━━━━━━━━━━━━━━━━━━━╯";

  const lines = [
    top + safeName + titleEnd,
    "┃",
    "┃       ⚡ *WHATSAPP ASSISTANT*",
    "┃",
    "┣━━━━━━━━━━〔 BOT INFORMATION 〕━━━━━━━━━━",
    "┃  ◈ Version    : " + String(config.version || "1.0.0"),
    "┃  ◈ Prefix     : " + prefix,
    "┃  ◈ Commands   : " + visibleCommands.length,
    "┃",
    "┣━━━━━━━━━━〔 QUICK ACCESS 〕━━━━━━━━━━",
    "┃  " + prefix + "menu  ·  Open main menu",
    "┃  " + prefix + "help  ·  View command guide",
    "┃  " + prefix + "ping  ·  Check bot status",
    "┃"
  ];

  if (!visibleCommands.length) {
    lines.push("┃  Commands are being prepared.");
  } else {
    const assigned = new Set();
    for (const section of sections) {
      const members = getSectionCommands(section, visibleCommands)
        .filter(command => !assigned.has(command.name));
      if (!members.length) continue;
      lines.push("┣━━━━━━━━━━〔 " +
        String(section.title || section.key).replace(/[\\r\\n]/g, " ") +
        " 〕━━━━━━━━━━");
      lines.push(...commandRows(members, prefix));
      lines.push("┃");
      for (const command of members) assigned.add(command.name);
    }

    const ungrouped = visibleCommands.filter(command => !assigned.has(command.name));
    if (ungrouped.length) {
      lines.push("┣━━━━━━━━━━〔 OTHER COMMANDS 〕━━━━━━━━━━");
      lines.push(...commandRows(ungrouped, prefix));
      lines.push("┃");
    }
  }

  lines.push(bottom, "", theme.footer || "⚡ POWERED BY TOLUWALASE STUDIOS");
  return lines.join("\n");
}


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

export function buildMenu({ commands = [], config = {}, theme = {} } = {}) {
  const menu = theme.menu || {};
  const sections = Array.isArray(theme.sections) ? theme.sections : [];
  const prefix = String(config.prefix || "!");
  const safeName = String(theme.botTitle || config.name || "Toluwalase XMD")
    .replace(/[\\r\\n]/g, " ").slice(0, 60);
  const visibleCommands = commands.filter(command => !command.hidden);
  const line = menu.bottom || "╰━━━━━━━━━━━━━━━━━━━━╯";
  const top = menu.top || "╭━━━━━━━━━━〔 ";
  const titleEnd = menu.titleEnd || " 〕━━━━━━━━━━╮";
  const itemLine = menu.itemLine || "┃  › ";

  const lines = [
    top + safeName + titleEnd,
    "┃",
    "┃  ⚡ *WHATSAPP ASSISTANT*",
    "┃  Version  : " + String(config.version || "1.0.0"),
    "┃  Prefix   : " + prefix,
    "┃  Commands : " + visibleCommands.length,
    "┃",
    "┣━━━━━━━━━━〔 QUICK START 〕━━━━━━━━━━",
    "┃  " + prefix + "menu     — Open this menu",
    "┃  " + prefix + "help     — Browse commands",
    "┃  " + prefix + "ping     — Check bot status",
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
      lines.push("┣━━━━━━━━━━〔 " + String(section.title || section.key).replace(/[\\r\\n]/g, " ") + " 〕");
      for (const command of members) {
        assigned.add(command.name);
        lines.push(itemLine + prefix + command.name);
      }
      lines.push("┃");
    }

    const ungrouped = visibleCommands.filter(command => !assigned.has(command.name));
    if (ungrouped.length) {
      lines.push("┣━━━━━━━━━━〔 MORE 〕");
      for (const command of ungrouped) lines.push(itemLine + prefix + command.name);
      lines.push("┃");
    }
  }

  lines.push(line);
  lines.push("", theme.footer || "⚡ POWERED BY TOLUWALASE STUDIOS");
  return lines.join("\\n");
}

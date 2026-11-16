export function getSectionCommands(section, commands = []) {
  const visible = commands.filter(command => !command.hidden);

  if (Array.isArray(section.commandNames)) {
    return section.commandNames.flatMap(displayName => {
      const wanted = String(displayName).toLowerCase();
      const command = visible.find(item =>
        String(item.name).toLowerCase() === wanted ||
        (item.aliases || []).some(alias => String(alias).toLowerCase() === wanted)
      );
      return command ? [{ ...command, menuDisplayName: displayName }] : [];
    });
  }

  const categories = Array.isArray(section.categories) && section.categories.length
    ? section.categories
    : [section.key];
  return visible
    .filter(command => categories.includes(command.category))
    .map(command => ({ ...command, menuDisplayName: command.name }));
}

function commandRows(commands, prefix) {
  return commands.map(command => "┃ ◈ " + prefix + command.menuDisplayName);
}

export function buildMenu({ commands = [], config = {}, theme = {} } = {}) {
  const sections = Array.isArray(theme.sections) ? theme.sections : [];
  const prefix = String(config.prefix || "!");
  const safeName = String(theme.botTitle || config.name || "Toluwalase XMD")
    .replace(/[\\r\\n]/g, " ").slice(0, 60);
  const visibleCommands = commands.filter(command => !command.hidden);
  const assigned = new Set();
  const displayedCommands = new Set();

  const lines = [
    "╭━━〔 " + safeName + " 〕━━┈⊷",
    "┃ ✦ Version: " + String(config.version || "1.0.0"),
    "┃ ✦ Prefix: " + prefix,
    "┃ ✦ Commands: " + visibleCommands.length,
    "┃"
  ];

  for (const section of sections) {
    const members = getSectionCommands(section, visibleCommands)
      .filter(command => !assigned.has(command.name + ":" + command.menuDisplayName));
    if (!members.length) continue;

    lines.push("╭━━〔 " + String(section.title || section.key).replace(/[\\r\\n]/g, " ") + " 〕━━┈⊷");
    lines.push(...commandRows(members, prefix));
    lines.push("╰━━━━━━━━━━━━━━┈⊷");
    lines.push("");

    for (const command of members) {
      assigned.add(command.name + ":" + command.menuDisplayName);
      displayedCommands.add(command.name);
    }
  }

  const ungrouped = visibleCommands
    .filter(command => !displayedCommands.has(command.name))
    .map(command => ({ ...command, menuDisplayName: command.name }));
  if (ungrouped.length) {
    lines.push("╭━━〔 OTHER COMMANDS 〕━━┈⊷");
    lines.push(...commandRows(ungrouped, prefix));
    lines.push("╰━━━━━━━━━━━━━━┈⊷");
    lines.push("");
  }

  lines.push(theme.footer || "⚡ POWERED BY TOLUWALASE STUDIOS");
  return lines.join("\\n");
}

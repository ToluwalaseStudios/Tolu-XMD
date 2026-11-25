# Command modules

The public release contains **184 commands across 18 menu sections**.

| Menu section | Command names |
| --- | --- |
| General | menu, help, ping, alive, owner, support, time, date, version, jid, whoami |
| AI Chat | claude, deepai, chatgpt, gemini, buildapp, wormgpt |
| AI Media | txt2video, flux, clideo, gemtts, woman1, woman2, woman3, man1, man2, man3, captts, songgen, aimusic |
| News Desk | news, aljazeera, cnn, bbc, guardian, npr, nytimes, foxnews, skynews, dw, punchnews |
| Group Tools | welcome, goodbye, groupinfo, groupjid, getgcpp, groupcount, groupstats, admins, tagall, link, groupname, groupdesc, close, open |
| Downloads | aio, fb, twitter, instagram, ytmp4, tiktok, play, upload, moviebox, video, fetch |
| Fun Games | calc, poll, coinflip, dice, 8ball, choose, trivia, riddle, activity, pokemon |
| Fun Mix | joke, dadjoke, progjoke, chuck, fact2, catfact, dog, cat, fox, advice, quote2, meme, numfact, history, wiki, nasa |
| Anime Info | animemenu, anime, manga, character, charpic, staff, studio, recommend, episodes, animechars, trailer, pictures, streaming, review, genres, genre, topanime, topmanga, popular, favorite, airing, upcoming, trending, season, topchars, schedule, nextep |
| Anime Art | randomanime, randommanga, randomchar, animequote, whatanime, waifu2, husbando, neko, kitsune |
| Anime GIFs | angry, baka, bleh, blowkiss, blush, bored, carry, clap, confused, cry, cuddle, dance, facepalm, feed, handhold, handshake, happy, highfive |
| Anime Reactions | hug, kabedon, kiss, lappillow, laugh, lurk, nod, nom, nope, nya, pat, peck, poke, pout, run, salute, shake |
| Anime Moves | shocked, shrug, sip, sleep, smile, smug, spin, stare, teehee, think, thumbsup, tickle, wag, wave, wink, yawn, yeet |
| Canvas Tools | wndwqute, canvasquote |
| Media Tools | lyrics |
| Chat Privacy | privacy |
| Status Tools | statusdraft, statusideas |
| Owner Tools | runtime |


### Trivia Arena

Trivia is a group-scoped competition system. The bot owner enables or disables each group with `!trivia enable` and `!trivia disable`; members of enabled groups can start a competition with `!trivia start` and stop it with `!trivia stop`, even while the bot is in Private mode. The Private-mode exception is limited to the Trivia command and a restricted Trivia-only `!menu`.

The owner supplies and manages the official question bank:
- `!trivia add` adds one question using Subject, Subcategory, Difficulty, Question, A–D, Answer and optional Explanation fields.
- `!trivia import` imports a JSON document quoted in the command message (up to 2 MB and 5,000 questions per import).
- `!trivia list`, `!trivia edit <id>`, `!trivia remove <id>`, `!trivia export` and `!trivia template` manage the bank.
- `!trivia settings` shows defaults; the owner can change question count, answer time, inter-question delay and start cooldown.

The bank, enabled-group list, settings and per-group non-repeat tracking are stored in `data/trivia-arena.json`. Live scores exist only for the current competition; they are not carried into later games. Each group has at most one active game. Questions are not repeated within a game, and each group's question cycle uses unused questions before starting a new cycle.

### Buildapp project downloads

- `!buildapp <description>` creates a web app and attempts to retrieve the generated session files as `Buildapp-project.zip`.
- `!buildapp download` retries retrieval of the latest saved project in the current bot session.
- `!buildapp followup | <changes>` updates the saved project and attempts to send a refreshed ZIP.
- A live preview URL is shown only when the provider actually returns one. Generating source files does not itself publish the website.

The Channel menu section, its commands and channel-specific integrations are deliberately absent.

Public-release exclusions include participant-management actions, group invite reset, live-presence tracking, private group-history collection and summaries, Meta AI participant automation, anti-delete/anti-edit monitoring, read-receipt controls, view-once recovery, automatic status viewing/reacting, fake private-message canvases and owner/session administration. The Chat Privacy command is informational only; Status Tools draft text locally; Owner Tools exposes only a read-only uptime summary. Welcome/goodbye messages are disabled by default and the group greeting settings do not collect chat history.

Each JavaScript module default-exports one command object or an array of command objects. A command object uses this shape:

    export default {
      name: "example",
      aliases: ["ex"],
      category: "General",
      description: "A short description shown in the menu.",
      async run(ctx) {
        await ctx.reply("Example response.");
      }
    };

The runtime context provides:

- ctx.sock — the active normal WhiskeySockets Baileys socket.
- ctx.msg — the original Baileys message.
- ctx.jid — the chat JID.
- ctx.senderJid — the sender JID.
- ctx.text — the message text after removing the prefix.
- ctx.commandName and ctx.command — the matched command name.
- ctx.args — the remaining argument string.
- ctx.commands — all loaded command definitions.
- ctx.config and ctx.theme — bot configuration and menu theme.
- ctx.owner — whether the sender matches a configured owner number.
- ctx.connectionOpen — whether the WhatsApp connection is open.
- ctx.buildMenu() — render the configured menu.
- ctx.reply(content, options) — send a reply, quoting the source message by default; pass { quoted: false } or false to disable quoting.
- ctx.send(content, options) — send a message without automatically quoting the source.

Use the installed normal WhiskeySockets Baileys API. Do not introduce fork-only methods or assumptions.

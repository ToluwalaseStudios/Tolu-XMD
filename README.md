# Toluwalase-XMD

**Toluwalase-XMD** is a modular WhatsApp bot by **Toluwalase Studios**, built with the
official WhiskeySockets Baileys package.

## Requirements

- Node.js 20.9.0 or newer
- A WhatsApp account to link to the bot
- A hosting environment that supports persistent files and long-running Node.js processes

## Setup

1. Upload/extract this project to your host.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `OWNER_NUMBER` to the WhatsApp number that owns the bot, using country code and digits only.
5. Keep `BOT_MODE=public` initially. Set `BOT_MODE=private` if only the owner should be able to run commands.
6. Start the bot with `npm start` and complete the pairing flow shown by the terminal/host logs.

## Commands

- `!menu` — show the command menu.
- `!mode` — show the current public/private mode (owner only).
- `!mode private` — allow commands only from the configured owner.
- `!mode public` — allow all users to use available commands.
- `!setprefix <prefix>` — change the command prefix (owner only).

The prefix defaults to `!`. If you change it, use the new prefix for subsequent commands.

## Persistent storage

The bot stores settings in `data/bot-settings.json` by default. The host must preserve the
configured data directory across restarts and redeployments, or mode/prefix settings may reset.
The preferred storage variables are `TOLUWALASE_DATA_DIR` and `TOLUWALASE_SESSION_DIR`. The older
`FEI_DATA_DIR` and `FEI_SESSION_DIR` names remain supported as fallbacks for existing deployments.

## KataBump deployment notes

Use Node.js 20 or newer, install dependencies, set the environment variables from `.env.example`
in the hosting panel, and start with `npm start`. Set `OWNER_NUMBER` before pairing. Do not
delete the WhatsApp authentication/session directory when restarting or redeploying.

## Project identity

Bot name: **Toluwalase-XMD**
Publisher: **Toluwalase Studios**

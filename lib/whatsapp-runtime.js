
import path from "node:path";
import { EventEmitter } from "node:events";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";

import { resolveCommandInput } from "../handlers/command-loader.js";
import { getMessageSender, messageText, numberFromJid, normalizeJid } from "./message-utils.js";
import { isOwnerNumber, canUseBotCommands } from "./owner-utils.js";
import { buildMenu } from "./menu.js";
import { getGroupGreetingSettings } from "./group-greetings.js";
import { handleGroupLinkMessage } from "./group-moderation.js";
import { getStatusAutomationSettings, processIncomingStatus } from "./status-automation.js";
import { createAntiDeleteRuntime } from "./anti-delete.js";
import { createRecentMessageStore } from "./message-store.js";
import { getBotPrefix, getBotMode, getViewOnceReactionEmoji } from "./bot-settings.js";
import { recoverViewOnce, sendBrandedViewOnce } from "../commands/custom/vv.js";
import { triviaEngine } from "./trivia-engine.js";

const MAX_PROCESSED_IDS = 2000;
const VERSION_LOOKUP_TIMEOUT_MS = 8000;
const QR_READY_TIMEOUT_MS = 25000;
const MESSAGE_DISPATCH_TIMEOUT_MS = 180000;

function isPaired(creds) {
  return Boolean(creds && (creds.registered || creds.account));
}

/** Use a Web identity only for initial pairing; registered sessions use Android. */
export function getWhatsAppBrowser(creds, browsers = Browsers) {
  if (!creds?.registered) return ["Ubuntu", "Chrome", "20.0.04"];
  if (typeof browsers.android !== "function") {
    throw new Error("This Baileys version does not support the Android browser identity.");
  }
  return browsers.android("Chrome");
}

/**
 * Preserve complete WebMessageInfo objects before dispatch filtering or
 * command handling. View-once recovery needs the original media payload.
 */
export function rememberUpsertMessages(store, update) {
  if (!store || !Array.isArray(update?.messages)) return 0;
  let saved = 0;
  for (const message of update.messages) {
    if (store.remember(message)) saved += 1;
  }
  return saved;
}

/**
 * Accept only the configured reaction made by this linked WhatsApp account.
 * Baileys emits the target message key separately from the reaction message key.
 */
export function shouldHandleViewOnceReaction(update, configuredEmoji, processed = new Set()) {
  if (!configuredEmoji || update?.reaction?.text !== configuredEmoji) return false;
  const reactionKey = update.reaction?.key;
  const targetKey = update.key;
  if (reactionKey?.fromMe !== true || !targetKey?.remoteJid || !targetKey?.id) return false;

  const eventId = String(reactionKey.id || "");
  const dedupeKey = eventId || [
    targetKey.remoteJid, targetKey.id, configuredEmoji
  ].join(":");
  if (processed.has(dedupeKey)) return false;
  processed.add(dedupeKey);
  while (processed.size > 1000) processed.delete(processed.values().next().value);
  return true;
}

export async function resolveMessageSender(msg, sock) {
  const sender = getMessageSender(msg, sock);
  if (!sender.endsWith("@lid") && !sender.endsWith("@hosted.lid")) return sender;
  try {
    const phoneJid = await sock?.signalRepository?.lidMapping?.getPNForLID?.(sender);
    return normalizeJid(phoneJid) || sender;
  } catch {
    return sender;
  }
}

export function canDispatchCommandInMode(mode, config, senderJid, commandDefinition) {
  return canUseBotCommands(mode, config, senderJid) ||
    commandDefinition?.allowInPrivateMode === true;
}

function statusCodeFrom(error) {
  return Number(error?.output?.statusCode || error?.data?.statusCode || error?.statusCode || 0);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      label + " did not finish within " + Math.round(timeoutMs / 1000) + " seconds."
    )), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createDeferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createWhatsAppRuntime({
  config,
  theme,
  commands = [],
  lookup = new Map(),
  sessionDirectory: requestedSessionDirectory,
  sessionId = "primary",
  socketFactory = makeWASocket
} = {}) {
  if (!config) throw new TypeError("Bot configuration is required.");

  const events = new EventEmitter();
  const sessionDirectory = path.resolve(String(
    requestedSessionDirectory || config.sessionDirectory || "./auth_info_baileys"
  ));
  const logger = pino({ level: config.logLevel || process.env.LOG_LEVEL || "info" });
  const processedIds = new Set();
  const antiDelete = createAntiDeleteRuntime();
  const recentMessages = createRecentMessageStore();
  const processedViewOnceReactions = new Set();

  let authState = null;
  let saveCreds = null;
  let socket = null;
  let status = "idle";
  let connected = false;
  let stopped = false;
  let startPromise = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let lastError = "";
  let qrSeen = false;
  const qrReady = createDeferred();
  let messageQueue = Promise.resolve();

  function getStatus() {
    const self = socket?.user?.id || socket?.user?.lid || authState?.creds?.me?.id || "";
    return {
      id: String(sessionId),
      status,
      paired: isPaired(authState?.creds),
      connected,
      phoneNumber: numberFromJid(self),
      reconnectAttempts,
      lastError
    };
  }

  function rememberProcessed(id) {
    if (!id) return false;
    if (processedIds.has(id)) return true;
    processedIds.add(id);
    if (processedIds.size > MAX_PROCESSED_IDS) {
      const oldest = processedIds.values().next().value;
      processedIds.delete(oldest);
    }
    return false;
  }

  function scheduleReconnect(error) {
    if (stopped || reconnectTimer) return;
    lastError = String(error?.message || error || "Connection closed");
    connected = false;
    status = "reconnecting";
    const delayMs = Math.min(30000, 1000 * (2 ** Math.min(reconnectAttempts, 5)));
    reconnectAttempts += 1;
    events.emit("reconnecting", { delayMs, attempts: reconnectAttempts, error: lastError });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(connectError => {
        lastError = String(connectError?.message || connectError);
        events.emit("runtimeError", connectError);
        scheduleReconnect(connectError);
      });
    }, delayMs);
  }

  async function dispatchMessage(msg, activeSocket) {
    if (!msg?.message || !msg?.key?.remoteJid) return;
    const jid = String(msg.key.remoteJid);

    if (jid === "status@broadcast") {
      try {
        const settings = await getStatusAutomationSettings();
        await processIncomingStatus({ sock: activeSocket, msg, settings });
      } catch (error) {
        logger.warn({ err: error }, "Incoming status automation failed");
      }
      return;
    }

    if (jid === "newsletter") return;

    const messageId = String(msg.key.id || "");
    if (messageId && rememberProcessed(jid + ":" + messageId)) return;

    await antiDelete.cacheIncomingMessage(activeSocket, msg);

    const text = messageText(msg.message);
    const prefix = await getBotPrefix(config.prefix || "!");
    logger.info({
      fromMe: Boolean(msg.key.fromMe),
      messageType: Object.keys(msg.message || {})[0] || "unknown",
      hasText: Boolean(text),
      hasCommandPrefix: Boolean(prefix && text.startsWith(prefix))
    }, "WhatsApp message reached command dispatcher");

    const moderateLinks = async () => {
      try {
        await handleGroupLinkMessage({ sock: activeSocket, msg, text, config });
      } catch (error) {
        logger.warn({ err: error, group: jid }, "Group link moderation failed");
      }
    };

    const senderJid = await resolveMessageSender(msg, activeSocket);
    if (jid.endsWith("@g.us") && text && !text.startsWith(prefix)) {
      try {
        const setupHandled = await triviaEngine.handleSetupReply({
          groupJid: jid,
          senderJid,
          name: msg.pushName,
          text,
          send: payload => activeSocket.sendMessage(jid, payload)
        });
        if (setupHandled) return;
      } catch (error) {
        logger.warn({ err: error, group: jid }, "Trivia setup reply handling failed");
      }
    }
    // Trivia answers are ordinary A/B/C/D messages, not prefixed commands.
    // Only an active group competition consumes them; elsewhere they pass on.
    if (jid.endsWith("@g.us") && /^[ABCD]$/i.test(text)) {
      try {
        const handled = await triviaEngine.handleAnswer({
          groupJid: jid,
          senderJid,
          name: msg.pushName,
          answer: text
        });
        if (handled) return;
      } catch (error) {
        logger.warn({ err: error, group: jid }, "Trivia answer handling failed");
      }
    }

    if (!text || !prefix || !text.startsWith(prefix)) {
      await moderateLinks();
      return;
    }

    const owner = isOwnerNumber(config, senderJid);
    const mode = await getBotMode(config.defaultMode || "public");
    const parsed = resolveCommandInput(text.slice(prefix.length).trim(), lookup);

    // Only explicitly marked, self-guarding features may bypass Private mode.
    // Trivia performs a second group-enabled check before every participant action.
    if (!canDispatchCommandInMode(mode, config, senderJid, parsed?.definition)) {
      logger.warn({ mode, fromMe: Boolean(msg.key.fromMe), owner }, "Prefixed message ignored by bot access mode");
      return;
    }

    if (!parsed) {
      if (mode === "public") await moderateLinks();
      return;
    }

    const activeConfig = { ...config, prefix };

    const context = {
      sock: activeSocket,
      msg,
      getMessageByKey: key => recentMessages.get(key),
      jid,
      senderJid,
      text: text.slice(prefix.length).trim(),
      commandName: parsed.commandName,
      args: parsed.args,
      config: activeConfig,
      theme,
      sessionId,
      commands,
      connectionOpen: connected,
      mode,
      command: parsed.commandName,
      owner,
      buildMenu: () => buildMenu({
        commands,
        config: activeConfig,
        theme
      }),
      send: (content, options = {}) => activeSocket.sendMessage(jid, content, options === false ? {} : options),
      reply: async (content, options = {}) => {
        const payload = typeof content === "string" ? { text: content } : content;

        if (!payload || typeof payload !== "object") {
          throw new TypeError("A reply must be text or a WhatsApp message payload.");
        }

        const replyOptions = options === false ? { quoted: false } : options;
        const { quoted, ...sendOptions } = replyOptions;

        return activeSocket.sendMessage(jid, payload, {
          ...sendOptions,
          ...(quoted === false ? {} : { quoted: quoted || msg })
        });
      }
    };

    const commandStartedAt = Date.now();
    logger.info({ command: parsed.commandName }, "WhatsApp command started");
    try {
      await parsed.definition.run(context);
      logger.info({ command: parsed.commandName, durationMs: Date.now() - commandStartedAt }, "WhatsApp command completed");
    } catch (error) {
      logger.error({ err: error, command: parsed.commandName, chat: jid }, "Command execution failed");
      events.emit("runtimeError", error);
      const detail = String(error?.message || "Unexpected error")
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 220);
      await context.reply("⚠️ " + parsed.commandName + " failed: " + detail).catch(() => {});
    }
  }

  function queueMessages(upsert, activeSocket) {
    if (!upsert || !["notify", "append"].includes(upsert.type) ||
        !Array.isArray(upsert.messages)) return;

    logger.info({
      type: upsert.type,
      received: upsert.messages.length,
      outgoing: upsert.messages.filter(msg => msg?.key?.fromMe).length,
      incoming: upsert.messages.filter(msg => !msg?.key?.fromMe).length
    }, "WhatsApp messages.upsert event received");

    // "notify" carries newly received messages. "append" can carry messages
    // sent by this linked device, so accept only recent outgoing commands from it.
    const messages = upsert.messages.filter(msg => {
      if (upsert.type === "notify") return true;
      if (!msg?.key?.fromMe) return false;

      const raw = msg.messageTimestamp;
      const timestamp = raw && typeof raw.toNumber === "function"
        ? raw.toNumber()
        : Number(raw);
      if (!Number.isFinite(timestamp) || timestamp <= 0) return false;

      const timestampMs = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
      const ageMs = Date.now() - timestampMs;
      return ageMs >= -30000 && ageMs <= 5 * 60 * 1000;
    });

    if (!messages.length) return;

    logger.debug({
      type: upsert.type,
      accepted: messages.length
    }, "WhatsApp messages.upsert filter result");

    messageQueue = messageQueue.then(async () => {
      for (const msg of messages) {
        if (stopped || socket !== activeSocket) break;
        try {
          await withTimeout(
            dispatchMessage(msg, activeSocket),
            MESSAGE_DISPATCH_TIMEOUT_MS,
            "WhatsApp message dispatch"
          );
        } catch (error) {
          logger.error({
            err: error,
            messageId: msg?.key?.id || "",
            chat: msg?.key?.remoteJid || ""
          }, "Message dispatch failed");
          events.emit("runtimeError", error);
        }
      }
    }).catch(error => {
      logger.error({ err: error }, "Incoming message queue failed");
      events.emit("runtimeError", error);
    });
  }

  async function connect() {
    if (stopped) return null;
    if (!authState || !saveCreds) throw new Error("Baileys authentication state has not been initialized.");

    status = "connecting";
    let version;

    try {
      const versionInfo = await fetchLatestWaWebVersion({
        signal: AbortSignal.timeout(VERSION_LOOKUP_TIMEOUT_MS)
      });
      if (Array.isArray(versionInfo?.version)) version = versionInfo.version;
      if (versionInfo?.isLatest === false) {
        logger.warn({ error: versionInfo.error?.message }, "Using the Baileys bundled WhatsApp Web version");
      }
    } catch (error) {
      logger.warn({ err: error }, "WhatsApp Web version lookup failed; using the Baileys default version");
    }

    if (stopped) return null;

    const nextSocket = socketFactory({
      ...(version ? { version } : {}),
      auth: authState,
      logger,
      browser: getWhatsAppBrowser(authState.creds),
      getMessage: async key => recentMessages.getMessage(key),
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 60000
    });

    socket = nextSocket;
    nextSocket.ev.on("creds.update", () => {
      void saveCreds().catch(error => {
        logger.error({ err: error }, "Failed to persist WhatsApp authentication updates");
        events.emit("runtimeError", error);
      });
    });
    nextSocket.ev.on("messages.upsert", update => {
      // Save the raw incoming WebMessageInfo before any dispatch filtering.
      // Stubs without a message body are deliberately rejected by the store.
      rememberUpsertMessages(recentMessages, update);
      queueMessages(update, nextSocket);
    });

    nextSocket.ev.on("messages.reaction", updates => {
      void (async () => {
        if (!Array.isArray(updates)) return;
        const configuredEmoji = await getViewOnceReactionEmoji();
        if (!configuredEmoji) return;

        for (const update of updates) {
          if (!shouldHandleViewOnceReaction(update, configuredEmoji, processedViewOnceReactions)) continue;

          const targetKey = update.key;
          const ownerJid = normalizeJid(
            nextSocket.user?.id || nextSocket.user?.lid ||
            (config.ownerNumber ? config.ownerNumber + "@s.whatsapp.net" : "")
          );
          if (!ownerJid) {
            logger.warn("View-once reaction matched, but the owner's DM JID could not be resolved");
            continue;
          }

          const reactionContext = {
            sock: nextSocket,
            jid: String(targetKey.remoteJid),
            msg: {
              key: {
                remoteJid: targetKey.remoteJid,
                ...(targetKey.remoteJidAlt ? { remoteJidAlt: targetKey.remoteJidAlt } : {}),
                id: "view-once-reaction-trigger"
              },
              message: {
                extendedTextMessage: {
                  contextInfo: {
                    stanzaId: targetKey.id,
                    ...(targetKey.participant ? { participant: targetKey.participant } : {})
                  }
                }
              }
            },
            getMessageByKey: key => recentMessages.get(key),
            config: { prefix: "!" },
            command: "vvreact",
            send: payload => nextSocket.sendMessage(ownerJid, payload)
          };

          try {
            const result = await withTimeout(
              recoverViewOnce(reactionContext),
              120000,
              "Automatic view-once recovery"
            );
            if (result?.error) {
              logger.debug({
                messageId: targetKey.id,
                chat: targetKey.remoteJid,
                reason: result.error
              }, "Configured reaction did not resolve to recoverable view-once media");
              continue;
            }
            await sendBrandedViewOnce(reactionContext, result);
            logger.info({
              messageId: targetKey.id,
              chat: targetKey.remoteJid,
              emoji: configuredEmoji
            }, "View-once media sent to owner DM after configured reaction");
          } catch (error) {
            logger.warn({
              err: error,
              messageId: targetKey.id,
              chat: targetKey.remoteJid
            }, "Automatic view-once reaction recovery failed");
          }
        }
      })().catch(error => {
        logger.warn({ err: error }, "View-once reaction handler failed");
      });
    });

    nextSocket.ev.on("messages.update", updates => {
      void (async () => {
        if (!Array.isArray(updates)) return;
        for (const update of updates) {
          await antiDelete.handleDeleteUpdate(nextSocket, update);
        }
      })().catch(error => {
        logger.warn({ err: error }, "Anti-delete update handling failed");
      });
    });

    nextSocket.ev.on("group-participants.update", update => {
      void (async () => {
        if (!update?.id || !Array.isArray(update.participants)) return;
        if (update.action !== "add" && update.action !== "remove") return;

        const settings = await getGroupGreetingSettings(update.id);
        const type = update.action === "add" ? "welcome" : "goodbye";
        const greeting = settings[type];

        if (!greeting?.enabled || !greeting.message) return;

        let groupName = "this group";
        try {
          const metadata = await nextSocket.groupMetadata(update.id);
          groupName = String(metadata?.subject || groupName);
        } catch {}

        for (const participant of update.participants) {
          const candidateIds = [
            participant?.pn,
            participant?.phoneNumber,
            participant?.id,
            participant?.jid,
            participant?.lid,
            participant
          ].map(value => String(value || "").trim()).filter(value => value.includes("@"));

          const participantId = candidateIds.find(value => value.endsWith("@s.whatsapp.net")) ||
            candidateIds[0] || "";

          if (!participantId) continue;

          const numberSource = String(
            participant?.phoneNumber || participant?.pn || participantId
          );
          const number = numberSource.split("@")[0].split(":")[0].replace(/\D/g, "");
          const user = number ? "@" + number : "a group member";

          const text = String(greeting.message)
            .replace(/\{user\}/g, user)
            .replace(/\{number\}/g, number || "unknown")
            .replace(/\{group\}/g, groupName.slice(0, 100))
            .slice(0, 900);

          try {
            await nextSocket.sendMessage(update.id, {
              text,
              mentions: number ? [participantId] : []
            });
          } catch (error) {
            logger.warn({ err: error, group: update.id }, "Could not send group greeting");
          }
        }
      })().catch(error => {
        logger.warn({ err: error }, "Group greeting event failed");
      });
    });

    nextSocket.ev.on("connection.update", update => {
      if (socket !== nextSocket || stopped) return;

      if (update.qr) {
        qrSeen = true;
        qrReady.resolve(update.qr);
        events.emit("qr", update.qr);
      }

      if (update.connection === "connecting") status = "connecting";

      if (update.connection === "open") {
        connected = true;
        status = "connected";
        reconnectAttempts = 0;
        lastError = "";
        events.emit("connected", getStatus());
      }

      if (update.connection === "close") {
        connected = false;
        const error = update.lastDisconnect?.error;
        const code = statusCodeFrom(error);
        lastError = String(error?.message || "WhatsApp connection closed");

        if (code === DisconnectReason.loggedOut) {
          status = "logged_out";
          events.emit("loggedOut", { status: getStatus(), error });
          return;
        }

        status = "reconnecting";
        scheduleReconnect(error || "WhatsApp connection closed");
      }
    });

    events.emit("socketCreated", { sessionId, socket: nextSocket });
    return nextSocket;
  }

  async function start() {
    if (startPromise) return startPromise;
    stopped = false;

    startPromise = (async () => {
      status = "starting";
      const auth = await useMultiFileAuthState(sessionDirectory);
      authState = auth.state;
      saveCreds = auth.saveCreds;
      await connect();
      return getStatus();
    })().catch(error => {
      startPromise = null;
      status = "error";
      lastError = String(error?.message || error);
      throw error;
    });

    return startPromise;
  }

  async function requestPairingCode(phoneNumber) {
    const phone = String(phoneNumber || "").replace(/\D/g, "");

    if (!/^\d{8,15}$/.test(phone)) {
      throw new Error("Enter a valid WhatsApp number with country code (8–15 digits).");
    }

    if (!socket) throw new Error("The WhatsApp socket is not ready. Start the runtime first.");
    if (isPaired(authState?.creds)) throw new Error("This session is already paired.");

    if (!qrSeen) {
      let timeout;
      try {
        await Promise.race([
          qrReady.promise,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(
              "WhatsApp did not prepare a pairing request in time. Check the connection and try again."
            )), QR_READY_TIMEOUT_MS);
          })
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    if (!socket || stopped) throw new Error("The WhatsApp connection stopped before pairing.");

    const code = await socket.requestPairingCode(phone);
    return { code: String(code), phoneNumber: phone };
  }

  async function stop() {
    stopped = true;
    connected = false;
    status = "stopped";

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;

    antiDelete.clear();
    recentMessages.clear();
    const activeSocket = socket;
    socket = null;

    if (activeSocket) {
      try {
        activeSocket.end(new Error("Toluwalase-XMD runtime stopped"));
      } catch (error) {
        logger.debug({ err: error }, "Socket shutdown completed with a warning");
      }
    }

    await messageQueue.catch(() => {});
    events.emit("stopped", getStatus());
  }

  return {
    start,
    stop,
    getStatus,
    requestPairingCode,
    on: (event, listener) => {
      events.on(event, listener);
      return () => events.off(event, listener);
    },
    get socket() {
      return socket;
    },
    get sessionDirectory() {
      return sessionDirectory;
    }
  };
}

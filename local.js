import "dotenv/config";

import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import config from "./config/bot.config.js";
import theme from "./config/theme.config.js";
import { loadCommands } from "./handlers/command-loader.js";
import { createWhatsAppRuntime } from "./lib/whatsapp-runtime.js";


async function inspectSessionDirectory(directory) {
  const directoryInfo = await stat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory()) {
    return { exists: false, credentialsPresent: false, keyFileCount: 0, registered: false, accountPresent: false, identityPresent: false };
  }

  const names = await readdir(directory).catch(() => []);
  let metadata = {};
  if (names.includes("creds.json")) {
    try {
      const credentials = JSON.parse(await readFile(path.join(directory, "creds.json"), "utf8"));
      metadata = {
        registered: credentials.registered === true,
        accountPresent: Boolean(credentials.account),
        identityPresent: Boolean(credentials.me?.id || credentials.me?.lid)
      };
    } catch {
      metadata = { credentialsReadable: false };
    }
  }

  return {
    exists: true,
    credentialsPresent: names.includes("creds.json"),
    keyFileCount: names.filter(name => name.endsWith(".json") && name !== "creds.json").length,
    ...metadata
  };
}

function waitForWhatsAppConnection(runtime, timeoutMs = 45000) {
  const current = runtime.getStatus();
  if (current.connected) return Promise.resolve({ outcome: "connected", status: current });
  if (current.status === "logged_out") return Promise.resolve({ outcome: "logged_out", status: current });

  return new Promise(resolve => {
    let settled = false;
    let timer;
    const unsubscribers = [];

    const finish = (outcome, details = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      resolve({ outcome, status: runtime.getStatus(), ...details });
    };

    unsubscribers.push(runtime.on("connected", status => finish("connected", { status })));
    unsubscribers.push(runtime.on("loggedOut", info => finish("logged_out", { info })));
    timer = setTimeout(() => finish("timeout"), timeoutMs);

    // Cover the small race where the socket opens while listeners are attached.
    if (runtime.getStatus().connected) finish("connected");
  });
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidPhone(value) {
  return /^\d{8,15}$/.test(normalizePhone(value));
}

export async function runLocalTerminal(options = {}) {
  const { commands, lookup } = await loadCommands();
  const sessionDirectory = path.resolve(String(
    options.sessionDirectory ||
    process.env.TOLUWALASE_SESSION_DIR ||
    config.sessionDirectory
  ));

  const runtime = createWhatsAppRuntime({
    config,
    theme,
    commands,
    lookup,
    sessionDirectory
  });

  let shuttingDown = false;
  let rl = null;

  async function shutdown(signal = "") {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) console.log("\nStopping Toluwalase-XMD (" + signal + ")...");
    if (rl) {
      rl.close();
      rl = null;
    }
    await runtime.stop().catch(error => {
      console.warn("Could not stop Toluwalase-XMD cleanly:", error && error.message || error);
    });
  }

  const onSigint = () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  };
  const onSigterm = () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  runtime.on("connected", status => {
    console.log("\nToluwalase-XMD connected" + (status.phoneNumber ? " as " + status.phoneNumber : "") + ".");
    console.log("The runtime is ready. Available commands are loaded.");
  });
  runtime.on("reconnecting", info => {
    console.warn(
      "WhatsApp connection closed. Reconnecting in " + info.delayMs + " ms. Reason: " +
      String(info.error || "not provided").slice(0, 220)
    );
  });
  runtime.on("loggedOut", () => {
    console.error("WhatsApp reported that the saved session is logged out. Preserve the auth folder for diagnosis; do not delete its files.");
  });
  runtime.on("runtimeError", error => {
    console.error("Toluwalase-XMD runtime error:", error && error.message || error);
  });

  try {
    console.log("\n╭━━〔 Toluwalase-XMD · LOCAL RUNTIME 〕━━┈⊷");
    console.log("Baileys: @whiskeysockets/baileys (official npm package)");
    console.log("Session directory: " + sessionDirectory);
    const sessionInfo = await inspectSessionDirectory(sessionDirectory);
    console.log("Session folder: " + (sessionInfo.exists ? "present" : "not present yet"));
    console.log("creds.json: " + (sessionInfo.credentialsPresent ? "present" : "not present"));
    console.log("Baileys key files: " + sessionInfo.keyFileCount);
    if (sessionInfo.credentialsPresent && sessionInfo.credentialsReadable === false) {
      console.warn("creds.json exists but could not be read as valid JSON.");
    }
    if (sessionInfo.credentialsPresent && sessionInfo.credentialsReadable !== false) {
      console.log("Saved session metadata: registered=" + Boolean(sessionInfo.registered) +
        ", account=" + Boolean(sessionInfo.accountPresent) +
        ", identity=" + Boolean(sessionInfo.identityPresent));
    }
    console.log("Loaded " + commands.length + " command module(s).");
    console.log("Press Ctrl+C to stop the runtime.\n");

    await runtime.start();
    const status = runtime.getStatus();

    if (!status.paired && !status.connected) {
      let phoneNumber = normalizePhone(process.env.PAIRING_NUMBER || "");

      while (!shuttingDown && !phoneNumber) {
        rl = createInterface({ input: stdin, output: stdout });
        const answer = await rl.question(
          "Enter your WhatsApp number with country code (digits only, e.g. 2348012345678), or Q to cancel: "
        );
        rl.close();
        rl = null;

        if (String(answer || "").trim().toLowerCase() === "q") {
          await shutdown();
          return runtime;
        }

        if (!isValidPhone(answer)) {
          console.log("Invalid number. Include the country code and enter 8–15 digits.\n");
          continue;
        }
        phoneNumber = normalizePhone(answer);
      }

      if (!shuttingDown && phoneNumber) {
        const pairing = await runtime.requestPairingCode(phoneNumber);
        console.log("\n╭━━〔 YOUR WHATSAPP PAIRING CODE 〕━━┈⊷");
        console.log("                 " + pairing.code);
        console.log("╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┈⊷");
        console.log("On your phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.");
        console.log("Enter this code on WhatsApp. Keep it private.\n");
      }
    } else {
      console.log("A registered WhatsApp session was loaded. Waiting for WhatsApp to confirm the connection...");
      const connection = await waitForWhatsAppConnection(runtime);
      if (connection.outcome === "connected") {
        console.log("WhatsApp connection confirmed. Toluwalase-XMD is ready.");
      } else if (connection.outcome === "logged_out") {
        const code = Number(connection.info?.error?.output?.statusCode || connection.info?.error?.statusCode || 0);
        console.error("WhatsApp rejected the saved session" + (code ? " (status " + code + ")" : "") + ".");
        console.error("The process is running, but WhatsApp is not connected. Last error: " + (runtime.getStatus().lastError || "not provided"));
        console.error("Do not delete the session folder; preserve it for diagnosis.");
      } else {
        const latest = runtime.getStatus();
        console.warn("WhatsApp connection was not confirmed within " + "45 seconds" + ".");
        console.warn("Current state: " + latest.status + "; reconnect attempts: " + latest.reconnectAttempts + ".");
        if (latest.lastError) console.warn("Last WhatsApp error: " + latest.lastError);
        console.warn("KataBump may show the process as online while WhatsApp is still disconnected.");
      }
    }

    const finalStatus = runtime.getStatus();
    if (finalStatus.connected) {
      console.log("Toluwalase-XMD is running with WhatsApp connected.");
    } else {
      console.warn("Toluwalase-XMD process is running, but WhatsApp connection is not confirmed yet.");
    }
    return runtime;
  } catch (error) {
    await shutdown();
    throw error;
  }
}

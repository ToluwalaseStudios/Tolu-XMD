import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const entryFile = require.resolve("@whiskeysockets/baileys");
const libraryDirectory = path.dirname(entryFile);
const packageDirectory = path.resolve(libraryDirectory, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));

if (packageJson.version !== "7.0.0-rc14") {
  throw new Error(
    "The Toluwalase-XMD Baileys reliability patch is validated only for 7.0.0-rc14; found " +
    packageJson.version + ". Review the upstream release before changing this guard."
  );
}

const receiveFile = path.join(libraryDirectory, "Socket", "messages-recv.js");
let source = await fs.readFile(receiveFile, "utf8");

if (source.includes("CB:status") && source.includes("handleStatus")) {
  console.log("Baileys top-level status acknowledgement is already installed.");
} else {
  const offlineProcessorAnchor = "const offlineNodeProcessor = makeOfflineNodeProcessor(";
  const notificationHandlerEntry = "['notification', handleNotification]";
  const statusListenerAnchor = "ws.on('CB:ack,class:message'";

  for (const [label, anchor] of [
    ["offline processor", offlineProcessorAnchor],
    ["notification handler map entry", notificationHandlerEntry],
    ["status listener insertion point", statusListenerAnchor]
  ]) {
    const first = source.indexOf(anchor);
    if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
      throw new Error("Cannot safely patch Baileys: expected exactly one " + label + " anchor.");
    }
  }

  const statusHandler = `const handleStatus = async node => {
    try {
      await sendMessageAck(node)
    } catch (error) {
      onUnexpectedError(error, 'acking status stanza')
    }
  }

  `;

  source = source.replace(offlineProcessorAnchor, statusHandler + offlineProcessorAnchor);
  source = source.replace(
    notificationHandlerEntry,
    notificationHandlerEntry + ",\n            ['status', handleStatus]"
  );

  const statusListener = `ws.on('CB:status', async node => {
    await processNode('status', node, 'acking status stanza', handleStatus).catch(error =>
      onUnexpectedError(error, 'acking status stanza')
    )
  })

  `;

  source = source.replace(statusListenerAnchor, statusListener + statusListenerAnchor);
  await fs.writeFile(receiveFile, source, "utf8");
  console.log("Applied the Baileys top-level status acknowledgement patch.");
}

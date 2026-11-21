import test from "node:test";
import assert from "node:assert/strict";

import { getWhatsAppBrowser, rememberUpsertMessages } from "../lib/whatsapp-runtime.js";
import { createRecentMessageStore } from "../lib/message-store.js";

test("unregistered WhatsApp sessions retain a Web identity for pairing", () => {
  assert.deepEqual(
    getWhatsAppBrowser({ registered: false }, {}),
    ["Ubuntu", "Chrome", "20.0.04"]
  );
});

test("registered personal WhatsApp sessions use Baileys' Android Chrome preset", () => {
  const calls = [];
  const browsers = {
    android: browserName => {
      calls.push(browserName);
      return [browserName, "Android", ""];
    }
  };
  assert.deepEqual(
    getWhatsAppBrowser({ registered: true }, browsers),
    ["Chrome", "Android", ""]
  );
  assert.deepEqual(calls, ["Chrome"]);
});

test("registered sessions fail clearly if Android identity is unavailable", () => {
  assert.throws(
    () => getWhatsAppBrowser({ registered: true }, {}),
    /does not support the Android browser identity/
  );
});


test("messages.upsert stores complete original messages before dispatch", () => {
  const store = createRecentMessageStore();
  const original = {
    key: { remoteJid: "12345-678@g.us", id: "vo-original-1" },
    message: {
      viewOnceMessageV2: {
        message: {
          imageMessage: {
            url: "https://mmg.whatsapp.net/original",
            directPath: "/v/t62/original",
            mediaKey: Buffer.from("original-media-key")
          }
        }
      }
    }
  };
  const saved = rememberUpsertMessages(store, {
    type: "notify",
    messages: [
      { key: { remoteJid: "12345-678@g.us", id: "stub-only" }, messageStubType: 2 },
      original
    ]
  });

  assert.equal(saved, 1);
  const retrieved = store.get({ remoteJid: "12345-678@g.us", id: "vo-original-1" });
  assert.equal(retrieved, original);
  const media = retrieved.message.viewOnceMessageV2.message.imageMessage;
  assert.equal(media.directPath, "/v/t62/original");
  assert.deepEqual(media.mediaKey, Buffer.from("original-media-key"));
  assert.equal(store.get({ remoteJid: "12345-678@g.us", id: "stub-only" }), null);
});

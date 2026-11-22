import test from "node:test";
import assert from "node:assert/strict";
import { createRecentMessageStore, DEFAULT_MESSAGE_STORE_TTL_MS, DEFAULT_MESSAGE_STORE_MAX_ENTRIES } from "../lib/message-store.js";

test("recent message store retrieves the complete original message by chat and stanza ID", () => {
  const store = createRecentMessageStore();
  const original = {
    key: { remoteJid: "2348000000000-123@g.us", id: "media-1", participant: "2348111111111@s.whatsapp.net" },
    message: { imageMessage: { url: "https://mmg.whatsapp.net/example", directPath: "/v/t62/example", mediaKey: Buffer.from("key") } }
  };
  assert.equal(store.remember(original), true);
  assert.equal(store.get({ remoteJid: original.key.remoteJid, id: "media-1" }), original);
});

test("recent message store expires entries and enforces its size limit", () => {
  let time = 1000;
  const store = createRecentMessageStore({ ttlMs: 50, maxEntries: 2, now: () => time });
  for (let i = 1; i <= 3; i += 1) {
    store.remember({ key: { remoteJid: "2348000000000@s.whatsapp.net", id: String(i) }, message: { conversation: String(i) } });
  }
  assert.equal(store.size, 2);
  assert.equal(store.get({ remoteJid: "2348000000000@s.whatsapp.net", id: "1" }), null);
  time += 51;
  assert.equal(store.size, 0);
});


test("recent message store resolves a message through its alternate PN/LID chat ID", () => {
  const store = createRecentMessageStore();
  const original = {
    key: {
      remoteJid: "1234567890@lid",
      remoteJidAlt: "2348012345678@s.whatsapp.net",
      id: "view-once-lid-1"
    },
    message: {
      viewOnceMessageV2: {
        message: { imageMessage: { mediaKey: Buffer.from("media-key") } }
      }
    }
  };

  assert.equal(store.remember(original), true);
  assert.equal(
    store.get({ remoteJid: "2348012345678:4@s.whatsapp.net", id: "view-once-lid-1" }),
    original
  );
  assert.deepEqual(
    store.getMessage({ remoteJid: "1234567890@lid", id: "view-once-lid-1" }),
    original.message
  );
});

test("recent message store ignores incomplete WhatsApp stubs without a message body", () => {
  const store = createRecentMessageStore();
  assert.equal(store.remember({
    key: { remoteJid: "2348012345678@s.whatsapp.net", id: "stub-1" }
  }), false);
  assert.equal(store.size, 0);
});


test("default message retention is extended to one hour with a bounded store", () => {
  assert.equal(DEFAULT_MESSAGE_STORE_TTL_MS, 60 * 60 * 1000);
  assert.equal(DEFAULT_MESSAGE_STORE_MAX_ENTRIES, 2500);
});

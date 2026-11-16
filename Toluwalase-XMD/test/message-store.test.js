import test from "node:test";
import assert from "node:assert/strict";
import { createRecentMessageStore } from "../lib/message-store.js";

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

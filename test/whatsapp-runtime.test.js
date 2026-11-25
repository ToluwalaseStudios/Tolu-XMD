import test from "node:test";
import assert from "node:assert/strict";
import {
  getWhatsAppBrowser,
  rememberUpsertMessages,
  shouldHandleViewOnceReaction,
  canDispatchCommandInMode
} from "../lib/whatsapp-runtime.js";
import { createRecentMessageStore } from "../lib/message-store.js";

test("unregistered WhatsApp sessions retain a Web identity for pairing", () => {
  assert.deepEqual(getWhatsAppBrowser({ registered: false }, {}), ["Ubuntu", "Chrome", "20.0.04"]);
});

test("registered personal WhatsApp sessions use Baileys' Android Chrome preset", () => {
  const calls = [];
  const browsers = { android: browserName => { calls.push(browserName); return [browserName, "Android", ""]; } };
  assert.deepEqual(getWhatsAppBrowser({ registered: true }, browsers), ["Chrome", "Android", ""]);
  assert.deepEqual(calls, ["Chrome"]);
});

test("registered sessions fail clearly if Android identity is unavailable", () => {
  assert.throws(() => getWhatsAppBrowser({ registered: true }, {}), /does not support the Android browser identity/);
});

test("messages.upsert stores complete original messages before dispatch", () => {
  const store = createRecentMessageStore();
  const original = {
    key: { remoteJid: "12345-678@g.us", id: "vo-original-1" },
    message: { viewOnceMessageV2: { message: { imageMessage: {
      url: "https://mmg.whatsapp.net/original",
      directPath: "/v/t62/original",
      mediaKey: Buffer.from("original-media-key")
    } } } }
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
  assert.equal(retrieved.message.viewOnceMessageV2.message.imageMessage.directPath, "/v/t62/original");
});

test("view-once reaction trigger accepts only the configured emoji reacted by this account", () => {
  const seen = new Set();
  const update = {
    key: { remoteJid: "12345-678@g.us", id: "view-once-1" },
    reaction: { text: "⚡", key: { remoteJid: "12345-678@g.us", id: "reaction-1", fromMe: true } }
  };
  assert.equal(shouldHandleViewOnceReaction(update, "⚡", seen), true);
  assert.equal(shouldHandleViewOnceReaction(update, "⚡", seen), false);
  assert.equal(shouldHandleViewOnceReaction(update, "❤️", new Set()), false);
  assert.equal(shouldHandleViewOnceReaction({
    ...update,
    reaction: { ...update.reaction, key: { ...update.reaction.key, fromMe: false } }
  }, "⚡", new Set()), false);
});

test("Private mode bypass is limited to commands explicitly marked for independent access", () => {
  const config = { ownerNumbers: ["2348000000001"] };
  const trivia = { name: "trivia", allowInPrivateMode: true };
  const ordinary = { name: "calc" };
  assert.equal(canDispatchCommandInMode("private", config, "2348000000002@s.whatsapp.net", trivia), true);
  assert.equal(canDispatchCommandInMode("private", config, "2348000000002@s.whatsapp.net", ordinary), false);
  assert.equal(canDispatchCommandInMode("private", config, "2348000000001@s.whatsapp.net", ordinary), true);
  assert.equal(canDispatchCommandInMode("public", config, "2348000000002@s.whatsapp.net", ordinary), true);
});

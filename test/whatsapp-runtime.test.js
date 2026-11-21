import test from "node:test";
import assert from "node:assert/strict";

import { getWhatsAppBrowser } from "../lib/whatsapp-runtime.js";

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

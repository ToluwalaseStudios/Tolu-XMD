import test from "node:test";
import assert from "node:assert/strict";

import { getWhatsAppBrowser } from "../lib/whatsapp-runtime.js";

test("unregistered WhatsApp sessions retain a Web identity for pairing", () => {
  assert.deepEqual(
    getWhatsAppBrowser({ registered: false }, {}, {}),
    ["Ubuntu", "Chrome", "20.0.04"]
  );
});

test("registered personal WhatsApp sessions use the Android 13 identity", () => {
  const browsers = {
    android: version => ["Android", "Chrome", version]
  };
  assert.deepEqual(
    getWhatsAppBrowser({ registered: true }, {}, browsers),
    ["Android", "Chrome", "13"]
  );
});

test("registered WhatsApp Business sessions use the SMB Android identity", () => {
  const browsers = {
    SMB_ANDROID: ["SMB", "Chrome", "Android"]
  };
  assert.deepEqual(
    getWhatsAppBrowser(
      { registered: true },
      { businessAccount: true },
      browsers
    ),
    browsers.SMB_ANDROID
  );
});

test("business identity reports a clear error if unsupported by the installed Baileys build", () => {
  assert.throws(
    () => getWhatsAppBrowser({ registered: true }, { businessAccount: true }, {}),
    /does not expose the SMB Android browser identity/
  );
});

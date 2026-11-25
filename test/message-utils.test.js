import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeJid,
  numberFromJid,
  unwrapMessage,
  messageText,
  getContextInfo,
  getMessageSender,
  hasViewOnceMarker
} from "../lib/message-utils.js";

test("normalizes WhatsApp JIDs and device suffixes", () => {
  assert.equal(normalizeJid("2348012345678:4@s.whatsapp.net"), "2348012345678@s.whatsapp.net");
  assert.equal(numberFromJid("2348012345678:4@s.whatsapp.net"), "2348012345678");
});

test("unwraps supported message wrappers and extracts text", () => {
  const message = {
    ephemeralMessage: {
      message: {
        extendedTextMessage: { text: "  .ping  " }
      }
    }
  };
  assert.equal(messageText(message), ".ping");
  assert.deepEqual(unwrapMessage(message), {
    extendedTextMessage: { text: "  .ping  " }
  });
});

test("extracts image captions and sender identity", () => {
  assert.equal(messageText({ imageMessage: { caption: ".menu" } }), ".menu");
  assert.equal(
    getMessageSender(
      { key: { remoteJid: "group@g.us", participant: "2348012345678:2@s.whatsapp.net" } },
      {}
    ),
    "2348012345678@s.whatsapp.net"
  );
});

test("prefers WhatsApp phone-number alternate JIDs when the primary JID is a LID", () => {
  assert.equal(
    getMessageSender(
      { key: { remoteJid: "123456789012345@lid", remoteJidAlt: "2348012345678@s.whatsapp.net" } },
      {}
    ),
    "2348012345678@s.whatsapp.net"
  );
  assert.equal(
    getMessageSender(
      {
        key: {
          remoteJid: "group@g.us",
          participant: "123456789012345@lid",
          participantAlt: "2348012345678@s.whatsapp.net"
        }
      },
      {}
    ),
    "2348012345678@s.whatsapp.net"
  );
});


test("finds quoted reply context inside wrapped WhatsApp messages", () => {
  const quotedMessage = {
    viewOnceMessageV2: {
      message: { imageMessage: { mimetype: "image/jpeg" } }
    }
  };
  const message = {
    ephemeralMessage: {
      message: {
        extendedTextMessage: {
          text: "Brovv",
          contextInfo: {
            stanzaId: "quoted-123",
            participant: "2348012345678@s.whatsapp.net",
            quotedMessage
          }
        }
      }
    }
  };

  const context = getContextInfo(message);
  assert.equal(context?.stanzaId, "quoted-123");
  assert.equal(context?.participant, "2348012345678@s.whatsapp.net");
  assert.equal(context?.quotedMessage, quotedMessage);
});


test("recognises all supported view-once wrapper variants", () => {
  for (const wrapper of [
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension"
  ]) {
    assert.equal(
      hasViewOnceMarker({ [wrapper]: { message: { imageMessage: {} } } }),
      true,
      wrapper
    );
  }
});

test("recognises direct image, video, audio and document viewOnce flags", () => {
  for (const mediaType of ["imageMessage", "videoMessage", "audioMessage", "documentMessage"]) {
    assert.equal(hasViewOnceMarker({ [mediaType]: { viewOnce: true } }), true, mediaType);
  }
});

test("does not mistake ordinary media or nested quoted context for view-once", () => {
  for (const mediaType of ["imageMessage", "videoMessage", "audioMessage", "documentMessage"]) {
    assert.equal(hasViewOnceMarker({ [mediaType]: { viewOnce: false } }), false, mediaType);
    assert.equal(hasViewOnceMarker({ [mediaType]: { mimetype: "image/jpeg" } }), false, mediaType);
  }
  assert.equal(hasViewOnceMarker({
    extendedTextMessage: {
      contextInfo: {
        quotedMessage: { viewOnceMessageV2: { message: { imageMessage: {} } } }
      }
    }
  }), false);
});

test("recognises view-once wrappers nested in ephemeral and document caption wrappers", () => {
  assert.equal(hasViewOnceMarker({
    ephemeralMessage: {
      message: {
        documentWithCaptionMessage: {
          message: {
            viewOnceMessageV2: { message: { documentMessage: {} } }
          }
        }
      }
    }
  }), true);
});
test("message sender resolution prefers the phone JID when alternate group identities differ", async () => {
  const { getMessageSender } = await import("../lib/message-utils.js");
  assert.equal(getMessageSender({
    key: {
      remoteJid: "12345-678@g.us",
      participant: "2348000000001@s.whatsapp.net",
      participantAlt: "998877@lid"
    }
  }), "2348000000001@s.whatsapp.net");
  assert.equal(getMessageSender({
    key: {
      remoteJid: "12345-678@g.us",
      participant: "998877@lid",
      participantAlt: "2348000000002@s.whatsapp.net"
    }
  }), "2348000000002@s.whatsapp.net");
});

import test from "node:test";
import assert from "node:assert/strict";

import { loadCommands } from "../handlers/command-loader.js";
import {
  buildViewOnceCaption,
  hasViewOnceWrapper,
  resolveQuotedMessage,
  viewOncePayload
} from "../commands/custom/vv.js";
import { hasViewOnceMarker } from "../lib/message-utils.js";

test("view-once commands load and register both names", async () => {
  const { lookup } = await loadCommands();
  assert.ok(lookup.get("vv"));
  assert.ok(lookup.get("vv2"));
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

test("recognises direct media nodes carrying the protobuf viewOnce flag", () => {
  for (const mediaType of ["imageMessage", "videoMessage", "audioMessage", "documentMessage"]) {
    assert.equal(
      hasViewOnceMarker({ [mediaType]: { viewOnce: true } }),
      true,
      mediaType
    );
  }
});


test("command detector accepts Baileys direct-media viewOnce flags", () => {
  for (const mediaType of ["imageMessage", "videoMessage", "audioMessage", "documentMessage"]) {
    assert.equal(hasViewOnceWrapper({ [mediaType]: { viewOnce: true } }), true, mediaType);
  }
  assert.equal(hasViewOnceWrapper({ imageMessage: { mimetype: "image/jpeg" } }), false);
});

test("does not classify ordinary media as view-once", () => {
  for (const mediaType of ["imageMessage", "videoMessage", "audioMessage", "documentMessage"]) {
    assert.equal(
      hasViewOnceMarker({ [mediaType]: { viewOnce: false } }),
      false,
      mediaType
    );
    assert.equal(
      hasViewOnceMarker({ [mediaType]: { mimetype: "application/octet-stream" } }),
      false,
      mediaType
    );
  }
});

test("finds view-once wrappers nested inside ephemeral and caption wrappers", () => {
  assert.equal(hasViewOnceMarker({
    ephemeralMessage: {
      message: {
        documentWithCaptionMessage: {
          message: {
            viewOnceMessageV2: {
              message: { documentMessage: {} }
            }
          }
        }
      }
    }
  }), true);
});

test("view-once recovery returns a useful reply when the command has no quoted message", async () => {
  const { lookup } = await loadCommands();
  const replies = [];
  const ctx = {
    command: "vv",
    args: "",
    jid: "2348000000000@s.whatsapp.net",
    senderJid: "2348000000000@s.whatsapp.net",
    msg: {
      key: { remoteJid: "2348000000000@s.whatsapp.net", id: "command-1" },
      message: { conversation: ".vv" }
    },
    sock: { user: { id: "2348000000000@s.whatsapp.net" } },
    config: { prefix: "." },
    reply: async value => replies.push(String(value))
  };

  await lookup.get("vv").run(ctx);
  assert.match(replies[0], /Reply to a view-once/i);
});

test("view-once recovery rejects ordinary media that has no view-once wrapper", async () => {
  const { lookup } = await loadCommands();
  const replies = [];
  const ctx = {
    command: "vv",
    args: "",
    jid: "2348000000000@s.whatsapp.net",
    senderJid: "2348000000000@s.whatsapp.net",
    msg: {
      key: { remoteJid: "2348000000000@s.whatsapp.net", id: "command-2" },
      message: {
        extendedTextMessage: {
          text: ".vv",
          contextInfo: {
            stanzaId: "ordinary-image-1",
            quotedMessage: { imageMessage: { mimetype: "image/jpeg" } }
          }
        }
      }
    },
    sock: { user: { id: "2348000000000@s.whatsapp.net" } },
    config: { prefix: "." },
    reply: async value => replies.push(String(value))
  };

  await lookup.get("vv").run(ctx);
  assert.match(replies[0], /not view-once media/i);
});


test("prefers the original stored WhatsApp message over the reduced quoted snippet", () => {
  const original = {
    key: {
      remoteJid: "12345-678@g.us",
      participant: "2348000000000@s.whatsapp.net",
      id: "view-once-1",
      fromMe: false
    },
    messageTimestamp: 1795000000,
    message: {
      viewOnceMessageV2: {
        message: {
          imageMessage: {
            mediaKey: Buffer.from("original-media-key"),
            url: "https://mmg.whatsapp.net/example",
            mimetype: "image/jpeg"
          }
        }
      }
    }
  };
  const ctx = {
    jid: "12345-678@g.us",
    msg: {
      key: { remoteJid: "12345-678@g.us", id: "command-1" },
      message: {
        extendedTextMessage: {
          contextInfo: {
            stanzaId: "view-once-1",
            participant: "2348000000000@s.whatsapp.net",
            quotedMessage: {
              viewOnceMessageV2: {
                message: { imageMessage: { mimetype: "image/jpeg" } }
              }
            }
          }
        }
      }
    },
    getMessageByKey: key => key.id === "view-once-1" ? original : null
  };

  const resolved = resolveQuotedMessage(ctx);
  assert.equal(resolved.source, "stored");
  assert.equal(resolved.message, original);
  assert.equal(resolved.key, original.key);
  assert.ok(resolved.message.message.viewOnceMessageV2.message.imageMessage.mediaKey);
});


test("resolves the original stored message even when WhatsApp omits the quoted snippet", () => {
  const original = {
    key: {
      remoteJid: "1234567890@lid",
      remoteJidAlt: "2348012345678@s.whatsapp.net",
      id: "view-once-lid-2"
    },
    message: {
      viewOnceMessageV2: {
        message: { videoMessage: { mediaKey: Buffer.from("full-media-key") } }
      }
    }
  };
  const ctx = {
    msg: {
      key: {
        remoteJid: "2348012345678:4@s.whatsapp.net",
        id: "command-lid-2"
      },
      message: {
        extendedTextMessage: {
          contextInfo: { stanzaId: "view-once-lid-2" }
        }
      }
    },
    getMessageByKey: key => key.id === "view-once-lid-2" ? original : null
  };

  const resolved = resolveQuotedMessage(ctx);
  assert.equal(resolved.source, "stored");
  assert.equal(resolved.message, original);
  assert.ok(resolved.message.message.viewOnceMessageV2.message.videoMessage.mediaKey);
});

test("quoted-message fallback uses the best available participant identifier", () => {
  const ctx = {
    jid: "12345-678@g.us",
    msg: {
      key: { remoteJid: "12345-678@g.us", id: "command-2" },
      message: {
        extendedTextMessage: {
          contextInfo: {
            stanzaId: "view-once-2",
            participant: "2348000000000:4@s.whatsapp.net",
            participantPn: "2348111111111@s.whatsapp.net",
            quotedMessage: {
              viewOnceMessageV2: { message: { imageMessage: {} } }
            }
          }
        }
      }
    },
    sock: { user: { id: "2348000000000@s.whatsapp.net" } }
  };

  const resolved = resolveQuotedMessage(ctx);
  assert.equal(resolved.source, "quoted");
  assert.equal(resolved.key.participant, "2348111111111@s.whatsapp.net");
  assert.equal(resolved.key.fromMe, false);
});

test("view-once payload conversion preserves the supported WhatsApp media fields", () => {
  const imageBuffer = Buffer.from("image");
  const image = viewOncePayload({
    kind: "image",
    buffer: imageBuffer,
    media: { caption: "original caption", mimetype: "image/jpeg" }
  });
  assert.equal(image.image, imageBuffer);
  assert.equal(image.caption, "original caption");
  assert.equal(image.mimetype, "image/jpeg");

  const audioBuffer = Buffer.from("audio");
  const audio = viewOncePayload({
    kind: "audio",
    buffer: audioBuffer,
    media: { mimetype: "audio/ogg; codecs=opus", ptt: true }
  });
  assert.equal(audio.audio, audioBuffer);
  assert.equal(audio.mimetype, "audio/ogg; codecs=opus");
  assert.equal(audio.ptt, true);

  const documentBuffer = Buffer.from("document");
  const document = viewOncePayload({
    kind: "document",
    buffer: documentBuffer,
    media: { mimetype: "application/pdf", fileName: "report.pdf" }
  });
  assert.equal(document.document, documentBuffer);
  assert.equal(document.mimetype, "application/pdf");
  assert.equal(document.fileName, "report.pdf");
});

test("view-once recovery caption keeps the supplied original caption and project footer", () => {
  const caption = buildViewOnceCaption({
    media: { caption: "A saved moment" }
  });
  assert.match(caption, /Media extracted from view-once successfully/);
  assert.match(caption, /A saved moment/);
  assert.match(caption, /ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴛᴏʟᴜᴡᴀʟᴀꜱᴇ ꜱᴛᴜᴅɪᴏꜱ/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { findYouTubeMediaUrls, readMp4DurationSeconds } from "../commands/downloads.js";

test("YouTube media extraction handles nested objects and URL arrays", () => {
  const payload = {
    data: {
      formats: [
        "https://cdn.example.test/video-720.mp4?token=abc",
        "https://cdn.example.test/audio-128.mp3?token=def"
      ],
      thumbnails: [{ url: "https://cdn.example.test/cover.jpg" }]
    }
  };

  assert.deepEqual(findYouTubeMediaUrls(payload, "video"), [
    "https://cdn.example.test/video-720.mp4?token=abc"
  ]);
  assert.deepEqual(findYouTubeMediaUrls(payload, "audio"), [
    "https://cdn.example.test/audio-128.mp3?token=def"
  ]);
});

test("YouTube media extraction handles serialized JSON and signed extensionless URLs", () => {
  const payload = {
    response: JSON.stringify({
      download: {
        audio: "https://cdn.example.test/get?id=123&sig=abc",
        video: "https://cdn.example.test/get?id=456&sig=def"
      }
    })
  };

  assert.deepEqual(findYouTubeMediaUrls(payload, "audio"), [
    "https://cdn.example.test/get?id=123&sig=abc"
  ]);
  assert.deepEqual(findYouTubeMediaUrls(payload, "video"), [
    "https://cdn.example.test/get?id=456&sig=def"
  ]);
});

test("YouTube media extraction rejects thumbnails and the original watch page", () => {
  const payload = {
    thumbnail: "https://cdn.example.test/thumb.jpg",
    watchUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    download: "https://cdn.example.test/video.mp4"
  };

  assert.deepEqual(findYouTubeMediaUrls(payload, "video"), [
    "https://cdn.example.test/video.mp4"
  ]);
});


function makeMp4WithDuration(duration, timescale = 1000) {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write("ftyp", 4, "ascii");
  ftyp.write("isom", 8, "ascii");

  const mvhd = Buffer.alloc(28);
  mvhd.writeUInt32BE(28, 0);
  mvhd.write("mvhd", 4, "ascii");
  mvhd.writeUInt8(0, 8);
  mvhd.writeUInt32BE(timescale, 20);
  mvhd.writeUInt32BE(duration, 24);

  const moov = Buffer.alloc(36);
  moov.writeUInt32BE(36, 0);
  moov.write("moov", 4, "ascii");
  mvhd.copy(moov, 8);
  return Buffer.concat([ftyp, moov]);
}

test("MP4 duration parser reads a valid movie header duration", () => {
  assert.equal(readMp4DurationSeconds(makeMp4WithDuration(125000)), 125);
});

test("MP4 duration parser rejects zero or missing duration metadata", () => {
  assert.equal(readMp4DurationSeconds(makeMp4WithDuration(0)), 0);
  assert.equal(readMp4DurationSeconds(Buffer.from("not an mp4")), 0);
});

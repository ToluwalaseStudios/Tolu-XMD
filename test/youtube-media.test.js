import test from "node:test";
import assert from "node:assert/strict";
import { findYouTubeMediaUrls } from "../commands/downloads.js";

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

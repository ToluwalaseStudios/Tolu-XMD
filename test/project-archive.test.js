import test from "node:test";
import assert from "node:assert/strict";
import { collectBuildFiles, createBuildArchive } from "../lib/project-archive.js";

test("collects generated files from common LlamaCoder response shapes", () => {
  const files = collectBuildFiles({
    success: true,
    data: {
      sessionId: "session-1",
      files: [
        { name: "index.html", content: "<h1>Hello</h1>" },
        { path: "src/app.js", code: "console.log('ready')" }
      ]
    }
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "index.html");
  assert.equal(files[1].name, "src/app.js");
});

test("collects file maps and removes unsafe path traversal", () => {
  const files = collectBuildFiles({
    data: { project: { files: { "index.html": "<main>OK</main>", "../../config.json": "{}" } } }
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "index.html");
  assert.equal(files[1].name, "config.json");
});

test("creates a valid ZIP archive containing the generated files", async () => {
  const archive = await createBuildArchive([
    { name: "index.html", content: "<h1>Hello</h1>" },
    { name: "assets/app.js", content: "console.log('hello')" }
  ]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
  assert.equal(archive.readUInt16LE(archive.length - 12), 2);
});

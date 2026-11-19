import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const entryFile = require.resolve("@whiskeysockets/baileys");
const libraryDirectory = path.dirname(entryFile);
const packageDirectory = path.resolve(libraryDirectory, "..");

test("installed Baileys acknowledges live and offline top-level status stanzas", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(packageDirectory, "package.json"), "utf8"));
  assert.equal(pkg.version, "7.0.0-rc14");

  const source = await fs.readFile(
    path.join(libraryDirectory, "Socket", "messages-recv.js"),
    "utf8"
  );

  assert.match(source, /const handleStatus = async node =>/);
  assert.match(source, /\['status', handleStatus\]/);
  assert.match(source, /ws\.on\('CB:status'/);
  assert.match(source, /acking status stanza/);
});

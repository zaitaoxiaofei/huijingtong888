import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/archive-ai-draft-save-payloads.mjs", import.meta.url), "utf8");

test("AI draft payload archive defaults to dry-run and never mutates MySQL", () => {
  assert.match(source, /process\.argv\.includes\("--write"\)/);
  assert.match(source, /databaseMutation: false/);
  assert.doesNotMatch(source, /\b(?:UPDATE|DELETE|TRUNCATE|DROP|ALTER)\s+(?:TABLE\s+)?ai_variant_draft_save_items/i);
});

test("AI draft payload archive is bounded, compressed, verified, and cleans temporary files", () => {
  assert.match(source, /BATCH_SIZE[\s\S]{0,120}, 1\), 20\)/);
  assert.match(source, /createGzip\(\{ level: 9 \}\)/);
  assert.match(source, /multipartUpload/);
  assert.match(source, /OSS size mismatch/);
  assert.match(source, /fsp\.rm\(tempDir, \{ recursive: true, force: true \}\)/);
});

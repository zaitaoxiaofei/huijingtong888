import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/compact-archived-ai-draft-payloads.mjs", import.meta.url), "utf8");

test("archived payload compaction defaults to dry-run and requires an archive hash", () => {
  assert.match(source, /process\.argv\.includes\("--write"\)/);
  assert.match(source, /A valid --archive-sha256 is required/);
  assert.match(source, /contentSha256 !== ARCHIVE_SHA256/);
});

test("archived payload compaction verifies status, result draft, and exact payload before updates", () => {
  assert.match(source, /current\.status !== "completed"/);
  assert.match(source, /!current\.draft_exists/);
  assert.match(source, /result_draft_changed/);
  assert.match(source, /payload_changed/);
  assert.match(source, /refusing partial compaction/);
  assert.match(source, /SET payload_json = '\{\}'/);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\s+ai_variant_draft_save_items/i);
});

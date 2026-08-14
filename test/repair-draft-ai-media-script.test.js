import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const scriptSource = readFileSync(new URL("../scripts/repair-draft-ai-media.mjs", import.meta.url), "utf8");

test("draft AI media repair script scans non-deleted drafts with ai file or local preview URLs in batches", () => {
  assert.match(scriptSource, /source_images_json LIKE '%\/api\/ai\/file\/%'/);
  assert.match(scriptSource, /template_payload_json LIKE '%\/api\/ai\/file\/%'/);
  assert.match(scriptSource, /source_images_json LIKE '%\/uploads\/listing-media\/%'/);
  assert.match(scriptSource, /template_payload_json LIKE '%localhost%'/);
  assert.match(scriptSource, /template_payload_json LIKE '%127\.0\.0\.1%'/);
  assert.match(scriptSource, /status <> 'deleted'/);
  assert.match(scriptSource, /repairAiOptimizationListingMedia/);
  assert.match(scriptSource, /--write/);
  assert.match(scriptSource, /--batch=/);
});

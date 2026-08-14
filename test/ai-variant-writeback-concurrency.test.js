import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const viewSource = readFileSync(new URL("../frontend/admin/views/settings/PromptLibraryView.vue", import.meta.url), "utf8");
const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("AI variant writeback saves independent groups with bounded concurrency", () => {
  assert.match(viewSource, /const WRITEBACK_CONCURRENCY = 3/);
  assert.match(viewSource, /runWriteBackQueue\(writable, WRITEBACK_CONCURRENCY\)/);
  assert.match(viewSource, /await Promise\.all\(workers\)/);
  assert.doesNotMatch(viewSource, /for \(const item of writable\) \{\s*await writeBack/);
});

test("listing media URL lists materialize concurrently", () => {
  assert.match(listingSource, /Promise\.all\(urls\.map\(\(url\) => materializeListingMediaUrl/);
});

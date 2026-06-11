import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/settings/PromptLibraryView.vue", import.meta.url), "utf8");

test("AI listing record writeback syncs only free text Ozon attributes", () => {
  assert.match(source, /function syncListingRecordFreeTextAttributes\(item = \{\}, fields = \{\}\)/);
  assert.match(source, /upsertListingRecordTextAttribute\(item, 23171, "产品标签", fields\.tags\)/);
  assert.match(source, /upsertListingRecordTextAttribute\(item, 4191, "简介", \[fields\.description\]\)/);
  assert.match(source, /upsertListingRecordTextAttribute\(item, 11254, "JSON富内容", \[fields\.richContentJson\]\)/);
  assert.match(source, /upsertListingRecordRichComplexAttribute\(item, fields\.richContentJson\)/);
});

test("AI listing record writeback preserves existing dictionary attributes", () => {
  assert.match(source, /const existing = item\.attributes\.find\(\(attr\) => Number\(attr\.id \|\| attr\.attribute_id \|\| 0\) === Number\(id\)\)/);
  assert.doesNotMatch(source, /dictionary_value_id\s*:\s*undefined/);
  assert.doesNotMatch(source, /item\.attributes\s*=\s*\[\]/);
  assert.match(source, /else item\.attributes\.push\(next\)/);
});

test("AI listing record writeback stores rich content in request and complex attributes", () => {
  assert.match(source, /item\.rich_content_json = JSON\.stringify\(richContent\)/);
  assert.match(source, /id: "rich_content_json", values: \[\{ value: text \}\]/);
});

test("AI source picker keeps source lists lightweight", () => {
  assert.match(source, /summaryMode:\s*"skip"/);
  assert.match(source, /includePayload:\s*"0"/);
});

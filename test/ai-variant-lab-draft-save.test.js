import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");
const saveSelectedRows = source.match(/async function saveSelectedRowsToDrafts\(\) \{[\s\S]*?\n\}/)?.[0] || "";

test("AI variant batch draft save does not block on video generation", () => {
  assert.match(saveSelectedRows, /prepareGeneratedRowsForDraft\(rows, \{ silent: true, generateVideo: false/);
  assert.doesNotMatch(saveSelectedRows, /ensureGeneratedRowVideos\(/);
});

test("AI variant batch draft save reports submission failures", () => {
  assert.match(saveSelectedRows, /catch \(error\)/);
  assert.match(saveSelectedRows, /批量保存任务提交失败，请稍后重试/);
  assert.match(saveSelectedRows, /row\.draftSaveStatus = "failed"/);
});

test("AI variant draft saves split large payloads before submission", () => {
  assert.match(source, /DRAFT_SAVE_REQUEST_TARGET_BYTES = 8 \* 1024 \* 1024/);
  assert.match(source, /function buildDraftSaveRequestChunks\(rows = \[\]\)/);
  assert.match(source, /new TextEncoder\(\)\.encode\(JSON\.stringify\(item\)\)\.length/);
  assert.match(source, /runWithConcurrency\(chunks\.map/);
  assert.match(source, /DRAFT_SAVE_SUBMIT_CONCURRENCY = 3/);
  assert.match(source, /monitorDraftSaveBatches\(batches\)/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const wrapperSource = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");

test("AI workbench proxy clears stale draft cache before runtime import", () => {
  assert.match(wrapperSource, /purgeStaleWorkbenchCache/);
  assert.match(wrapperSource, /ozon-ai-product-variant-workbench-draft:/);
  assert.match(wrapperSource, /codex-empty-boundary/);
});

test("AI workbench keeps runtime styles in source instead of loading proxy CSS", () => {
  assert.doesNotMatch(wrapperSource, /runtimeStyleAsset/);
  assert.doesNotMatch(wrapperSource, /document\.createElement\("link"\)/);
  assert.match(wrapperSource, /ai variant workbench base layout/);
  assert.match(wrapperSource, /\.variant-result-table\[data-v-750c83a9\]/);
  assert.match(wrapperSource, /\.table-video-preview video\[data-v-750c83a9\]/);
  assert.match(wrapperSource, /defineAsyncComponent\(\(\) => import/);
});

test("AI workbench result actions use a compact grid layout", () => {
  assert.match(wrapperSource, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(wrapperSource, /width:\s*260px/);
});

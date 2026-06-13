import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";

const wrapperSource = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");
const publicAssetsUrl = new URL("../public/vue-apps/assets/", import.meta.url);
const publicAssets = readdirSync(publicAssetsUrl);
const publicWrapperAsset = publicAssets.find((name) => /^AiOptimizationWorkbenchV2-.*\.js$/.test(name));
const publicCssAsset = publicAssets.find((name) => /^AiOptimizationWorkbenchV2-.*\.css$/.test(name));
const publicWrapper = readFileSync(new URL(publicWrapperAsset, publicAssetsUrl), "utf8");
const publicCss = readFileSync(new URL(publicCssAsset, publicAssetsUrl), "utf8");

test("AI workbench proxy clears stale draft cache before runtime import", () => {
  assert.match(wrapperSource, /purgeStaleWorkbenchCache/);
  assert.match(wrapperSource, /ozon-ai-product-variant-workbench-draft:/);
  assert.match(wrapperSource, /codex-ai-variant-empty-boundary/);
  assert.match(publicWrapper, /sessionStorage\.removeItem/);
  assert.match(publicWrapper, /codex-ai-variant-empty-boundary/);
});

test("AI workbench result actions use a compact grid layout", () => {
  assert.match(wrapperSource, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(wrapperSource, /width:\s*260px/);
  assert.match(publicCss, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(publicCss, /width:260px;min-width:260px/);
});

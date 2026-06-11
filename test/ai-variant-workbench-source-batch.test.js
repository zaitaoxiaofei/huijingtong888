import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");

test("AI variant workbench isolates imported products and results by source batch", () => {
  assert.match(source, /const currentSourceBatchId = ref\(""\)/);
  assert.match(source, /function beginSourceBatch\(\)/);
  assert.match(source, /const currentProducts = computed/);
  assert.match(source, /item\.sourceBatchId === batchId/);
  assert.match(source, /item\.status !== "deleted" && \(!batchId \|\| item\.sourceBatchId === batchId\)/);
});

test("AI variant listing drafts keep source batch trace fields", () => {
  assert.match(source, /source_batch_id: row\.sourceBatchId \|\| product\.sourceBatchId \|\| ""/);
  assert.match(source, /source_product_id: row\.sourceProductId \|\| product\.id \|\| ""/);
  assert.match(source, /variant_target: row\.variantTarget \|\| ""/);
  assert.match(source, /variant_type: row\.variantType \|\| ""/);
});

test("AI variant manual source import clears stale generation results", () => {
  const confirmImport = source.match(/async function confirmImport\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(confirmImport, /const hydrated = \(await Promise\.all\(selected\.map\(hydrateImportProduct\)\)\)/);
  assert.match(confirmImport, /selectedResultIds\.value = \[\];\s+results\.value = \[\];/);
});

test("AI variant queue replaces stale targets from the current source batch", () => {
  const createVariantQueue = source.match(/function createVariantQueue\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(createVariantQueue, /row\.variantType === variantPlan\.type/);
  assert.match(createVariantQueue, /row\.sourceBatchId === currentSourceBatchId\.value/);
  assert.match(createVariantQueue, /sourceIds\.has\(row\.sourceProductId \|\| row\.product\?\.sourceProductId \|\| row\.product\?\.id\)/);
  assert.doesNotMatch(createVariantQueue, /targetLabels\.has\(row\.variantTarget\)/);
});

test("AI variant result deletion removes only the generated row", () => {
  const removeWorkRow = source.match(/function removeWorkRow\(workRow\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(removeWorkRow, /if \(resultId\) \{[\s\S]*result\.status = "deleted"[\s\S]*\} else if \(productId\) \{/);
  assert.doesNotMatch(removeWorkRow, /if \(resultId\) \{[\s\S]*\}\s+if \(productId\) \{/);
});

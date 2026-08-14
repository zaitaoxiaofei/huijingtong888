import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serviceSource = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("product merge chooses one complete bundle relationship without adding quantities", () => {
  const compositionMergeSource = serviceSource.split("async function remapProductCompositionReferencesAfterMergeMysql")[1]
    .split("const [recipeRows]")[0];
  assert.match(compositionMergeSource, /WHERE product_id IN \(\$\{placeholders\}\) OR component_product_id IN \(\$\{placeholders\}\)/);
  assert.match(compositionMergeSource, /selectedCompositionSourceId/);
  assert.match(compositionMergeSource, /Number\(row\.product_id\) !== selectedCompositionSourceId/);
  assert.match(compositionMergeSource, /const key = `\$\{parentId\}:\$\{componentId\}`/);
  assert.doesNotMatch(compositionMergeSource, /current\.quantity \+= Number\(row\.quantity \|\| 0\)/);
  assert.match(compositionMergeSource, /INSERT INTO product_components \(product_id, component_product_id, quantity, component_role\)/);
});

test("product merge remaps SKU recipes and aggregates duplicate quantities", () => {
  assert.match(serviceSource, /FROM sku_inventory_recipe_items[\s\S]*WHERE product_id IN \(\$\{placeholders\}\)[\s\S]*FOR UPDATE/);
  assert.match(serviceSource, /const key = `\$\{Number\(row\.recipe_id\)\}:\$\{productId\}`/);
  assert.match(serviceSource, /INSERT INTO sku_inventory_recipe_items \(recipe_id, product_id, quantity\)/);
});

test("product merge blocks self-referencing bundles and resyncs unfinished order deductions", () => {
  assert.match(serviceSource, /if \(parentId === componentId\)/);
  assert.match(serviceSource, /库存合并后会导致套餐引用自身/);
  assert.match(serviceSource, /await remapProductCompositionReferencesAfterMergeMysql\(connection, targetProductId, sourceProductIds, compositionSourceProductId\)/);
  assert.match(serviceSource, /await syncOutboundForOpenOrdersMysql\(\{ product_id: targetProductId, open_only: true \}\)/);
});

test("product merge remaps FBP replenishment and transfer references", () => {
  assert.match(serviceSource, /key: "fbp_replenishment_order_items"[\s\S]*table: "fbp_replenishment_order_items"/);
  assert.match(serviceSource, /key: "fbp_transfer_records"[\s\S]*table: "fbp_transfer_records"/);
  assert.match(serviceSource, /UPDATE fbp_replenishment_order_items SET product_id = \?, updated_at = CURRENT_TIMESTAMP WHERE product_id IN/);
  assert.match(serviceSource, /UPDATE fbp_transfer_records SET product_id = \? WHERE product_id IN/);
});

test("product merge preview never returns or renders full base64 image fields", () => {
  assert.match(serviceSource, /if \(field\.type === "image"\) return String\(raw \|\| ""\)\.trim\(\) \? "已设置图片" : "未设置"/);
  assert.match(serviceSource, /field\.type === "image"[\s\S]*withProductImageEndpointMysql\([\s\S]*thumbnail: true/);
});

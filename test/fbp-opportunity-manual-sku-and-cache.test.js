import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../frontend/admin/views/inventory/InventoryFbpOpportunitiesPage.vue", import.meta.url), "utf8");

test("FBP status changes always invalidate recommendation cache", () => {
  const block = service.slice(
    service.indexOf("export async function updateFbpReplenishmentOrderStatusMysql"),
    service.indexOf("const FBP_TRANSFER_STATUSES")
  );
  assert.match(block, /invalidateFbpPlanningCachesMysql\(\);/);
  assert.doesNotMatch(block, /if \(approvalResult\.outboundQuantity > 0\) invalidateFbpPlanningCachesMysql/);
});

test("manual SKU lookup bypasses recommendation score while requiring an exact SKU", () => {
  assert.match(service, /const manualSku = String\(query\.manualSku \|\| query\.manual_sku/);
  assert.match(service, /String\(row\.ozon_sku \|\| ""\)\.trim\(\)\.toLowerCase\(\) === manualSku/);
  assert.match(page, />\s*手工添加 SKU\s*</);
  assert.match(page, /manualSku: sku/);
  assert.match(page, /该 SKU 属于多个店铺，请先在页面上选择店铺后再添加/);
  assert.match(page, /openReplenishmentCreateDialog\(\[\{ \.\.\.row, suggested_qty:/);
});

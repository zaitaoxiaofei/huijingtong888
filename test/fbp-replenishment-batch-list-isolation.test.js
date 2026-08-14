import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("FBP batch summaries keep the active status list isolated from cross-status detail rows", () => {
  assert.match(source, /const pageRows = \[\.\.\.new Map\(rawPageRows\.map\(\(row\) => \[Number\(row\.id\), row\]\)\)\.values\(\)\];/);
  assert.match(source, /state\.rows = pageRows;/);
  assert.doesNotMatch(source, /state\.rows = \[\.\.\.pageRows\.filter[\s\S]*fullBatchOrders/);
  assert.match(source, /batchId: String\(row\.batch_id\), status: "all"/);
});

test("FBP batch detail filtering is applied inside the replenishment list query", () => {
  const listStart = serviceSource.indexOf("export async function fbpReplenishmentOrdersMysql");
  const listEnd = serviceSource.indexOf("export async function createFbpReplenishmentOrdersMysql", listStart);
  const listSource = serviceSource.slice(listStart, listEnd);
  assert.match(listSource, /const batchId = Number\(query\.batchId \|\| query\.batch_id \|\| 0\)/);
  assert.match(listSource, /filter_bm\.order_id = o\.id AND filter_bm\.batch_id = \?/);

  const adjustmentStart = serviceSource.indexOf("export async function addFbpReplenishmentItemAdjustmentMysql");
  const adjustmentEnd = serviceSource.indexOf("export async function mergeFbpReplenishmentOrdersMysql", adjustmentStart);
  assert.doesNotMatch(serviceSource.slice(adjustmentStart, adjustmentEnd), /filter_bm|where\.push\(/);
});

test("FBP linked summaries and source-order details both retain barcode printing", () => {
  assert.doesNotMatch(source, /row\.order\._isBatchSummary[^\n]*请在关联明细中操作/);
  assert.match(source, /batch-detail-table[\s\S]*previewBarcodeLabel\(row\)/);
  assert.match(source, /batch-detail-table[\s\S]*printBarcodeLabel\(row\)/);
  assert.match(source, /Number\.isInteger\(itemId\)/);
});

test("FBP linked summaries display audited final quantities instead of editable requested quantities", () => {
  assert.match(source, /function canEditQuantities\(row\) \{\s+if \(row\?\._isBatchSummary\) return false;/);
  assert.match(source, /<b>最终 \{\{ integer\(row\.final_qty\) \}\}<\/b>/);
});

test("FBP linked summaries use the same order-card structure as standalone orders", () => {
  assert.doesNotMatch(source, /class="batch-banner is-summary"/);
  assert.match(source, /关联 \{\{ row\.order\._sourceOrders\.length \}\} 张原单/);
  assert.match(source, /row\.order\._isBatchSummary \? row\.order\.status_summary : statusTagText/);
});

test("FBP association details reuse the replenishment table visual structure", () => {
  assert.match(source, /:data="batchDetailRows" :span-method="tableSpanMethod" border class="erp-data-table replenishment-table batch-detail-table"/);
  assert.match(source, /batch-detail-list[\s\S]*class="shop-banner"/);
  assert.doesNotMatch(source, /class="batch-source-card"/);
});

test("FBP batch imports show simple SKU quantities and support confirmed repeat imports", () => {
  assert.match(source, /该关联单已经导入过 Ozon。是否按当前最终数量再次整批导入/);
  assert.match(source, /requested\.map\(\(item\) => `\$\{item\.sku\}：\$\{item\.quantity\}`\)/);
  assert.doesNotMatch(source, /最终 \$\{integer\(item\.final_qty\)\} - 已填/);
  assert.match(source, /repeat_import: alreadyImported/);
  assert.match(serviceSource, /success && !repeatImport \? Math\.min\(requestedQty/);
});

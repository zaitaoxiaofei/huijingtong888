import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageUrl = new URL("../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue", import.meta.url);
const serviceUrl = new URL("../src/services/mysql-cutover.js", import.meta.url);

test("FBP barcode print confirms quantity, calls Windows print, and records only after result confirmation", async () => {
  const [pageSource, serviceSource] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(serviceUrl, "utf8")
  ]);

  assert.match(pageSource, /async function markBarcodePrinted\(row, quantity\)/);
  assert.match(pageSource, /items\/barcode-printed/);
  assert.match(pageSource, /remainingLabels\(row\)/);
  assert.match(pageSource, /最终备货数量 \+ 2/);
  assert.match(pageSource, /title="确认打印条码"/);
  assert.match(pageSource, /确认后将打开条码预览页/);
  assert.match(pageSource, /preview\.show\(response\.blob, \(\) => \{\}\);[\s\S]*barcodePrintResultDialog\.row = row/);
  assert.ok(pageSource.indexOf("preview = openBarcodePrintWindow()") < pageSource.indexOf('apiClient.blobResponse("/api/products/barcode-label"'));
  assert.match(pageSource, /title="打印结果确认"/);
  assert.match(pageSource, /async function confirmBarcodePrintCompleted\(\)[\s\S]*recordBarcodePrinted\(row, barcodePrintResultDialog\.quantity\)/);
  assert.match(pageSource, /打印失败，重新打印/);
  assert.doesNotMatch(pageSource, /条码 PDF 预览|previewBarcodeLabel|directPrintBarcodePreview/);
  assert.match(pageSource, /row\.barcode_printed_at = payload\?\.barcode_printed_at/);
  assert.match(pageSource, /已确认 \$\{integer\(row\.barcode_printed_qty\)\}/);
  assert.match(serviceSource, /appendPrintRecord\(connection, body, userId\)/);
  assert.match(pageSource, /request_key: barcodePrintResultDialog.request_key/);
});

test("operations batch aggregates latest print time and exposes source-item history", async () => {
  const source = await readFile(pageUrl, "utf8");
  const body = source.slice(source.indexOf("function aggregateBatchOrder("), source.indexOf("const displayOrders"));
  const aggregate = new Function("statusTagText", `${body}; return aggregateBatchOrder;`)(status => status);
  const result = aggregate([
    { id: 1, batch_id: 1, items: [{ id: 11, ozon_sku: "SKU", barcode_printed_qty: 2, barcode_printed_at: "2026-09-24T01:00:00Z" }] },
    { id: 2, batch_id: 1, items: [{ id: 12, ozon_sku: "SKU", barcode_printed_qty: 3, barcode_printed_at: "2026-09-25T02:00:00Z" }] }
  ]);
  assert.equal(result.items[0].barcode_printed_qty, 5);
  assert.equal(result.items[0].barcode_printed_at, "2026-09-25T02:00:00Z");
  const historyBody = source.slice(source.indexOf("async function showPrintHistory("), source.indexOf("function openGroupPrint("));
  const state = {};
  const calls = [];
  const show = new Function("printHistory", "apiClient", "ElMessage", `${historyBody}; return showPrintHistory;`)(state, {
    get: async url => { calls.push(url); return { print_records: [{ id: Number(url.split("=")[1]), quantity: 2 }] }; }
  }, { error: message => { throw Error(message); } });
  await show(result.items[0]);
  assert.deepEqual(calls.sort(), ["/api/fbp-replenishment-orders?print_item_id=11", "/api/fbp-replenishment-orders?print_item_id=12"]);
  assert.deepEqual(state.rows.map(row => row.id), [12, 11]);
  assert.equal(state.loading, false);
  assert.doesNotMatch(source, /v-if="!row\._sourceItems\?\.length && Number\(row\.barcode_printed_qty\)"/);
});

test("FBP quantity save makes the latest requested quantity authoritative for approval", async () => {
  const [pageSource, serviceSource] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(serviceUrl, "utf8")
  ]);

  assert.match(pageSource, /items: \(row\.items \|\| \[\]\)\.map\(\(item\) => \(\{\s+id: item\.id,\s+requested_qty: item\.requested_qty\s+\}\)\)/);
  assert.doesNotMatch(pageSource, /requested_qty: item\.requested_qty,\s+approved_qty: item\.approved_qty/);
  assert.match(serviceSource, /SET requested_qty = \?, approved_qty = \?, updated_at = CURRENT_TIMESTAMP[\s\S]{0,160}\[requestedQty, requestedQty, itemId, orderId\]/);
  assert.match(serviceSource, /const quantity = Math\.max\(0, Math\.round\(Number\(item\.approved_qty \|\| 0\)\)\)/);
});

test("FBP replenishment history displays the current inventory product name and preserves its image snapshot", async () => {
  const serviceSource = await readFile(serviceUrl, "utf8");

  assert.match(serviceSource, /LEFT JOIN products current_product ON current_product\.id = i\.product_id/);
  assert.match(serviceSource, /COALESCE\(NULLIF\(current_product\.name, ''\), i\.product_name\) AS product_name/);
  assert.match(serviceSource, /COALESCE\(NULLIF\(i\.image_url, ''\), current_product\.image_url\) AS image_url/);
  assert.match(serviceSource, /current_product\.name LIKE \?/);
});

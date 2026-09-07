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
  assert.match(pageSource, /final_qty \?\? row\?\.approved_qty \?\? row\?\.requested_qty \?\? 0/);
  assert.doesNotMatch(pageSource, /最终备货数量 \+ 2/);
  assert.match(pageSource, /最新保存的最终备货数量/);
  assert.match(pageSource, /title="确认打印条码"/);
  assert.match(pageSource, /确认后将生成 PDF，并打开 Windows 系统打印窗口/);
  assert.match(pageSource, /target\.print\(\);\s+barcodePrintResultDialog\.row = row/);
  assert.match(pageSource, /title="打印结果确认"/);
  assert.match(pageSource, /async function confirmBarcodePrintCompleted\(\)[\s\S]*recordBarcodePrinted\(row, barcodePrintResultDialog\.quantity\)/);
  assert.match(pageSource, /打印失败，重新打印/);
  assert.doesNotMatch(pageSource, /条码 PDF 预览|previewBarcodeLabel|directPrintBarcodePreview/);
  assert.match(pageSource, /row\.barcode_printed_at = payload\?\.barcode_printed_at/);
  assert.match(pageSource, /已打印 \$\{integer\(row\.barcode_printed_qty\)\} 张 · \$\{dateText\(row\.barcode_printed_at\)\}/);
  assert.match(serviceSource, /barcode_printed_at: printed\?\.barcode_printed_at/);
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

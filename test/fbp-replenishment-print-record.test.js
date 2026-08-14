import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pageUrl = new URL("../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue", import.meta.url);
const serviceUrl = new URL("../src/services/mysql-cutover.js", import.meta.url);

test("FBP barcode print actions persist and display the print record", async () => {
  const [pageSource, serviceSource] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(serviceUrl, "utf8")
  ]);

  assert.match(pageSource, /async function markBarcodePrinted\(row, quantity\)/);
  assert.match(pageSource, /items\/barcode-printed/);
  assert.match(pageSource, /target\.print\(\);\s+await recordBarcodePrinted/);
  assert.match(pageSource, /source: "fbp-replenishment-barcode-preview"[\s\S]{0,200}await recordBarcodePrinted/);
  assert.match(pageSource, /row\.barcode_printed_at = payload\?\.barcode_printed_at/);
  assert.match(serviceSource, /barcode_printed_at: printed\?\.barcode_printed_at/);
});

test("FBP replenishment history displays the current inventory product name and preserves its image snapshot", async () => {
  const serviceSource = await readFile(serviceUrl, "utf8");

  assert.match(serviceSource, /LEFT JOIN products current_product ON current_product\.id = i\.product_id/);
  assert.match(serviceSource, /COALESCE\(NULLIF\(current_product\.name, ''\), i\.product_name\) AS product_name/);
  assert.match(serviceSource, /COALESCE\(NULLIF\(i\.image_url, ''\), current_product\.image_url\) AS image_url/);
  assert.match(serviceSource, /current_product\.name LIKE \?/);
});

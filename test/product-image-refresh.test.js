import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const server = source("../src/server.js");
const mysqlServices = source("../src/services/mysql-cutover.js");
const runtimeServices = source("../src/services/mysql-runtime-services.js");
const purchaseList = source("../frontend/admin/views/procurement/PurchaseListView.vue");
const purchaseHistory = source("../frontend/admin/views/procurement/PurchaseHistoryView.vue");

test("procurement images use the product-aware image endpoint", () => {
  for (const page of [purchaseList, purchaseHistory]) {
    assert.match(page, /`\/api\/products\/\$\{productId\}\/image\?thumb=1&w=180`/);
  }
  assert.match(purchaseList, /`\/api\/products\/\$\{productId\}\/image`/);
  assert.match(purchaseList, /:preview-list="productPreviewImage\(row\) \? \[productPreviewImage\(row\)\] : \[\]"/);
});

test("product image endpoint refreshes failed remote Ozon URLs without media archival", () => {
  assert.match(server, /services\.refreshProductImageUrl\(productId\)/);
  assert.match(mysqlServices, /fetchOzonProductsByIds\(binding, \[ozonProductId\]\)/);
  assert.match(mysqlServices, /UPDATE products SET image_url = \?/);
  assert.doesNotMatch(mysqlServices.match(/async function refreshProductImageUrlUnsafeMysql[\s\S]*?\n}\n/)?.[0] || "", /prepareOnlineProductMediaForStorage|archiveRemoteMediaObjectUrl/);
  assert.match(runtimeServices, /refreshProductImageUrl: refreshProductImageUrlMysql/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const productsSource = serviceSource.match(/export async function productsMysql[\s\S]*?export async function hiddenProductsMysql/)?.[0] || "";

test("inventory search runs count and page lookup concurrently", () => {
  assert.match(productsSource, /const \[totalRow, pageRows\] = await Promise\.all\(\[/);
  assert.match(productsSource, /SELECT COUNT\(\*\) AS total/);
  assert.match(productsSource, /SELECT p\.id/);
});

test("inventory list restores a bounded fresh search snapshot", () => {
  assert.match(viewSource, /const INVENTORY_LIST_CACHE_TTL_MS = 30 \* 1000/);
  assert.match(viewSource, /const INVENTORY_LIST_CACHE_MAX_ENTRIES = 30/);
  assert.match(viewSource, /if \(hasFreshCache\) \{/);
  assert.match(viewSource, /cacheInventoryList\(requestUrl, products\)/);
});

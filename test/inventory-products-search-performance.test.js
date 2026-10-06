import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const productsSource = serviceSource.match(/export async function productsMysql[\s\S]*?export async function hiddenProductsMysql/)?.[0] || "";
const compositionSummarySource = serviceSource.match(/async function productCompositionSummariesMysql[\s\S]*?async function assertProductCompositionAcyclicMysql/)?.[0] || "";

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

test("inventory list does not block first paint on auxiliary dictionaries", () => {
  assert.match(viewSource, /function loadInventoryDictionaries\(\)/);
  assert.match(viewSource, /if \(!dictionaryLoaded\) void loadInventoryDictionaries\(\);/);
  assert.match(viewSource, /const products = await apiClient\.get\(requestUrl\);/);
});

test("inventory list staggers thumbnail work instead of starting every image request together", () => {
  assert.match(viewSource, /:load-delay="Math\.min\(\$index, 12\) \* 120"/);
});

test("component availability only aggregates movement rows for the current page", () => {
  assert.match(compositionSummarySource, /const componentIds = \[\.\.\.new Set\(components\.map/);
  assert.match(compositionSummarySource, /AND product_id IN/);
  assert.match(compositionSummarySource, /componentPlaceholders/);
});

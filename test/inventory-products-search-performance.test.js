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

test("inventory list does not block first paint on auxiliary dictionaries", () => {
  assert.match(viewSource, /function loadInventoryDictionaries\(\)/);
  assert.match(viewSource, /if \(!dictionaryLoaded\) void loadInventoryDictionaries\(\);/);
  assert.match(viewSource, /const products = await apiClient\.get\(requestUrl\);/);
});

test("inventory list staggers thumbnail work instead of starting every image request together", () => {
  assert.match(viewSource, /:load-delay="Math\.min\(\$index, 12\) \* 120"/);
});

test("inventory list loads a small product thumbnail but previews the original", () => {
  const start = viewSource.indexOf("function inventoryProductImageUrl(");
  const end = viewSource.indexOf("function detailImage(", start);
  assert.ok(start > 0 && end > start);
  const imageUrl = new Function(`${viewSource.slice(start, end)}; return inventoryProductImageUrl;`)();
  const row = { id: 880, image_url: "https://example.test/full.jpg", updated_at: "2026-10-09 12:00:00" };
  assert.equal(imageUrl(row, true), "/api/products/880/image?thumb=1&w=180&v=2026-10-09+12%3A00%3A00");
  assert.equal(imageUrl(row), "/api/products/880/image?v=2026-10-09+12%3A00%3A00");
  assert.equal(imageUrl({ ...row, image_url: "" }, true), "");
  assert.match(viewSource, /<ProductImagePreview :src="inventoryProductImageUrl\(row, true\)" :preview-list="\[inventoryProductImageUrl\(row\)\]"/);
});

test("inventory first mount does not issue a second activation fetch", () => {
  assert.match(viewSource, /let firstActivation = true;/);
  assert.match(viewSource, /onActivated\(\(\) => \{\s*if \(firstActivation\) \{\s*firstActivation = false;\s*return;\s*\}/);
});

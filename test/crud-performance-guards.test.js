import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const ordersSource = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

test("product composition validation and inserts are batched", () => {
  const saveSource = serviceSource.match(/async function saveProductComponentsTxMysql[\s\S]*?function selectionSummaryMysql/)?.[0] || "";
  assert.match(saveSource, /SELECT id FROM products WHERE id IN/);
  assert.match(saveSource, /SELECT product_id FROM product_components WHERE product_id IN/);
  assert.match(saveSource, /normalized\.map\(\(\) => "\(\?, \?, \?, \?\)"\)/);
  assert.doesNotMatch(saveSource, /for \(const item of normalized\)/);
});

test("mapping follow-up work runs concurrently", () => {
  const updateSource = serviceSource.match(/export async function updateSkuMappingMysql[\s\S]*?export async function deleteSkuMappingMysql/)?.[0] || "";
  assert.match(updateSource, /const \[outboundSync, profitSync\] = await Promise\.all/);
});

test("orders reuse a bounded fresh list snapshot", () => {
  assert.match(ordersSource, /const ORDERS_LIST_CACHE_TTL_MS = 30 \* 1000/);
  assert.match(ordersSource, /const ORDERS_LIST_CACHE_MAX_ENTRIES = 30/);
  assert.match(ordersSource, /if \(hasFreshCache\) \{/);
  assert.match(ordersSource, /cacheOrdersList\(requestUrl, result\)/);
});

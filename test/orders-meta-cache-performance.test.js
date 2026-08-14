import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");
const mysqlSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("order status metadata is reused across pagination changes", () => {
  assert.match(source, /const ORDERS_META_CACHE_TTL_MS = 60 \* 1000/);
  const keySource = source.match(/function ordersMetaCacheKey[\s\S]*?\n}/)?.[0] || "";
  assert.match(keySource, /shopId/);
  assert.match(keySource, /dateFrom/);
  assert.match(keySource, /dateTo/);
  assert.match(keySource, /logisticsMethod/);
  assert.doesNotMatch(keySource, /pageSize|page:/);
  assert.match(source, /const cachedCounts = readOrdersMetaCache\(filtersSnapshot\)/);
  assert.match(source, /if \(options\.includeCounts\) writeOrdersMetaCache\(filtersSnapshot, counts\)/);
});

test("completed order sync bypasses cached rows and status metadata", () => {
  assert.match(source, /loadOrders\(\{ includeCounts: true, forceRefresh: true \}\)/);
});

test("latest order sync timestamp includes posting detail status refreshes", () => {
  const handler = mysqlSource.match(/export async function latestOrderSyncStatusMysql[\s\S]*?\n}/)?.[0] || "";
  assert.match(handler, /'ozon_posting_details'/);
});

test("order status counts are queried live instead of using the master-data cache", () => {
  const handler = mysqlSource.match(/async function orderPagedSqlCountsMysql[\s\S]*?\n}/)?.[0] || "";
  assert.match(handler, /SELECT[\s\S]*COUNT\(\*\) AS all_count/);
  assert.doesNotMatch(handler, /getCachedMasterData|orders:counts/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { refreshInventoryAlertSkuDailyMysqlService } from "../src/services/mysql-inventory-alert-snapshots.js";

test("inventory alert SKU snapshot refresh preserves date range, upsert, and cache invalidation", async () => {
  const writes = [];
  const invalidated = [];
  const result = await refreshInventoryAlertSkuDailyMysqlService({
    normalizeDate: (value) => String(value || "").trim(),
    todayDateKey: () => "2026-07-29",
    orderedAtUtcRange: () => ({ whereSql: "AND o.ordered_at >= ? AND o.ordered_at < ?", params: ["from-utc", "to-utc"] }),
    chinaDateSql: (column) => `DATE(${column})`,
    execute: async (sql, params) => writes.push({ sql, params }),
    invalidateCache: (key) => invalidated.push(key),
    queryOne: async () => ({ count: 12 })
  }, { from: "2026-07-01", to: "2026-07-29" });

  assert.equal(writes.length, 2);
  assert.match(writes[1].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(writes[1].params, ["from-utc", "to-utc"]);
  assert.deepEqual(invalidated, ["stock-alerts:base:v2"]);
  assert.deepEqual(result, { from: "2026-07-01", to: "2026-07-29", rows: 12 });
});

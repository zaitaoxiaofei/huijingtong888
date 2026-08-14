import assert from "node:assert/strict";
import test from "node:test";

import {
  orderProfitDetailSnapshotMysqlService,
  refreshOrderProfitDetailSnapshotsMysqlService
} from "../src/services/mysql-order-profit-detail-snapshots.js";

test("mysql profit detail snapshot reader parses persisted JSON fields", async () => {
  const row = await orderProfitDetailSnapshotMysqlService({
    queryOne: async () => ({
      order_id: 7,
      actual_profit_ready: 1,
      summary_json: "{\"profit\":12}",
      detail_rows_json: "[{\"key\":\"profit\"}]",
      finance_totals_json: "{\"commission\":3}"
    }),
    parseJson: (value, fallback) => {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    }
  }, 7);

  assert.equal(row.actual_profit_ready, true);
  assert.deepEqual(row.summary, { profit: 12 });
  assert.deepEqual(row.rows, [{ key: "profit" }]);
  assert.deepEqual(row.finance_totals, { commission: 3 });
});

test("mysql profit detail snapshot refresh keeps MySQL upsert and result contract", async () => {
  const writes = [];
  const result = await refreshOrderProfitDetailSnapshotsMysqlService({
    normalizeDate: (value) => String(value || "").trim(),
    chinaDateSql: (column) => `DATE(${column})`,
    query: async (sql, params) => {
      assert.match(sql, /DATE\(o\.ordered_at\) >= \?/);
      assert.deepEqual(params, ["2026-07-01", "2026-07-29", 50]);
      return [{ id: 9 }];
    },
    orderDetail: async () => ({
      order: { id: 9, updated_at: "2026-07-29 10:00:00" },
      items: [],
      finance: []
    }),
    buildPayload: () => ({
      order_id: 9,
      shop_id: 2,
      posting_number: "P-9",
      order_status: "delivered",
      outcome_type: "delivered",
      sale_amount_cny: 100,
      estimated_profit_cny: 20,
      estimated_cost_total_cny: 80,
      actual_profit_cny: 18,
      actual_profit_rate: 18,
      actual_cost_total_cny: 82,
      finance_match_status: "settled",
      finance_rows: 1,
      actual_profit_ready: 1,
      summary: { profit: 18 },
      detailRows: [],
      financeTotals: {}
    }),
    execute: async (sql, params) => writes.push({ sql, params }),
    normalizeDateTime: (value) => value
  }, { from: "2026-07-01", to: "2026-07-29", limit: 50 });

  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(result, {
    ok: true,
    matched: 1,
    refreshed: 1,
    from: "2026-07-01",
    to: "2026-07-29",
    final_only: true,
    db: "mysql"
  });
});

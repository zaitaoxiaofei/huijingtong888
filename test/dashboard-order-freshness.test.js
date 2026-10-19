import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

function loadFunction(name, nextName, dependencies) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`\nasync function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`(${source.slice(start, end)})`, dependencies);
}

test("dashboard detects a new order even when daily analytics did not refresh", async () => {
  const orderRows = [
    { order_count: 153, effective_orders: 144, cancelled_orders: 9, order_max_id: 100 },
    { order_count: 154, effective_orders: 145, cancelled_orders: 9, order_max_id: 101 },
    { order_count: 153, effective_orders: 144, cancelled_orders: 9, order_max_id: 101 }
  ];
  const ranges = [];
  const isStale = loadFunction("dashboardSnapshotIsStaleMysql", "saveDashboardSnapshotMysql", {
    todayDateKeyMysql: () => "2026-10-19",
    profitOrderedAtUtcRangeMysql: (_alias, from, to) => {
      ranges.push([from, to]);
      return { whereSql: "AND o.ordered_at >= ? AND o.ordered_at < ?", params: [from, to] };
    },
    buildOrderOutcomeSql: () => ({
      effectiveSale: "o.status != 'cancelled'",
      afterDeliveryReturn: "o.status = 'returned'",
      cancelledPreFulfillment: "o.status = 'cancelled'"
    }),
    mysqlQueryOne: async (sql) => sql.includes("analytics_shop_daily")
      ? { refreshed_at: "2026-10-19T10:12:29Z" }
      : orderRows.shift()
  });
  const snapshot = {
    snapshot: { source_updated_at: "2026-10-19T10:15:43Z", order_max_id: 100 },
    commerce: { today: { order_count: 153, effective_orders: 144, cancelled_orders: 9 } }
  };

  assert.equal(await isStale(snapshot, "2026-10-19"), false);
  assert.equal(await isStale(snapshot, "2026-10-19"), true);
  assert.equal(await isStale(snapshot, "2026-10-19"), true);
  assert.deepEqual(ranges, Array(3).fill(["2026-10-19", "2026-10-19"]));
});

test("an order header without items does not keep the dashboard rebuilding", async () => {
  const isStale = loadFunction("dashboardSnapshotIsStaleMysql", "saveDashboardSnapshotMysql", {
    todayDateKeyMysql: () => "2026-10-19",
    profitOrderedAtUtcRangeMysql: () => ({ whereSql: "AND o.ordered_at >= ?", params: [] }),
    buildOrderOutcomeSql: () => ({ effectiveSale: "1=1", afterDeliveryReturn: "1=0", cancelledPreFulfillment: "1=0" }),
    mysqlQueryOne: async (sql) => {
      if (sql.includes("analytics_shop_daily")) return { refreshed_at: "2026-10-19T10:12:29Z" };
      assert.match(sql, /JOIN order_items oi ON oi\.order_id = o\.id/);
      // Order 101 exists but has no item; the visible order watermark remains 100.
      return { order_count: 153, effective_orders: 144, cancelled_orders: 9, order_max_id: 100 };
    }
  });
  const snapshot = {
    snapshot: { source_updated_at: "2026-10-19T10:15:43Z", order_max_id: 100 },
    commerce: { today: { order_count: 153, effective_orders: 144, cancelled_orders: 9 } }
  };

  assert.equal(await isStale(snapshot, "2026-10-19"), false);
});

test("dashboard monthly order totals use the live monthly order scan", async () => {
  let monthlySql = "";
  const monthly = loadFunction("dashboardMonthShippingCostSummaryMysql", "dashboardProfitTrendSummaryMysql", {
    todayDateKeyMysql: () => "2026-10-19",
    profitOrderedAtUtcRangeMysql: () => ({ whereSql: "AND o.ordered_at >= ? AND o.ordered_at < ?", params: [] }),
    buildOrderOutcomeSql: () => ({
      effectiveSale: "o.status != 'cancelled'",
      afterDeliveryReturn: "o.status = 'returned'",
      cancelledPreFulfillment: "o.status = 'cancelled'",
      rejectedUnclaimed: "o.status = 'rejected'"
    }),
    mysqlQuery: async (sql) => {
      monthlySql = sql;
      return [
        { shop_id: 4, shop_name: "A", order_count: 4211, cancelled_orders: 9, cancelled_quantity: 9, return_orders: 2, return_quantity: 2, return_revenue: 20 },
        { shop_id: 5, shop_name: "B", order_count: 0, cancelled_orders: 2, cancelled_quantity: 2 }
      ];
    },
    roundMoneyMysql: Number,
    console
  });
  const result = await monthly("2026-10-19");

  assert.equal(result.order_count, 4211);
  assert.equal(result.cancelled_orders, 11);
  assert.equal(result.return_orders, 2);
  assert.equal(result.order_outcomes_available, true);
  assert.deepEqual(result.shops.map((shop) => shop.shop_id), [4]);
  assert.match(monthlySql, /COUNT\(DISTINCT CASE WHEN .* THEN o\.id END\) AS order_count/);
  assert.doesNotMatch(monthlySql, /WHERE 1=1[^]*AND \(\(o\.status != 'cancelled'\)/);
});

test("dashboard monthly cards replace stale daily analytics order counts", async () => {
  const dateKey = "2026-10-19";
  let watermarkSql = "";
  const build = loadFunction("buildDashboardPayloadMysql", "rebuildDashboardSnapshotMysql", {
    todayDateKeyMysql: () => dateKey,
    profitOrderedAtUtcRangeMysql: () => ({ whereSql: "AND o.ordered_at >= ?", params: [] }),
    mysqlQueryOne: async (sql) => {
      watermarkSql = sql;
      return { order_max_id: 101 };
    },
    dateKeyMysql: (value) => value.toISOString().slice(0, 10),
    addDaysMysql: (value, days) => new Date(value.getTime() + days * 86400000),
    latestDashboardAdDateMysql: async () => "",
    mapWithConcurrencyMysql: async (tasks) => Promise.all(tasks.map((task) => task())),
    stockAlertsMysql: async () => ({ rows: [], meta: {} }),
    procurementRequestsMysql: async () => ({ rows: [], total: 0 }),
    dashboardRecentCommerceMysql: async () => ({ today: { order_count: 154, effective_orders: 145 }, yesterday: {}, shops: [] }),
    dashboardProfitTrendSummaryMysql: async () => ({ month_effective_orders: 4210, month_cancelled_orders: 8 }),
    dashboardAdSummaryMysql: async () => ({}),
    dashboardFbpInventoryValueMysql: async () => ({ value: 0, quantity: 0 }),
    dashboardMonthShippingCostSummaryMysql: async () => ({ order_count: 4211, cancelled_orders: 9, cancelled_quantity: 9, return_orders: 2, return_quantity: 2, return_revenue: 20, order_outcomes_available: true }),
    dashboardAftersalesLossSummaryMysql: async () => ({}),
    scheduledJobSummary: async () => ({}),
    dashboardAiUsageMysql: async () => ({}),
    roundMoneyMysql: Number
  });
  const payload = await build({ dateKey });

  assert.equal(payload.snapshot.order_max_id, 101);
  assert.match(watermarkSql, /JOIN order_items oi ON oi\.order_id = o\.id/);
  assert.equal(payload.commerce.today.effective_orders, 145);
  assert.equal(payload.commerce.profit_trend.month_effective_orders, 4211);
  assert.equal(payload.summary.month_order_outcomes.effective_orders, 4211);
  assert.equal(payload.summary.month_order_outcomes.cancelled_orders, 9);
});

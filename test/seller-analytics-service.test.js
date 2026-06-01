import test from "node:test";
import assert from "node:assert/strict";
import {
  inferSourceFromRequest,
  resolveCollectPeriod,
  saveSnapshot
} from "../src/services/seller-analytics.js";

function createMemorySellerAnalyticsDb() {
  const tables = {
    SellerAnalyticsSnapshot: [],
    SellerAnalyticsProductMetric: []
  };
  const matchesWhere = (row, where = {}) => Object.entries(where || {}).every(([key, expected]) => {
    if (expected && typeof expected === "object" && expected.__sellerAnalyticsOp === "in") {
      return expected.values.includes(row[key]);
    }
    return row[key] === expected;
  });
  return {
    tables,
    getRepository(entityName) {
      return {
        async save(payload) {
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const row of rows) {
            const table = tables[entityName];
            const existingIndex = table.findIndex((item) => item.id === row.id);
            if (existingIndex >= 0) table[existingIndex] = row;
            else table.push(row);
          }
          return payload;
        },
        async find(options = {}) {
          const table = tables[entityName];
          return table.filter((row) => matchesWhere(row, options.where || {}));
        },
        async delete(where = {}) {
          const table = tables[entityName];
          const before = table.length;
          tables[entityName] = table.filter((row) => !matchesWhere(row, where));
          return { affected: before - tables[entityName].length };
        }
      };
    }
  };
}

test("seller analytics 7d period uses yesterday as the end date", () => {
  const period = resolveCollectPeriod({ period_key: "7d" }, new Date("2026-06-01T10:00:00Z"));

  assert.deepEqual(period.current_period, { date_from: "2026-05-25", date_to: "2026-05-31" });
  assert.deepEqual(period.previous_period, { date_from: "2026-05-18", date_to: "2026-05-24" });
});

test("seller analytics infers all_metrics from official request metrics", () => {
  const source = inferSourceFromRequest({
    request_body: {
      metrics: ["revenue", "delivered_units", "conv_hits_to_cart_to_order"]
    }
  });

  assert.equal(source.key, "all_metrics");
  assert.equal(source.label, "所有指标");
});

test("seller analytics replaces older plugin snapshot for the same collected page", async () => {
  const db = createMemorySellerAnalyticsDb();
  const payload = {
    source: "pivot-table-master-controlled",
    source_button_key: "hot",
    source_context: {
      endpoint_type: "by_sku",
      page_index: 0
    },
    request_url: "https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/by_sku",
    request_method: "POST",
    request_headers: { "X-O3-Company-Id": "123456" },
    request_body: {
      current_period: { date_from: "2026-05-25", date_to: "2026-05-31" },
      metrics: ["revenue", "ordered_units"],
      limit: "100",
      offset: "0"
    },
    period_key: "7d"
  };

  await saveSnapshot(db, {
    ...payload,
    captured_at: "2026-06-01T10:00:00.000Z",
    response_body: {
      items: [{ sku: "old-sku", product_name: "Old", revenue: 10, ordered_units: 1 }]
    }
  }, "admin");
  await saveSnapshot(db, {
    ...payload,
    captured_at: "2026-06-01T10:05:00.000Z",
    response_body: {
      items: [{ sku: "new-sku", product_name: "New", revenue: 20, ordered_units: 2 }]
    }
  }, "admin");

  assert.equal(db.tables.SellerAnalyticsSnapshot.length, 1);
  assert.equal(db.tables.SellerAnalyticsProductMetric.length, 1);
  assert.match(db.tables.SellerAnalyticsSnapshot[0].response_body, /new-sku/);
  assert.equal(db.tables.SellerAnalyticsProductMetric[0].sku, "new-sku");
});

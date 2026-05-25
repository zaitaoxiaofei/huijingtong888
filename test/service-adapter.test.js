import assert from "node:assert/strict";
import test from "node:test";

import { refreshProfitAnalyticsSnapshots } from "../src/services/analytics-refresh.js";
import { syncOzonFinance } from "../src/services/finance-sync.js";
import { syncDemoOrders, syncOzonIncrementalOrders } from "../src/services/order-sync.js";
import { syncOutboundForOpenOrders } from "../src/services/profit-maintenance.js";

test("analytics refresh uses adapter execute/queryOne path", () => {
  const executed = [];
  const deps = {
    buildOrderOutcomeSql: () => ({
      effectiveSale: "1=1",
      cancelledPreFulfillment: "1=0",
      rejectedUnclaimed: "1=0",
      afterDeliveryReturn: "1=0"
    }),
    chinaDateSql: (expr) => `substr(${expr}, 1, 10)`,
    execute: (sql, params) => {
      executed.push({ sql, params });
      return { changes: 1 };
    },
    queryOne: (sql, params) => {
      executed.push({ sql, params, queryOne: true });
      return { count: 0 };
    }
  };

  const result = refreshProfitAnalyticsSnapshots(deps, {
    from: "2026-05-01",
    to: "2026-05-31"
  });

  assert.equal(result.ok, true);
  assert.equal(result.shop_rows, 0);
  assert.equal(result.product_rows, 0);
  assert.equal(result.sku_rows, 0);
  assert.ok(executed.some((entry) => entry.sql.includes("DELETE FROM analytics_shop_daily")));
  assert.ok(executed.some((entry) => entry.sql.includes("INSERT INTO analytics_shop_daily")));
  assert.ok(executed.some((entry) => entry.queryOne && entry.sql.includes("SELECT COUNT(*) AS count FROM analytics_shop_daily")));
});

test("finance sync writes through adapter execute path", async () => {
  const executed = [];
  const deps = {
    nullable: (value) => (value === "" || value == null ? null : Number(value)),
    shops: () => [{ id: 1, name: "Shop A", status: "active" }],
    dateKeyDaysAgo: () => "2026-05-01",
    todayDateKey: () => "2026-05-31",
    fetchOzonFinanceTransactions: async () => ({
      fetched: 1,
      operations: [{
        operation_id: "op-1",
        posting_number: "P-1",
        order_number: "O-1",
        operation_type: "orders",
        operation_type_name: "orders",
        operation_date: "2026-05-10T10:00:00Z",
        sale_commission: -12,
        delivery_charge: -8,
        return_delivery_charge: 0,
        accruals_for_sale: 100,
        currency_code: "RUB",
        raw_json: "{}",
        services: []
      }]
    }),
    execute: (sql, params) => {
      executed.push({ sql, params });
      return { changes: 1 };
    },
    all: (sql) => {
      if (sql.includes("FROM orders o")) return [];
      return [];
    },
    exchangeRateForDate: () => ({ rate: 11 }),
    currentExchangeRate: () => ({ rate: 11 }),
    rubToCny: (amount, rate) => Number(amount || 0) / Number(rate || 1),
    classifyOrderOutcome: () => "effective_sale",
    resolveOrderLossProfile: () => ({ code: "none" }),
    describeCancellation: () => ({}),
    ozonFinanceCategory: () => "other",
    roundMoney: (value) => Math.round(Number(value || 0) * 100) / 100,
    packagingFeeForSaleAmount: () => 0,
    estimateOutcomeReturnLoss: () => 0,
    lockProfitItem: () => {},
    refreshProfitAnalyticsSnapshots: () => {}
  };

  const result = await syncOzonFinance(deps, {}, {});

  assert.equal(result.fetched, 1);
  assert.equal(result.upserted, 2);
  assert.equal(result.applied.items, 0);
  assert.ok(executed.some((entry) => entry.sql.includes("INSERT INTO ozon_finance_items")));
  assert.ok(executed.some((entry) => entry.sql.includes("INSERT INTO sync_logs")));
});

test("order sync writes through adapter execute and insert-id helpers", async () => {
  const executed = [];
  let nextId = 100;
  const deps = {
    nullable: (value) => (value === "" || value == null ? null : Number(value)),
    shops: () => [{ id: 1, name: "Shop A", status: "active" }],
    normalizeSyncDate: (value) => value || "",
    fetchOzonPostings: async () => ({
      requests: 1,
      postings: [{
        posting_number: "POST-1",
        order_number: "ORDER-1",
        status: "awaiting_deliver",
        logistics_status: "",
        tracking_stage: "",
        ordered_at: "2026-05-10T10:00:00Z",
        delivered_at: null,
        buyer_region: "CN",
        tracking_number: "TN-1",
        external_tracking_url: "",
        cancel_reason_id: null,
        cancel_reason: "",
        cancel_initiator: "",
        cancel_type: "",
        cancelled_after_ship: 0,
        items: [{
          ozon_sku: "SKU-1",
          offer_id: "OFF-1",
          ozon_product_id: "OP-1",
          name: "Test SKU",
          image_url: "https://example.com/a.png",
          sale_price: 100,
          quantity: 2
        }]
      }]
    }),
    execute: (sql, params) => {
      executed.push({ sql, params });
      return { changes: 1 };
    },
    insertAndGetId: (sql, params) => {
      executed.push({ sql, params, insert: true });
      nextId += 1;
      return nextId;
    },
    get: (sql, params) => {
      if (sql.includes("FROM orders WHERE shop_id = ? AND posting_number = ?")) return null;
      if (sql.includes("FROM orders WHERE posting_number = ?")) return null;
      if (sql.includes("FROM online_products WHERE shop_id = ? AND ozon_sku = ?")) return null;
      if (sql.includes("SELECT id FROM order_items WHERE order_id = ? AND ozon_sku = ?")) return null;
      if (sql.includes("FROM sku_mappings sm")) {
        return {
          id: 501,
          product_id: 601,
          person_id: 701,
          online_product_id: 801,
          ozon_sku: "SKU-1",
          offer_id: "OFF-1"
        };
      }
      if (sql.includes("SELECT * FROM products WHERE id = ?")) {
        return {
          id: 601,
          purchase_cost: 20,
          domestic_shipping: 5,
          international_shipping: 6,
          handling_fee: 1
        };
      }
      if (sql.includes("SELECT * FROM orders WHERE id = ?")) return { id: params[0], status: "awaiting_deliver" };
      return null;
    },
    all: (sql) => {
      if (sql.includes("SELECT * FROM order_items WHERE order_id = ?")) return [];
      return [];
    },
    dateKeyDaysAgo: () => "2026-05-01",
    todayDateKey: () => "2026-05-31",
    actualItemProfit: () => 0,
    classifyOrderOutcome: () => "effective_sale",
    describeCancellation: () => ({}),
    estimateItemProfit: () => ({
      freight: 6,
      commission: 10,
      paymentFee: 1,
      withdrawalFee: 1,
      advertisingCost: 0
    }),
    estimateOrderItemReturnLoss: () => 0,
    invalidateExceptionWorkbenchCache: () => {},
    orderQualityPrefixes: () => [],
    packagingFeeForSaleAmount: () => 1,
    postInventory: () => {},
    recordOrderException: () => {},
    refreshProfitAnalyticsSnapshots: () => {},
    resolveOrderLossProfile: () => ({ code: "none" }),
    resolveProfitSettlementStatus: () => "pending",
    roundMoney: (value) => Math.round(Number(value || 0) * 100) / 100,
    saveProfitItem: () => {},
    syncOrderItemProfitFromBreakdown: () => {},
    syncOutboundForOpenOrders: () => {}
  };

  const result = await syncDemoOrders(deps, {
    from: "2026-05-01",
    to: "2026-05-31"
  }, {});

  assert.equal(result.fetched, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.ok(executed.some((entry) => entry.sql.includes("INSERT INTO ozon_orders_raw")));
  assert.ok(executed.some((entry) => entry.insert && entry.sql.includes("INSERT INTO orders")));
  assert.ok(executed.some((entry) => entry.insert && entry.sql.includes("INSERT INTO order_items")));
  assert.ok(executed.some((entry) => entry.sql.includes("INSERT INTO outbound_records")));
  assert.ok(executed.some((entry) => entry.sql.includes("INSERT INTO sync_logs")));
});

test("incremental new order sync starts from latest local order", async () => {
  const fetchedOptions = [];
  const deps = {
    nullable: (value) => (value === "" || value == null || value === "all" ? null : Number(value)),
    shops: () => [{ id: 1, name: "Shop A", status: "active" }],
    normalizeSyncDate: (value) => value ? String(value).slice(0, 10) : "",
    dateKeyDaysAgo: () => "2026-05-24",
    todayDateKey: () => "2026-05-31",
    get: (sql) => {
      if (sql.includes("ORDER BY ordered_at DESC")) return { ordered_at: "2026-05-31T08:00:00.000Z" };
      return null;
    },
    fetchOzonPostings: async (_shop, options) => {
      fetchedOptions.push(options);
      return { postings: [], requests: 1, ranges: 1 };
    },
    execute: () => ({ changes: 1 }),
    invalidateExceptionWorkbenchCache: () => {},
    refreshProfitAnalyticsSnapshots: () => {},
    syncOutboundForOpenOrders: () => {}
  };

  const result = await syncOzonIncrementalOrders(deps, {
    from_latest: true,
    fallback_days: 7,
    overlap_minutes: 15
  }, {});

  assert.equal(result.mode, "new_orders");
  assert.equal(fetchedOptions.length, 1);
  assert.equal(fetchedOptions[0].from, "2026-05-31T07:45:00.000Z");
  assert.equal(fetchedOptions[0].to, "2026-05-31T23:59:59.999Z");
});

test("cancelled orders do not restore inventory without a posted outbound movement", () => {
  const calls = [];
  const deps = {
    all: (sql) => {
      if (sql.includes("WHERE LOWER(o.status) LIKE '%cancel%'")) {
        return [{
          order_item_id: 1,
          quantity: 2,
          posting_number: "POST-CANCEL",
          shop_id: 1,
          mapping_id: 11,
          product_id: 21,
          person_id: 31,
          online_product_id: 41,
          purchase_cost: 5
        }];
      }
      return [];
    },
    get: (sql) => {
      if (sql.includes("source_type = 'order_outbound'")) return null;
      if (sql.includes("source_type = 'return_in'")) return null;
      return null;
    },
    db: {
      prepare: (sql) => ({
        run: (...params) => calls.push({ sql, params })
      })
    },
    postInventory: (body) => calls.push({ postInventory: body }),
    rebuildInventoryCurrentForProduct: (productId) => calls.push({ rebuild: productId }),
    recordOrderException: () => {}
  };

  const result = syncOutboundForOpenOrders(deps);

  assert.deepEqual(result, { deducted: 0, pending: 0 });
  assert.equal(calls.some((entry) => entry.postInventory?.source_type === "return_in"), false);
  assert.equal(calls.some((entry) => String(entry.sql || "").includes("UPDATE outbound_records")), false);
});

test("cancelled orders restore inventory once from the posted outbound movement", () => {
  const calls = [];
  const deps = {
    all: (sql) => {
      if (sql.includes("WHERE LOWER(o.status) LIKE '%cancel%'")) {
        return [{
          order_item_id: 1,
          quantity: 2,
          posting_number: "POST-CANCEL",
          shop_id: 1,
          mapping_id: 11,
          product_id: 21,
          person_id: 31,
          online_product_id: 41,
          purchase_cost: 5
        }];
      }
      return [];
    },
    get: (sql) => {
      if (sql.includes("source_type = 'order_outbound'")) {
        return {
          id: 101,
          product_id: 21,
          shop_id: 1,
          sku_mapping_id: 11,
          owner_person_id: 31,
          quantity_delta: -2,
          unit_cost: 5,
          status: "posted"
        };
      }
      if (sql.includes("source_type = 'return_in'")) return null;
      return null;
    },
    db: {
      prepare: (sql) => ({
        run: (...params) => calls.push({ sql, params })
      })
    },
    postInventory: (body) => calls.push({ postInventory: body }),
    rebuildInventoryCurrentForProduct: (productId) => calls.push({ rebuild: productId }),
    recordOrderException: () => {}
  };

  const result = syncOutboundForOpenOrders(deps);

  assert.deepEqual(result, { deducted: 0, pending: 0 });
  assert.ok(calls.some((entry) => String(entry.sql || "").includes("UPDATE outbound_records")));
  assert.ok(calls.some((entry) => String(entry.sql || "").includes("UPDATE inventory_movements")));
  assert.deepEqual(calls.find((entry) => entry.postInventory)?.postInventory, {
    product_id: 21,
    shop_id: 1,
    sku_mapping_id: 11,
    owner_person_id: 31,
    source_type: "return_in",
    source_ref: "cancel_1",
    quantity_delta: 2,
    unit_cost: 5,
    amount: 10,
    related_order_item_id: 1,
    note: "Order cancelled, inventory restored"
  });
});

test("cancelled order restore updates an existing return movement instead of adding another", () => {
  const calls = [];
  const deps = {
    all: (sql) => {
      if (sql.includes("WHERE LOWER(o.status) LIKE '%cancel%'")) {
        return [{
          order_item_id: 1,
          quantity: 2,
          posting_number: "POST-CANCEL",
          shop_id: 1,
          mapping_id: 11,
          product_id: 21,
          person_id: 31,
          online_product_id: 41,
          purchase_cost: 5
        }];
      }
      return [];
    },
    get: (sql) => {
      if (sql.includes("source_type = 'order_outbound'")) {
        return {
          id: 101,
          product_id: 21,
          shop_id: 1,
          sku_mapping_id: 11,
          owner_person_id: 31,
          quantity_delta: -2,
          unit_cost: 5,
          status: "posted"
        };
      }
      if (sql.includes("source_type = 'return_in'")) return { id: 201, product_id: 21 };
      return null;
    },
    db: {
      prepare: (sql) => ({
        run: (...params) => calls.push({ sql, params })
      })
    },
    postInventory: (body) => calls.push({ postInventory: body }),
    rebuildInventoryCurrentForProduct: (productId) => calls.push({ rebuild: productId }),
    recordOrderException: () => {}
  };

  syncOutboundForOpenOrders(deps);

  assert.equal(calls.some((entry) => entry.postInventory?.source_type === "return_in"), false);
  assert.ok(calls.some((entry) => String(entry.sql || "").includes("UPDATE inventory_movements")
    && String(entry.sql || "").includes("source_type = 'order_outbound'")));
  assert.ok(calls.some((entry) => String(entry.sql || "").includes("UPDATE inventory_movements")
    && String(entry.sql || "").includes("WHERE id = ?")
    && entry.params.at(-1) === 201));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { saveOrderPostingLogistics } from "../src/services/mysql-order-posting-logistics.js";
import { hasMeaningfulPostingMethod, isFbpPosting, mergeOrderPostingLogistics } from "../src/services/order-posting-logistics-merge.js";
import { classifyOrderLogistics, orderLogisticsEvidence } from "../src/services/order-logistics-classification.js";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const shop = { id: 4, name: "Synthetic shop", status: "active" };
const clone = (value) => JSON.parse(JSON.stringify(value));

function functions(names, context) {
  const definitions = names.map((name) => {
    const definition = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))?.[0];
    assert.ok(definition, `Missing function ${name}`);
    return definition;
  });
  // This fixture isolates logistics merging; tenant authorization and actual SQL
  // ownership are exercised by the dedicated tenant and shipping MySQL suites.
  return vm.runInNewContext(`${definitions.join("\n")}\n({${names.join(",")}})`, {
    orderListTenantScopeMysql: async () => ({ id: 1, defaultTenant: true }),
    orderOwnershipTenantScopeMysql: async () => ({ id: 1, defaultTenant: true }),
    assertOrderTaskAccessMysql: async () => {},
    activeShopForTenantMysql: async id => ({ ...shop, id, tenant_id: 1 }),
    ...context
  });
}

function richPosting(status = "delivering") {
  return {
    posting_number: "SYNTHETIC-FBP-1", order_number: "SYNTHETIC-ORDER-1", order_id: "1001",
    status, logistics_status: status, tracking_stage: status, ordered_at: "2026-10-20T01:00:00Z",
    tracking_number: "HISTORY-TRACK-1", external_tracking_url: "https://example.test/tracking/HISTORY-TRACK-1",
    items: [], raw: {
      status, tracking_number: "HISTORY-TRACK-1", products: [{ sku: "old-product" }],
      delivery_method: { id: 101, name: "CEL FBP Standard Hch-PD2", warehouse: "CEL HUNCHUN Warehouse", warehouse_id: 51, tpl_provider: "CEL", tpl_provider_id: 5 }
    }
  };
}

function sparsePosting(status = "cancelled") {
  return {
    posting_number: "SYNTHETIC-FBP-1", order_number: "SYNTHETIC-ORDER-1", order_id: "1001",
    fulfillment_schema: "FBP", status, logistics_status: status, tracking_stage: status,
    ordered_at: "2026-10-20T01:00:00Z", tracking_number: "", external_tracking_url: "", items: [],
    raw: { status, fulfillment_schema: "FBP", delivery_method: { name: "FBP" },
      cancellation: { cancel_reason: "latest cancellation" }, products: [] }
  };
}

function assertRichLogistics(posting, status) {
  assert.equal(posting.status, status);
  assert.equal(posting.raw.status, status);
  assert.equal(posting.fulfillment_schema, "FBP");
  assert.equal(posting.raw.delivery_method.name, "CEL FBP Standard Hch-PD2");
  assert.equal(posting.raw.delivery_method.warehouse, "CEL HUNCHUN Warehouse");
  assert.equal(posting.raw.delivery_method.tpl_provider, "CEL");
  assert.equal(posting.tracking_number, "HISTORY-TRACK-1");
  assert.equal(posting.external_tracking_url, "https://example.test/tracking/HISTORY-TRACK-1");
  assert.equal(posting.raw.cancellation.cancel_reason, "latest cancellation");
  assert.deepEqual(Array.from(posting.raw.products), [], "incoming products must not be restored from old logistics evidence");
}

// The real SQL persistence helper runs against this connection-shaped memory fake.
// Nothing imports or opens the application's MySQL connection.
function memoryStorage(previous) {
  let stored = previous ? clone(previous) : null;
  let transactions = 0;
  const calls = [];
  const connection = {
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO ozon_orders_raw/.test(sql)) {
        assert.deepEqual(params.slice(0, 2), [shop.id, "SYNTHETIC-FBP-1"]);
        if (!stored) stored = JSON.parse(params[5]);
      } else if (/UPDATE ozon_orders_raw SET/.test(sql)) {
        assert.deepEqual(params.slice(4), [shop.id, "SYNTHETIC-FBP-1"]);
        stored = JSON.parse(params[3]);
      } else {
        assert.fail(`Unexpected persistence write: ${sql}`);
      }
      return [{ affectedRows: 1 }];
    },
    query: async (sql, params) => {
      calls.push({ sql, params });
      assert.match(sql, /WHERE store_id = \? AND posting_number = \? FOR UPDATE/);
      assert.deepEqual(params, [shop.id, "SYNTHETIC-FBP-1"]);
      return [[{ raw_json: JSON.stringify(stored) }]];
    }
  };
  return {
    calls,
    get posting() { return stored; },
    get transactions() { return transactions; },
    transaction: async (callback) => { transactions++; return callback(connection); }
  };
}

function persistenceContext(storage) {
  return { saveOrderPostingLogistics, withMysqlTransaction: storage.transaction, compactOnlineProductRawJson: JSON.stringify };
}

test("FBS and FBP feeds merge the same posting once without reverting the latest FBP status", async () => {
  for (const status of ["awaiting_deliver", "cancelled"]) {
    const written = [];
    const { syncDemoOrdersMysql } = functions(["syncDemoOrdersMysql"], {
      mergeOrderPostingLogistics,
      ensureMysqlCutoverEnabled() {}, nullableInteger: (value) => Number(value || 0), shopsMysql: async () => [shop],
      textValueMysql: (...values) => values.find(Boolean) || "", normalizeSyncDateMysql: () => "2026-10-20",
      normalizeSyncDateTimeMysql: () => "", normalizeShanghaiDateBoundaryMysql: () => "2026-10-19T16:00:00Z",
      throwIfAbortedMysql() {}, chinaDateKeyMysql: () => "2026-10-20", markInventoryAlertSkuDailyDirtyMysql: async () => {},
      fetchOzonPostings: async () => ({ postings: [richPosting()], requests: 1 }),
      fetchOzonFbpPostings: async () => ({ postings: [sparsePosting(status)], requests: 1 }),
      upsertPostingMysql: async (_shop, posting) => { written.push(posting); return { inserted: 0, updated: 1, insertedItems: 0 }; },
      mysqlExecute: async () => {}, invalidateMasterDataCache() {}
    });
    const result = await syncDemoOrdersMysql({ skip_post_processing: true });
    assert.equal(result.fetched, 1);
    assert.equal(result.requests, 2);
    assert.equal(result.errors.length, 0);
    assert.equal(written.length, 1);
    assertRichLogistics(written[0], status);
  }
});

test("saveRawPostingMysql returns the transactionally merged snapshot instead of the sparse input", async () => {
  const storage = memoryStorage(richPosting());
  const { saveRawPostingMysql } = functions(["saveRawPostingMysql"], persistenceContext(storage));
  const merged = await saveRawPostingMysql(shop, sparsePosting());
  assertRichLogistics(merged, "cancelled");
  assertRichLogistics(storage.posting, "cancelled");
  assert.equal(storage.transactions, 1);
  assert.equal(storage.calls.filter(({ sql }) => /FOR UPDATE/.test(sql)).length, 1);
});

function upsertService(storage, existing, detailLookup = async () => null) {
  const writes = [], histories = [], lifecyclePostings = [], stockPostings = [];
  const service = functions(["saveRawPostingMysql", "upsertPostingMysql"], {
    ...persistenceContext(storage), mergeOrderPostingLogistics, hasMeaningfulPostingMethod, isFbpPosting, AbortSignal,
    fetchOzonPostingByNumber: detailLookup, throwIfAbortedMysql() {},
    mysqlQueryOne: async (sql, params) => {
      assert.match(sql, /SELECT \* FROM orders WHERE shop_id = \? AND posting_number = \?/);
      assert.equal(params[0], shop.id);
      return existing;
    },
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); return { insertId: 42 }; },
    orderLifecycleMysql: (posting) => { lifecyclePostings.push(posting); return { syncState: posting.status, finalizedAt: null, note: "synthetic" }; },
    orderCancelLossAppliesMysql: async () => false, normalizeMysqlNullableDateTime: (value) => value || null,
    recordOrderStatusHistoryMysql: async (_shop, posting) => { histories.push(posting); },
    resolveOrderStockLocationMysql: (posting) => { stockPostings.push(posting); return { stockLocation: "FBP", stockLocationSource: "ozon" }; },
    accrueDeliveredItemsMysql: async () => {}, isOrderInTransportMysql: () => false,
    markInventoryAlertSkuDailyDirtyMysql: async () => {}, invalidateOrderProcurementCoverage() {}
  });
  return { ...service, writes, histories, lifecyclePostings, stockPostings };
}

test("both order INSERT and UPDATE use merged tracking and preserve a rich cancelled posting", async () => {
  for (const existing of [null, { id: 42, status: "delivering", tracking_stage: "delivering" }]) {
    const storage = memoryStorage(richPosting());
    const service = upsertService(storage, existing);
    const result = await service.upsertPostingMysql(shop, sparsePosting(), "incremental", { salesDatesMarked: true });
    const write = service.writes.find(({ sql }) => existing ? /UPDATE orders SET/.test(sql) : /INSERT INTO orders\s/.test(sql));
    assert.ok(write);
    assert.equal(write.params[existing ? 2 : 3], "cancelled");
    assert.equal(write.params[existing ? 7 : 10], "HISTORY-TRACK-1");
    assert.equal(write.params[existing ? 8 : 11], "https://example.test/tracking/HISTORY-TRACK-1");
    assert.equal(result.inserted, existing ? 0 : 1);
    assert.equal(result.updated, existing ? 1 : 0);
    for (const posting of [...service.histories, ...service.lifecyclePostings, ...service.stockPostings]) assertRichLogistics(posting, "cancelled");
    assert.equal(service.histories.length, 1);
    assert.equal(service.lifecyclePostings.length, 1);
    assert.equal(service.stockPostings.length, 1);
  }
});

test("a bounded single-posting lookup repairs sparse cancelled logistics without reviving its old status", async () => {
  const storage = memoryStorage(sparsePosting());
  const lookups = [];
  const service = upsertService(storage, { id: 42, status: "delivering" }, async (requestedShop, number, options) => {
    lookups.push({ requestedShop, number, options });
    return richPosting("delivering");
  });
  const budget = { remaining: 1 };
  await service.upsertPostingMysql(shop, sparsePosting(), "incremental", { salesDatesMarked: true, logisticsDetailBudget: budget });
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].requestedShop.id, shop.id);
  assert.equal(lookups[0].number, "SYNTHETIC-FBP-1");
  assert.ok(lookups[0].options.signal instanceof AbortSignal);
  assert.equal(budget.remaining, 0);
  assert.equal(storage.transactions, 2);
  assertRichLogistics(storage.posting, "cancelled");
  assertRichLogistics(service.histories[0], "cancelled");
  const update = service.writes.find(({ sql }) => /UPDATE orders SET/.test(sql));
  assert.equal(update.params[2], "cancelled");
  assert.equal(update.params[7], "HISTORY-TRACK-1");
});

test("detail lookup cannot replay stale status, provider or tracking over a concurrent sync", { timeout: 5000 }, async () => {
  const storage = memoryStorage(sparsePosting("awaiting_deliver"));
  let announceLookup, finishLookup;
  const lookupStarted = new Promise((resolve) => { announceLookup = resolve; });
  const detailResult = new Promise((resolve) => { finishLookup = resolve; });
  const service = upsertService(storage, { id: 42, status: "awaiting_deliver" }, async () => {
    announceLookup();
    return detailResult;
  });
  const pending = service.upsertPostingMysql(shop, sparsePosting("cancelled"), "incremental", {
    salesDatesMarked: true, logisticsDetailBudget: { remaining: 1 }
  });
  await lookupStarted;
  const concurrent = sparsePosting("delivered");
  concurrent.tracking_number = "CONCURRENT-TRACK-2";
  concurrent.external_tracking_url = "https://example.test/tracking/CONCURRENT-TRACK-2";
  concurrent.raw.delivery_method = {
    id: 202, name: "GUOO FBP Standard", warehouse: "GUOO current warehouse", warehouse_id: 61, tpl_provider: "GUOO", tpl_provider_id: 9
  };
  concurrent.raw.tracking_number = concurrent.tracking_number;
  concurrent.raw.products = [{ sku: "concurrent-product" }];
  concurrent.raw.cancellation = { cancel_reason: "concurrent snapshot" };
  // A second actual persistence call commits while the first call awaits GET.
  await service.saveRawPostingMysql(shop, concurrent);
  finishLookup(richPosting("delivering"));
  await pending;

  assert.equal(storage.transactions, 3);
  for (const actual of [storage.posting, service.histories[0], service.lifecyclePostings[0], service.stockPostings[0]]) {
    assert.equal(actual.status, "delivered");
    assert.equal(actual.raw.status, "delivered");
    assert.equal(actual.raw.delivery_method.name, "GUOO FBP Standard");
    assert.equal(actual.raw.delivery_method.warehouse, "GUOO current warehouse");
    assert.equal(actual.raw.delivery_method.tpl_provider, "GUOO");
    assert.equal(actual.raw.delivery_method.tpl_provider_id, 9);
    assert.equal(actual.tracking_number, "CONCURRENT-TRACK-2");
    assert.equal(actual.external_tracking_url, concurrent.external_tracking_url);
    assert.equal(actual.raw.products[0].sku, "concurrent-product");
    assert.equal(actual.raw.cancellation.cancel_reason, "concurrent snapshot");
  }
  const update = service.writes.find(({ sql }) => /UPDATE orders SET/.test(sql));
  assert.equal(update.params[2], "delivered");
  assert.equal(update.params[7], "CONCURRENT-TRACK-2");
  assert.equal(update.params[8], concurrent.external_tracking_url);
});

test("shipping reconciliation uses the same merged raw save result for tracking and its returned posting", async () => {
  const storage = memoryStorage(richPosting());
  const writes = [];
  const { syncOrderShippingStateFromOzonMysql } = functions([
    "saveRawPostingMysql", "isAwaitingDeliverLikeStatusMysql", "normalizeSyncedShippingStateMysql", "syncOrderShippingStateFromOzonMysql"
  ], {
    ...persistenceContext(storage), fetchOzonPostingByNumber: async () => sparsePosting("awaiting_deliver"),
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); },
    markInventoryAlertSkuDailyDirtyMysql: async () => {}, invalidateOrderProcurementCoverage() {}
  });
  const result = await syncOrderShippingStateFromOzonMysql(shop, { id: 42, posting_number: "SYNTHETIC-FBP-1" });
  assert.equal(result.ok, true);
  assertRichLogistics(result.posting, "awaiting_deliver");
  const update = writes.find(({ sql }) => /UPDATE orders/.test(sql));
  assert.equal(update.params[0], "awaiting_deliver");
  assert.equal(update.params[3], "HISTORY-TRACK-1");
  assert.equal(update.params[4], "https://example.test/tracking/HISTORY-TRACK-1");
  assert.equal(storage.transactions, 1);
  assertRichLogistics(storage.posting, "awaiting_deliver");
});

test("top-level raw warehouse and provider survive enrichment and detail reclassification consistently", async () => {
  const { resolveOrderLogisticsRuleMysql, enrichOrderLogisticsMysql } = functions([
    "resolveOrderLogisticsRuleMysql", "enrichOrderLogisticsMysql"
  ], {
    orderLogisticsEvidence, classifyOrderLogistics,
    parseJsonOrNull: (value) => { try { return JSON.parse(value); } catch { return null; } },
    normalizeResolvedLogisticsRuleMysql: (value) => value, matchOrderLogisticsRuleMysql: async () => null,
    detectOrderLogisticsLabelMysql: async () => null,
    fallbackShipDeadlineMysql: () => "", describeCancellation: () => ({}), detectShippingMethodKeyMysql: () => ""
  });
  const row = { status: "cancelled", raw_json: JSON.stringify({ raw: {
    fulfillment_schema: "FBP", delivery_method: { name: "FBP" }, warehouse_name: "CEL HUNCHUN Warehouse", tpl_provider: "CEL"
  } }) };
  const resolved = await resolveOrderLogisticsRuleMysql(row);
  assert.equal(resolved.warehouseName, "CEL HUNCHUN Warehouse");
  assert.equal(resolved.logisticsChannel, "CEL");
  const enriched = await enrichOrderLogisticsMysql(row);
  assert.equal(enriched.raw_json, undefined);
  assert.equal(enriched.warehouse_name, "CEL HUNCHUN Warehouse");
  assert.equal(enriched.logistics_channel, "CEL");
  for (const actual of [enriched, classifyOrderLogistics(enriched)]) {
    assert.equal(actual.logistics_carrier, "cel");
    assert.equal(actual.logistics_method_label, "CEL HUNCHUN Warehouse");
    assert.equal(actual.logistics_fulfillment_type, "fbp");
  }
});

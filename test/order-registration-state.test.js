import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { orderStateKey, STATE_META } from "../frontend/orders/constants/orders-ui.js";
import { classifyOrderLogistics } from "../src/services/order-logistics-classification.js";

const mysqlSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const composableSource = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

function functionSource(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}

function loadFunctions(source, names, context = {}) {
  return vm.runInNewContext(`${names.map((name) => functionSource(source, name)).join("\n")}\n({${names.join(",")}})`, { STATE_META, orderStateKey, ...context });
}

function registerStatusSqlFunctions(db) {
  db.function("CONCAT", { varargs: true }, (...values) => values.join(""));
  db.function("REGEXP", (pattern, value) => Number(new RegExp(String(pattern)
    .replaceAll("[^[:space:]]", "\\S").replaceAll("[[:space:]]", "\\s")).test(String(value || ""))));
}

const registrationRows = [
  { status: "awaiting_registration", tracking_stage: "posting_registration_error" },
  { status: "awaiting_registration", tracking_stage: "posting_awaiting_registration" },
  { status: "posting_awaiting_registration", tracking_stage: "" }
];
const acceptanceRows = [
  { status: "acceptance_in_progress", tracking_stage: "posting_acceptance_in_progress" },
  { status: "posting_acceptance_in_progress", tracking_stage: "" },
  { status: "", tracking_stage: "posting_acceptance_in_progress" },
  { status: "awaiting_packaging", tracking_stage: "posting_acceptance_in_progress" }
];

test("FBS acceptance is awaiting dispatch, cannot prepare again, and keeps Ozon label actions", () => {
  const page = loadFunctions(pageSource, ["rowStateLabel", "rowDisplayStateKey", "rowAvailableActions"], { STATE_META });
  for (const row of acceptanceRows) {
    const actions = page.rowAvailableActions({ ...row, ozon_available_actions: ["click_track_number", "label_download", "label_download_small"] });
    assert.equal(page.rowDisplayStateKey(row), "awaiting_deliver");
    assert.equal(page.rowStateLabel(row), "等待发运");
    assert.equal(actions.prepare, false);
    assert.equal(actions.splitPrepare, false);
    assert.equal(actions.showPrint, true);
    assert.equal(actions.print, true);
  }
});
test("acceptance in progress is assembled and awaits handover, with Ozon-controlled label actions", () => {
  const page = loadFunctions(pageSource, ["rowStateLabel", "rowDisplayStateKey", "rowRegistrationHint", "rowAvailableActions"], { STATE_META });
  for (const row of acceptanceRows) {
    const printable = { ...row, total_quantity: 2, ozon_available_actions: ["click_track_number", "label_download", "label_download_small"], availableActions: { prepare: true, print: true } };
    assert.equal(page.rowDisplayStateKey(printable), "awaiting_deliver");
    assert.equal(page.rowStateLabel(printable), "等待发运");
    assert.match(page.rowRegistrationHint(printable), /已备货.*交接/);
    const actions = page.rowAvailableActions(printable);
    assert.equal(actions.prepare, false);
    assert.equal(actions.showPrepare, false);
    assert.equal(actions.splitPrepare, false);
    assert.equal(actions.showPrint, true);
    assert.equal(actions.print, true);
    assert.equal(page.rowAvailableActions({ ...printable, ozon_available_actions: ["click_track_number"] }).print, false);
  }
});

test("acceptance display and optimistic counts cannot regress transit or terminal statuses", () => {
  const page = loadFunctions(pageSource, ["rowStateLabel", "rowDisplayStateKey", "rowAvailableActions"], { STATE_META });
  const { orderTabKey } = loadFunctions(composableSource, ["orderTabKey"]);
  for (const row of acceptanceRows) assert.equal(orderTabKey(row), "awaiting_deliver");
  for (const status of ["delivering", "delivered", "cancelled"]) {
    const row = { status, tracking_stage: "posting_acceptance_in_progress", ozon_available_actions: ["label_download"] };
    assert.equal(page.rowDisplayStateKey(row), status);
    assert.equal(page.rowStateLabel(row), STATE_META[status].label);
    assert.equal(orderTabKey(row), status);
    assert.equal(page.rowAvailableActions(row).prepare, false);
    assert.equal(page.rowAvailableActions(row).print, false);
  }
});

test("OGL applications awaiting physical handover preserve ready Ozon labels without enabling preparation", () => {
  const page = loadFunctions(pageSource, ["rowDisplayStateKey", "rowAvailableActions"]);
  for (const platform of [...acceptanceRows, { status: "awaiting_deliver" }]) {
    const pending = {
      ...platform, display_status: "ogl_dispatched", total_quantity: 2,
      ogl_dispatch: { tracking: true, applied: true, dispatched: false, dispatched_at: null, stage: "applied" },
      ozon_available_actions: ["label_download"], availableActions: { prepare: true, print: true, purchase: true }
    };
    assert.equal(page.rowDisplayStateKey(pending), "ogl_dispatched");
    const actions = page.rowAvailableActions(pending);
    assert.equal(actions.showPrint, true, JSON.stringify(platform));
    assert.equal(actions.print, true, JSON.stringify(platform));
    for (const key of ["prepare", "showPrepare", "splitPrepare", "showSplitPrepare", "showPurchase", "purchase"]) {
      assert.equal(actions[key], false, `${key} must not change with the print fix`);
    }
    for (const patch of [
      { ozon_available_actions: ["click_track_number"] },
      { ozon_available_actions: [] },
      { ozon_available_actions: undefined },
      { availableActions: { print: false } },
      { fulfillment_type_key: "fbp" },
      { procurement_coverage: { stock_location: "FBP" } },
      { ogl_dispatch: { ...pending.ogl_dispatch, dispatched: true, dispatched_at: null } },
      { ogl_dispatch: { ...pending.ogl_dispatch, dispatched: true, dispatched_at: "2026-10-22 06:00:00" } },
      { ogl_dispatch: { ...pending.ogl_dispatch, dispatched: false, dispatched_at: "2026-10-22 06:00:00" } },
      ...["delivering", "delivered", "cancelled", "returned", "rejected", "dispute"].map(status => ({ status })),
      ...["posting_in_transit", "posting_received_by_buyer", "posting_cancelled"].map(tracking_stage => ({ tracking_stage })),
      { status: "awaiting_packaging", tracking_stage: "", logistics_status: "" }
    ]) {
      assert.equal(page.rowAvailableActions({ ...pending, ...patch }).print, false, JSON.stringify(patch));
    }
    assert.equal(page.rowAvailableActions({ ...pending, ozon_available_actions: ["label_download_small"], availableActions: {} }).print, true);
  }
});

test("assembled orders being registered appear under awaiting delivery, with label permissions from Ozon", () => {
  const page = loadFunctions(pageSource, ["rowStateLabel", "rowDisplayStateKey", "rowAvailableActions"], { STATE_META });
  for (const row of registrationRows) {
    const printable = { ...row, ozon_available_actions: ["label_download", "label_download_small"] };
    assert.equal(page.rowDisplayStateKey(printable), "awaiting_deliver");
    assert.equal(page.rowStateLabel(printable), "等待发运");
    const actions = page.rowAvailableActions(printable);
    assert.equal(actions.prepare, false);
    assert.equal(actions.splitPrepare, false);
    assert.equal(actions.showPrint, true);
    assert.equal(actions.print, true);
    assert.equal(page.rowAvailableActions(row).print, false, "registration without a ready label must not enable printing");
  }
  assert.equal(page.rowAvailableActions({ status: "awaiting_packaging" }).prepare, true);
  assert.equal(page.rowAvailableActions({ status: "awaiting_deliver" }).print, true);
  assert.equal(page.rowAvailableActions({ status: "cancelled" }).print, false);
});

test("optimistic tab counts classify registration as awaiting delivery", () => {
  const { orderTabKey } = loadFunctions(composableSource, ["orderTabKey"]);
  for (const row of [...registrationRows, ...acceptanceRows]) assert.equal(orderTabKey(row), "awaiting_deliver");
});

test("registration detail preserves Ozon substatus without a list warning", () => {
  const { rowRegistrationHint } = loadFunctions(pageSource, ["rowRegistrationHint"]);
  assert.match(rowRegistrationHint(registrationRows[0]), /注册异常.*不代表面单下载或发货失败/);
  const table = readFileSync(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");
  assert.doesNotMatch(table, /row\.registrationHint/);
  assert.match(pageSource, /label="配送注册信息"/);
  assert.match(rowRegistrationHint(registrationRows[1]), /已备货.*安排配送/);
  assert.equal(rowRegistrationHint({ status: "awaiting_deliver" }), "");
});

test("order list enrichment exposes label permissions without exposing the raw posting", async () => {
  const { enrichOrderLogisticsMysql } = loadFunctions(mysqlSource, ["enrichOrderLogisticsMysql"], {
    classifyOrderLogistics,
    resolveOrderLogisticsRuleMysql: async () => ({
      rule: null, warehouseName: "", deliveryMethodName: "", logisticsChannel: "",
      raw: { available_actions: ["label_download"] }, analytics: {}
    }),
    fallbackShipDeadlineMysql: () => "",
    describeCancellation: () => ({}),
    detectShippingMethodKeyMysql: () => ""
  });
  const row = await enrichOrderLogisticsMysql({ ...registrationRows[0], raw_json: "{}" });
  assert.deepEqual(row.ozon_available_actions, ["label_download"]);
  assert.equal(row.raw_json, undefined);
});

test("SQL filters put registration in the same tab as the frontend without rewriting stored status", () => {
  const { orderStatusSqlMysql } = loadFunctions(mysqlSource, ["orderStatusSqlMysql"], {
    oglBoundStatusSql: () => "0", oglDispatchedStatusSql: () => "0", oglOnlineStatusSql: () => "0", oglTerminalStatusSql: () => "0", oglPhysicalDispatchSql: () => "0"
  });
  const db = new DatabaseSync(":memory:");
  registerStatusSqlFunctions(db);
  try {
    db.exec("CREATE TABLE orders (status TEXT, tracking_stage TEXT, logistics_status TEXT, tracking_number TEXT)");
    const insert = db.prepare("INSERT INTO orders VALUES (?, ?, '', '')");
    for (const row of registrationRows) insert.run(row.status, row.tracking_stage);
    for (const row of acceptanceRows) insert.run(row.status, row.tracking_stage);
    insert.run("awaiting_packaging", "posting_created");
    insert.run("cancelled", "cancelled");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${orderStatusSqlMysql("awaiting_deliver")}`).get().n, registrationRows.length + acceptanceRows.length);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${orderStatusSqlMysql("awaiting_packaging")}`).get().n, 1);
  } finally {
    db.close();
  }
});

test("SQL and frontend give exact transit facts priority over stale acceptance without reading tracking numbers", () => {
  const { orderStatusSqlMysql } = loadFunctions(mysqlSource, ["orderStatusSqlMysql"], {
    oglBoundStatusSql: () => "0", oglDispatchedStatusSql: () => "0", oglOnlineStatusSql: () => "0", oglTerminalStatusSql: () => "0", oglPhysicalDispatchSql: () => "0"
  });
  const transit = ["delivering", "posting_in_transit", "posting_in_customs", "posting_sorting", "posting_on_way", "posting_on_way_to_city", "posting_in_courier_service", "posting_in_pickup_point"];
  const rows = transit.flatMap(value => ["status", "tracking_stage", "logistics_status"].map(field => ({
    status: "acceptance_in_progress", tracking_stage: "posting_acceptance_in_progress", logistics_status: "", [field]: value
  })));
  rows.push(
    { status: "awaiting_packaging", tracking_stage: "posting_created", logistics_status: "posting_acceptance_in_progress" },
    ...["delivering", "posting_in_transit", "delivered", "cancelled", "dispute"].map(tracking_number => ({ status: "acceptance_in_progress", tracking_stage: "posting_acceptance_in_progress", tracking_number })),
    ...["not_posting_in_transit", "xposting_on_way", "posting_in_customs_extra"].map(logistics_status => ({ status: "acceptance_in_progress", tracking_stage: "posting_acceptance_in_progress", logistics_status })),
    ...["delivered", "cancelled", "returned", "dispute"].map(status => ({ status, tracking_stage: "posting_acceptance_in_progress", logistics_status: "posting_in_transit" }))
  );
  const db = new DatabaseSync(":memory:");
  registerStatusSqlFunctions(db);
  try {
    db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, tracking_stage TEXT, logistics_status TEXT, tracking_number TEXT)");
    const insert = db.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?)");
    const waiting = db.prepare(`SELECT id FROM orders o WHERE id=? AND ${orderStatusSqlMysql("awaiting_deliver")}`);
    const delivering = db.prepare(`SELECT id FROM orders o WHERE id=? AND ${orderStatusSqlMysql("delivering")}`);
    for (const [index, row] of rows.entries()) {
      insert.run(index + 1, row.status || "", row.tracking_stage || "", row.logistics_status || "", row.tracking_number || "");
      const expected = orderStateKey(row);
      assert.equal(Boolean(waiting.get(index + 1)), expected === "awaiting_deliver", JSON.stringify(row));
      assert.equal(Boolean(delivering.get(index + 1)), expected === "delivering", JSON.stringify(row));
    }
  } finally { db.close(); }
});

test("shipping reconciliation recognizes registration but preserves the actual Ozon substatus", () => {
  const service = loadFunctions(mysqlSource, ["isAwaitingDeliverLikeStatusMysql", "normalizeSyncedShippingStateMysql"]);
  for (const row of registrationRows) {
    assert.equal(service.isAwaitingDeliverLikeStatusMysql(`${row.status} ${row.tracking_stage}`), true);
    const normalized = service.normalizeSyncedShippingStateMysql(row);
    assert.equal(normalized.status, "awaiting_registration");
    assert.equal(normalized.trackingStage, row.tracking_stage || row.status);
  }
  assert.equal(service.isAwaitingDeliverLikeStatusMysql("awaiting_packaging posting_created"), false);
});

test("shipping compensation retains acceptance and terminal status instead of demoting them", () => {
  const service = loadFunctions(mysqlSource, ["isAwaitingDeliverLikeStatusMysql", "normalizeSyncedShippingStateMysql"]);
  for (const row of acceptanceRows) {
    assert.equal(service.isAwaitingDeliverLikeStatusMysql(`${row.status} ${row.tracking_stage}`), true);
    assert.equal(service.normalizeSyncedShippingStateMysql(row).status, "acceptance_in_progress");
  }
  for (const status of ["delivering", "delivered"]) {
    assert.equal(service.isAwaitingDeliverLikeStatusMysql(status), true);
    assert.equal(service.normalizeSyncedShippingStateMysql({ status, tracking_stage: "awaiting_deliver" }).status, status);
  }
  for (const status of ["cancelled", "cancelled posting_registered", "returned", "rejected", "dispute", "unknown"]) {
    assert.equal(service.isAwaitingDeliverLikeStatusMysql(status), false);
  }
});

test("clicking prepare on a stale row reconciles registration without submitting shipping again", async () => {
  const order = { id: 1, shop_id: 1, posting_number: "test-posting", status: "awaiting_packaging", tracking_stage: "posting_created" };
  const posting = { ...registrationRows[0], posting_number: order.posting_number, raw: { available_actions: ["label_download"] } };
  const writes = [];
  let shippingCalls = 0;
  const service = loadFunctions(mysqlSource, [
    "isAwaitingDeliverLikeStatusMysql", "normalizeSyncedShippingStateMysql",
    "syncOrderShippingStateFromOzonMysql", "shipOrdersMysql"
  ], {
    ensureMysqlCutoverEnabled() {},
    orderListTenantScopeMysql: async () => ({ id: 1, defaultTenant: true }),
    orderOwnershipTenantScopeMysql: async () => ({ id: 1, defaultTenant: true }),
    assertOrderTaskAccessMysql: async () => {},
    orderTenantPredicateMysql: () => "1 = 1",
    assertOrderBatchOwnershipMysql: (rows, ids) => assert.equal(rows.length, ids.length),
    activeShopForTenantMysql: async id => ({ id, tenant_id: 1, name: "Fixture shop" }),
    mysqlQuery: async (sql) => sql.includes("order_split_operations") ? [] : sql.includes("FROM orders o") ? [order] : [{ id: 11, quantity: 1, order_product_id: 101 }],
    mysqlQueryOne: async () => ({ raw_json: "{}" }),
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); },
    markInventoryAlertSkuDailyDirtyMysql: async () => {},
    invalidateOrderProcurementCoverage() {},
    sortRowsByInputMysql: (rows) => rows,
    shippingProductItemsFromRawPayloadMysql: () => [],
    resolveShippingProductIdMysql: () => 101,
    fetchOzonPostingByNumber: async () => posting,
    saveRawPostingMysql: async (_shop, latestPosting) => latestPosting,
    shipOzonPosting: async () => { shippingCalls += 1; throw new Error("HAS_INCORRECT_STATUS"); },
    buildLiveShippingProductsMysql: () => [],
    scheduleOrderPackageLabelPrefetchMysql() {},
    compactOnlineProductRawJson: JSON.stringify
  });
  const result = await service.shipOrdersMysql({ order_ids: [1] });
  assert.equal(shippingCalls, 0);
  assert.equal(result.already_shipped_count, 1);
  assert.equal(result.updated_orders[0].status, "awaiting_registration");
  assert.deepEqual(result.updated_orders[0].ozon_available_actions, ["label_download"]);
  const update = writes.find((entry) => entry.sql.includes("UPDATE orders"));
  assert.equal(update.params[0], "awaiting_registration");
  assert.equal(update.params[2], "posting_registration_error");
});

test('FBP order actions disable procurement even when the API previously permitted it', () => {
  const page = loadFunctions(pageSource, ['rowStateLabel', 'rowDisplayStateKey', 'rowAvailableActions'], { STATE_META });
  for (const status of ['awaiting_packaging', 'awaiting_deliver']) {
    for (const identity of [{ fulfillment_type_key: 'fbp' }, { procurement_coverage: { stock_location: 'FBP' } }]) {
      const actions = page.rowAvailableActions({ status, ...identity, availableActions: { purchase: true } });
      assert.equal(actions.showPurchase, false);
      assert.equal(actions.purchase, false);
    }
    assert.equal(page.rowAvailableActions({ status, fulfillment_type_key: 'fbs' }).showPurchase, true);
  }
});

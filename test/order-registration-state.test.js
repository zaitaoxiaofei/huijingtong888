import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { STATE_META } from "../frontend/orders/constants/orders-ui.js";

const mysqlSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const composableSource = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

function functionSource(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
  assert.ok(match, `Missing function ${name}`);
  return match[0];
}

function loadFunctions(source, names, context = {}) {
  return vm.runInNewContext(`${names.map((name) => functionSource(source, name)).join("\n")}\n({${names.join(",")}})`, context);
}

const registrationRows = [
  { status: "awaiting_registration", tracking_stage: "posting_registration_error" },
  { status: "awaiting_registration", tracking_stage: "posting_awaiting_registration" },
  { status: "posting_awaiting_registration", tracking_stage: "" }
];

test("assembled orders being registered appear under awaiting delivery, with label permissions from Ozon", () => {
  const page = loadFunctions(pageSource, ["rowStateLabel", "rowDisplayStateKey", "rowAvailableActions"], { STATE_META });
  for (const row of registrationRows) {
    const printable = { ...row, ozon_available_actions: ["label_download", "label_download_small"] };
    assert.equal(page.rowDisplayStateKey(printable), "awaiting_deliver");
    assert.equal(page.rowStateLabel(printable), "等待发货");
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
  const constants = composableSource.match(/const AWAITING_PACKAGING_STATES[^]*?const DELIVERING_KEYWORDS[^]*?;/)[0];
  const orderTabKey = vm.runInNewContext(`${constants}\n${functionSource(composableSource, "orderTabKey")}\norderTabKey`);
  for (const row of registrationRows) assert.equal(orderTabKey(row), "awaiting_deliver");
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
  const { orderStatusSqlMysql } = loadFunctions(mysqlSource, ["orderStatusSqlMysql"]);
  const db = new DatabaseSync(":memory:");
  db.function("CONCAT", { varargs: true }, (...values) => values.join(""));
  try {
    db.exec("CREATE TABLE orders (status TEXT, tracking_stage TEXT, logistics_status TEXT, tracking_number TEXT)");
    const insert = db.prepare("INSERT INTO orders VALUES (?, ?, '', '')");
    for (const row of registrationRows) insert.run(row.status, row.tracking_stage);
    insert.run("awaiting_packaging", "posting_created");
    insert.run("cancelled", "cancelled");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${orderStatusSqlMysql("awaiting_deliver")}`).get().n, 3);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${orderStatusSqlMysql("awaiting_packaging")}`).get().n, 1);
  } finally {
    db.close();
  }
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
    mysqlQuery: async (sql) => sql.includes("FROM orders o") ? [order] : [{ id: 11, quantity: 1, order_product_id: 101 }],
    mysqlQueryOne: async () => ({ raw_json: "{}" }),
    mysqlExecute: async (sql, params) => { writes.push({ sql, params }); },
    sortRowsByInputMysql: (rows) => rows,
    shippingProductItemsFromRawPayloadMysql: () => [],
    resolveShippingProductIdMysql: () => 101,
    fetchOzonPostingByNumber: async () => posting,
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

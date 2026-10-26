import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildOrderProfitFxDetailSnapshotPayload, orderProfitFxDetailFinalRate } from "../src/services/order-profit-fx-detail.js";
import { refreshOrderProfitDetailSnapshotsMysqlService } from "../src/services/mysql-order-profit-detail-snapshots.js";

const snapshot = (id, rate, day) => ({ id, rate, business_date: day, source_date: day,
  currency_from: "CNY", currency_to: "RUB", source: "cbr" });
const state = { state: "ready", ordered_business_date: "2026-10-25", signed_business_date: "2026-10-26",
  orderFx: snapshot("1", 10, "2026-10-25"), signedFx: snapshot("2", 12.5, "2026-10-26"),
  prices: [{ ozon_sku: "S1", amount: 1000, currency: "RUB" }] };
const order = { id: 7, shop_id: 2, posting_number: "O-7-1", status: "delivered", outcome_type: "delivered_signed", profit_formula_versions: "V2" };
const item = { id: 8, ozon_sku: "S1", quantity: 1, sale_price: 100, estimated_profit: 50,
  frozen_purchase_cost: 40, frozen_domestic_shipping: 0, frozen_international_shipping: 5,
  estimated_commission: 4, sale_amount_cny: 80, purchase_cost_cny: 40, domestic_shipping_cny: 0,
  international_shipping_cny: 5, packaging_cost_cny: 0, commission_fee_cny: 4,
  other_fee_cny: 1, ozon_service_fee_cny: 0, return_loss_cny: 0, advertising_cost_cny: 0,
  net_profit_cny: 30, actual_profit: 30, profit_status: "accrued", settlement_state: "accrued", lock_reason: "finance_accrued_signed_day_fx" };
const finance = [{ service_type: "sale_commission", amount: -50, amount_cny: -5, accruals_for_sale_cny: 100 }];
const baseline = { ...item, sale_amount_cny: 100, net_profit_cny: 50 };
const firstRevision = { formula_version: "V2", layer: "estimate", revision_no: 1, inputs: { estimate: { fxPending: false } },
  outputs: { estimated_profit: 50, estimated_breakdown: baseline } };
const versions = { items: [{ order_item_id: item.id, revisions: [firstRevision] }] };
const build = (items = [item], fx = state, rows = finance, options = {}) => buildOrderProfitFxDetailSnapshotPayload(order, items, rows, fx,
  { calculationVersions: versions, ...options });
const row = (payload, key) => payload.detailRows.find(entry => entry.key === key);

test("V2 detail shows committed signed-day projection and does not recompute old finance CNY", () => {
  const payload = build();
  assert.equal(payload.actual_profit_ready, 1);
  assert.equal(payload.actual_profit_cny, 30);
  assert.equal(payload.actual_cost_total_cny, 50);
  assert.equal(payload.summary.actualProfit, 30);
  assert.equal(row(payload, "commission").actual, 4);
  assert.equal(row(payload, "international").actual, 5);
  assert.equal(row(payload, "sale").estimated, 100);
  assert.equal(row(payload, "sale").actual, 80);
  assert.equal(row(payload, "profit").estimated, 50);
  assert.equal(row(payload, "profit").diff, -20);
  assert.equal(payload.financeTotals.commission, 4);
});

test("legitimate zero actual profit and zero settled costs remain exact", () => {
  const zeroBaseline = { ...firstRevision, outputs: { estimated_profit: 0,
    estimated_breakdown: { ...baseline, purchase_cost_cny: 90, net_profit_cny: 0 } } };
  const payload = build([{ ...item, purchase_cost_cny: 70, international_shipping_cny: 5, net_profit_cny: 0,
    actual_profit: 0, commission_fee_cny: 4, other_fee_cny: 1, estimated_profit: 0 }], state, finance,
  { calculationVersions: { items: [{ order_item_id: item.id, revisions: [zeroBaseline] }] } });
  assert.equal(payload.actual_profit_ready, 1);
  assert.equal(payload.actual_profit_cny, 0);
  assert.equal(row(payload, "domestic").actual, 0);
  assert.equal(row(payload, "profit").estimated, 0);
});

test("the first nonpending estimate breakdown survives later estimates and current actual cost changes", () => {
  const later = { ...firstRevision, revision_no: 3, outputs: { estimated_profit: 999,
    estimated_breakdown: { ...baseline, purchase_cost_cny: 1, net_profit_cny: 999 } } };
  const earliestReady = { ...firstRevision, revision_no: 2 };
  const pending = { ...firstRevision, revision_no: 1, inputs: { estimate: { fxPending: true } } };
  const payload = build([{ ...item, estimated_profit: 999, frozen_purchase_cost: 1, purchase_cost_cny: 1 }], state, finance,
    { calculationVersions: { items: [{ order_item_id: item.id, revisions: [later, pending, earliestReady] }] } });
  assert.equal(row(payload, "purchase").estimated, 40);
  assert.equal(row(payload, "purchase").actual, 1);
  assert.equal(row(payload, "profit").estimated, 50);
  assert.equal(payload.estimated_cost_total_cny, 50);
  assert.equal(payload.estimated_breakdown_ready, true);
});

test("missing first breakdown leaves estimate fees unknown rather than substituting actual or a later revision", () => {
  const withoutBreakdown = { ...firstRevision, outputs: { estimated_profit: 50 } };
  const later = { ...firstRevision, revision_no: 2 };
  const payload = build([item], state, finance,
    { calculationVersions: { items: [{ order_item_id: item.id, revisions: [later, withoutBreakdown] }] } });
  assert.equal(payload.estimated_breakdown_ready, false);
  assert.equal(payload.estimated_profit_cny, 50);
  assert.equal(payload.estimated_cost_total_cny, null);
  assert.equal(row(payload, "purchase").estimated, null);
  assert.match(row(payload, "purchase").estimatedText, /未留存/);
  assert.equal(row(payload, "purchase").diff, null);
  assert.equal(row(payload, "purchase").actual, 40);
  assert.equal(payload.actual_profit_cny, 30);
});

test("truncated history cannot pretend its earliest retained estimate was the initial baseline", () => {
  const truncatedRecord = { order_item_id: item.id, truncated: true, revisions: [{ ...firstRevision, revision_no: 10 }] };
  const missing = build([item], state, finance, { calculationVersions: { items: [truncatedRecord] } });
  assert.equal(missing.estimated_profit_cny, null);
  assert.equal(row(missing, "profit").estimatedText, "未留存完整预估依据");
  const present = build([item], state, finance,
    { calculationVersions: { items: [{ ...truncatedRecord, first_estimate_revision: firstRevision }] } });
  assert.equal(present.estimated_breakdown_ready, true);
  assert.equal(row(present, "purchase").estimated, 40);
});

test("an incomplete archived breakdown does not fill gaps from current settlement values", () => {
  const incomplete = { ...firstRevision, outputs: { estimated_profit: 50,
    estimated_breakdown: { ...baseline, packaging_cost_cny: null } } };
  const payload = build([item], state, finance,
    { calculationVersions: { items: [{ order_item_id: item.id, revisions: [incomplete] }] } });
  assert.equal(payload.estimated_breakdown_ready, false);
  assert.equal(row(payload, "packaging").estimated, null);
  assert.equal(row(payload, "packaging").actual, 0);
  assert.equal(row(payload, "costTotal").estimated, 50);
  assert.match(row(payload, "costTotal").note, /首次预估销售额减首次预估利润/);
});

test("V2 cache skips unknown required estimate totals while leaving live actual detail readable", async () => {
  const writes = [];
  const payload = build([item], state, finance, { calculationVersions: {} });
  assert.equal(payload.actual_profit_cny, 30);
  assert.equal(row(payload, "purchase").estimated, null);
  const result = await refreshOrderProfitDetailSnapshotsMysqlService({
    tenantOrderSql: "o.shop_id=2", normalizeDate: value => value || "", query: async () => [{ id: order.id }],
    orderDetail: async () => ({ order, items: [item], finance, profit_detail_snapshot: payload }),
    buildPayload: () => { throw Error("legacy called"); }, execute: async () => writes.push(true)
  }, { order_ids: [order.id] });
  assert.equal(result.skipped, 1);
  assert.equal(result.refreshed, 0);
  assert.equal(writes.length, 0);
});

test("V2 cache can store proven original totals while preserving unknown cost lines", async () => {
  const incomplete = { ...firstRevision, outputs: { estimated_profit: 50,
    estimated_breakdown: { ...baseline, packaging_cost_cny: null } } };
  const payload = build([item], state, finance,
    { calculationVersions: { items: [{ order_item_id: item.id, revisions: [incomplete] }] } });
  const writes = [];
  await refreshOrderProfitDetailSnapshotsMysqlService({
    tenantOrderSql: "o.shop_id=2", normalizeDate: value => value || "", query: async () => [{ id: order.id }],
    orderDetail: async () => ({ order, items: [item], finance, profit_detail_snapshot: payload }),
    execute: async (sql, parameters) => writes.push(parameters), normalizeDateTime: value => value
  }, { order_ids: [order.id] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][7], 50);
  const rows = JSON.parse(writes[0][15]);
  assert.equal(rows.find(entry => entry.key === "packaging").estimated, null);
  assert.match(rows.find(entry => entry.key === "packaging").estimatedText, /未留存/);
});

test("partial/unverified V2 settlement never becomes actual through legacy terminal fallbacks", () => {
  for (const pending of [
    { ...item, profit_status: "estimated", settlement_state: "pending" },
    { ...item, lock_reason: "finance_accrued" },
    { ...item, international_shipping_cny: null }
  ]) {
    const payload = buildOrderProfitFxDetailSnapshotPayload({ ...order, status: "cancelled", outcome_type: "cancelled_pre_fulfillment" }, [pending], finance, state);
    assert.equal(payload.actual_profit_ready, 0);
    assert.equal(payload.actual_profit_cny, null);
    assert.equal(payload.actual_cost_total_cny, null);
    assert.ok(payload.detailRows.every(entry => entry.actual === null && entry.diff === null));
  }
});

test("missing signed archive, unknown original currency or pending bill stays explicit", () => {
  assert.equal(build([item], { ...state, signedFx: null }).actual_profit_ready, 0);
  assert.equal(build([item], { ...state, state: "awaiting_signed_rate" }).actual_profit_ready, 0);
  assert.equal(build([item], state, finance, { financeErrorCode: "FX_FINANCE_CURRENCY_UNKNOWN" }).actual_profit_ready, 0);
  assert.equal(build([item], { ...state, last_error_code: "ORDER_PROFIT_FINAL_BILL_INCOMPLETE" }).actual_profit_ready, 0);
  assert.equal(build([{ ...item, settlement_state: "pending" }], { ...state, prices: [{ ozon_sku: "S1", amount: null, currency: "" }] }).actual_profit_cny, null);
  assert.equal(build([item], state, []).actual_profit_ready, 0);
  assert.equal(orderProfitFxDetailFinalRate(order, state).id, "2");
  assert.equal(orderProfitFxDetailFinalRate({ ...order, outcome_type: "cancelled_pre_fulfillment" }, { ...state, signedFx: null }).id, "1");
});

test("a verified no-delivery cancellation preserves its legitimate zero actual loss", () => {
  const cancelled = { ...order, status: "cancelled", outcome_type: "cancelled_pre_fulfillment" };
  const zero = { ...item, sale_amount_cny: 0, purchase_cost_cny: 0, domestic_shipping_cny: 0,
    international_shipping_cny: 0, packaging_cost_cny: 0, commission_fee_cny: 0,
    other_fee_cny: 0, ozon_service_fee_cny: 0, return_loss_cny: 0, advertising_cost_cny: 0,
    net_profit_cny: 0, actual_profit: 0, lock_reason: "finance_accrued_no_delivery_order_day_fx" };
  const payload = buildOrderProfitFxDetailSnapshotPayload(cancelled, [zero], [{ amount_cny: 0 }],
    { ...state, signedFx: null, signed_business_date: null }, { calculationVersions: versions });
  assert.equal(payload.actual_profit_ready, 1);
  assert.equal(payload.actual_profit_cny, 0);
  assert.equal(row(payload, "sale").actual, 0);
  assert.equal(row(payload, "costTotal").actual, 0);
});

test("no-delivery lock cannot bypass the signed-day requirement or claim the wrong settlement basis", () => {
  const noSigned = { ...state, signedFx: null, signed_business_date: null };
  const noDeliveryItem = { ...item, lock_reason: "finance_accrued_no_delivery_order_day_fx" };
  const delivered = build([noDeliveryItem], noSigned);
  assert.equal(delivered.actual_profit_ready, 0);
  assert.equal(delivered.actual_profit_cny, null);
  const wrongBasis = buildOrderProfitFxDetailSnapshotPayload({ ...order, status: "cancelled", outcome_type: "cancelled_pre_fulfillment" },
    [item], finance, noSigned, { calculationVersions: versions });
  assert.equal(wrongBasis.actual_profit_ready, 0);
  const alreadySigned = buildOrderProfitFxDetailSnapshotPayload({ ...order, status: "cancelled", outcome_type: "cancelled_pre_fulfillment" },
    [noDeliveryItem], finance, state, { calculationVersions: versions });
  assert.equal(alreadySigned.actual_profit_ready, 0);
});

test("V2 cache refresh reuses the verified detail snapshot rather than rebuilding legacy amounts", async () => {
  const writes = [];
  const payload = build();
  await refreshOrderProfitDetailSnapshotsMysqlService({
    tenantOrderSql: "o.shop_id=2", normalizeDate: value => value || "", chinaDateSql: value => value,
    query: async () => [{ id: order.id }],
    orderDetail: async () => ({ order, items: [item], finance, profit_detail_snapshot: payload }),
    buildPayload: () => { throw Error("legacy V2 rebuild must not run"); },
    execute: async (sql, parameters) => writes.push({ sql, parameters }), normalizeDateTime: value => value
  }, { order_ids: [order.id] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].parameters[8], 30);
  assert.equal(writes[0].parameters[10], 50);
  assert.equal(writes[0].parameters[13], 1);
  assert.equal(JSON.parse(writes[0].parameters[14]).actualProfit, 30);
});

test("V2 cache refresh refuses to fall back when verified detail is missing", async () => {
  await assert.rejects(refreshOrderProfitDetailSnapshotsMysqlService({
    tenantOrderSql: "o.shop_id=2", normalizeDate: value => value || "", query: async () => [{ id: order.id }],
    orderDetail: async () => ({ order, items: [item], finance }), buildPayload: () => { throw Error("legacy called"); }
  }, { order_ids: [order.id] }), /verified order detail projection/);
});

test("order detail routes V2 through frozen original finance while keeping the V1 builder", () => {
  const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const detail = source.slice(source.indexOf("export async function orderDetailMysql("), source.indexOf("const CUSTOMER_MESSAGE_TYPES"));
  assert.match(detail, /readOrderFxFinanceRows\(/);
  assert.match(detail, /rateRubPerCny: finalRate\.rate, allocationRateRubPerCny: profitFx\.orderFx\.rate/);
  assert.match(detail, /else finance = await orderDetailFinanceMysql\(order, items\)/);
  assert.match(detail, /buildOrderProfitFxDetailSnapshotPayload\(order, items, finance, profitFx/);
  assert.match(detail, /\{ financeErrorCode, calculationVersions \}/);
  assert.match(detail, /: buildOrderProfitDetailSnapshotPayload\(order, items, finance\)/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { convertFxFinanceRows, readOrderFxFinanceRows } from "../src/services/order-profit-fx-finance.js";
import { normalizeOzonFinanceAccrual } from "../src/services/ozon-finance-accruals.js";
import { fxSettlementInputFingerprint, planOrderFxSettlement } from "../src/services/order-profit-fx-settlement.js";

const snapshot = (id, day, rate) => ({ id, rate, business_date: day, source_date: day, source: "cbr", currency_from: "CNY", currency_to: "RUB" });
const state = () => ({ ordered_business_date: "2026-10-26", signed_business_date: "2026-10-28",
  orderFx: snapshot(1, "2026-10-26", 10), signedFx: snapshot(2, "2026-10-28", 12.5),
  prices: [{ ozon_sku: "100", amount: 1000, currency: "RUB" }] });
const items = () => [{ id: 1, ozon_sku: "100", quantity: 1, purchase_cost_cny: 20, domestic_shipping_cny: 2, advertising_cost_cny: 0 }];
const rows = () => [
  { id: 1, shop_id: 9, posting_number: "123-1", operation_id: "sale", service_type: "commission", amount: -100, accruals_for_sale: 1000, currency_code: "RUB" },
  { id: 2, shop_id: 9, posting_number: "123-1", operation_id: "collect", service_type: "collecting_fee", amount: -10, accruals_for_sale: 0, currency_code: "RUB" },
  { id: 3, shop_id: 9, posting_number: "123-1", operation_id: "delivery", service_type: "platform_delivery", amount: -90, accruals_for_sale: 0, currency_code: "RUB" }
];
const finance = (raw, rate = 12.5) => convertFxFinanceRows(raw, { shopId: 9, rateRubPerCny: rate });
const input = (extra = {}) => ({ order: { id: 1, status: "delivered" }, items: items(), fxState: state(), finance: finance(rows()),
  initialEstimates: new Map([[1, 50]]), classifyCategory: row => row.service_type,
  packagingFeeForSaleAmount: async () => 3, accounting: { outcome_type: "delivered_signed", loss_profile_code: "none" }, ...extra });

async function dailyFinance(grossEvents, extraRows = []) {
  const dictionary = [{ id: 1, name: "SaleCommission" }, { id: 2, name: "Acquiring" }, { id: 3, name: "RfbsGlobalDelivery" }];
  const money = amount => ({ amount: String(amount), currency: "RUB" });
  const source = [...grossEvents.map((amount, index) => ({ accrual_id: 1000 + index, date: "2026-10-28", unit_number: "12345678-0042-1",
    accrued_category: "POSTING", total_amount: money(amount), posting: { products: [{ sku: "100", quantity: 1, commission: { sale_amount: money(amount) } }] } })),
  ...[-100, -10, -90].map((amount, index) => ({ accrual_id: 2000 + index, date: "2026-10-28", unit_number: "12345678-0042-1",
    accrued_category: "NON_ITEM", total_amount: money(amount), non_item_fee: { type_id: index + 1, accrued: money(amount) } }))];
  let id = 0;
  const persisted = source.flatMap(raw => {
    const operation = normalizeOzonFinanceAccrual(raw, { types: dictionary });
    assert.equal(operation.reconciliation.ok, true);
    return operation.rows.map(row => ({ ...row, id: ++id, shop_id: 9, posting_number: operation.posting_number,
      operation_id: operation.operation_id, raw_json: operation.raw_json }));
  });
  return readOrderFxFinanceRows({ query: async () => [...persisted, ...extraRows], order: { shop_id: 9, posting_number: "12345678-0042-1", order_number: "12345678-0042" },
    rateRubPerCny: 12.5, classifyCategory: row => row.service_type.split(":")[1] });
}

test("signed-day actual uses complete final original amounts and distinguishes FX from changed business costs", async () => {
  const result = await planOrderFxSettlement(input());
  assert.equal(result.ok, true);
  const item = result.items[0];
  assert.equal(item.actualProfit, 39);
  assert.equal(item.attribution.actual_profit_at_order_rate_cny, 55);
  assert.equal(item.attribution.fx_gain_loss_cny, -16);
  assert.equal(item.attribution.business_variance_cny, 5);
  assert.equal(item.attribution.total_variance_cny, -11);
  assert.equal(item.attribution.settlement_basis, "signed_day");
  assert.equal(item.purchaseCost + item.domesticShipping + item.packagingCost, 25);
});

test("separate daily-accrual income events are summed once and use the same original facts for FX attribution", async () => {
  const financial = await dailyFinance([1000, 200]);
  assert.equal(financial.income_mode, "signed_accruals");
  assert.equal(financial.sale_accrual_cny, 96);
  assert.equal(financial.income_rows.length, 2);
  const result = await planOrderFxSettlement(input({ finance: financial, classifyCategory: row => row.service_type.split(":")[1] }));
  assert.equal(result.ok, true);
  assert.equal(result.items[0].actualProfit, 55);
  assert.equal(result.items[0].actualNetAmounts.filter(row => row.role === "sale").length, 2);
  assert.equal(result.items[0].attribution.fx_gain_loss_cny, -20);
  assert.equal(result.items[0].attribution.business_variance_cny, 25);
});

test("a negative daily income event reduces revenue instead of being made positive or ignored", async () => {
  const financial = await dailyFinance([1000, -200]);
  assert.equal(financial.sale_accrual_cny, 64);
  const result = await planOrderFxSettlement(input({ finance: financial, classifyCategory: row => row.service_type.split(":")[1] }));
  assert.equal(result.ok, true);
  assert.equal(result.items[0].actualProfit, 23);
  assert.equal(result.items[0].actualNetAmounts.find(row => row.role === "sale" && row.amount < 0).amount, -200);
  assert.equal(result.items[0].attribution.fx_gain_loss_cny, -12);
  assert.equal(result.items[0].attribution.business_variance_cny, -15);
});

test("fully offset daily income remains an explicit known zero rather than a missing sale basis", async () => {
  const financial = await dailyFinance([1000, -1000]);
  assert.equal(financial.sale_accrual_cny, 0);
  const result = await planOrderFxSettlement(input({ finance: financial, classifyCategory: row => row.service_type.split(":")[1] }));
  assert.equal(result.ok, true);
  assert.equal(result.items[0].itemSale, 0);
  assert.equal(result.items[0].actualProfit, -41);
});

test("mixed legacy and daily facts for the same posting stay pending instead of being counted twice", async () => {
  const financial = await dailyFinance([1000], [{ id: 99, shop_id: 9, posting_number: "12345678-0042-1", operation_id: "legacy-operation",
    service_type: "sale_commission", amount: -100, accruals_for_sale: 1000, currency_code: "RUB", raw_json: "{}" }]);
  assert.equal(financial.ok, false);
  assert.equal(financial.code, "FX_FINANCE_SOURCE_MIXED");
  const result = await planOrderFxSettlement(input({ finance: financial }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "FX_FINANCE_SOURCE_MIXED");
  assert.deepEqual(result.items, []);
});

test("CNY receipts and fees are not converted again and contribute zero FX", async () => {
  const cnyRows = rows().map(row => ({ ...row, amount: row.amount / 10, accruals_for_sale: row.accruals_for_sale / 10, currency_code: "CNY" }));
  const result = await planOrderFxSettlement(input({ finance: finance(cnyRows) }));
  assert.equal(result.ok, true);
  assert.equal(result.items[0].actualProfit, 55);
  assert.equal(result.items[0].attribution.fx_gain_loss_cny, 0);
  assert.equal(result.items[0].attribution.business_variance_cny, 5);
});

test("mixed actual currencies value the same used facts at both archived rates", async () => {
  const mixed = rows();
  mixed[0] = { ...mixed[0], amount: -8, accruals_for_sale: 0, currency_code: "CNY" };
  mixed.push({ ...mixed[0], id: 4, operation_id: "gross", service_type: "other", amount: 0, accruals_for_sale: 1000, currency_code: "RUB" });
  mixed[1] = { ...mixed[1], amount: -1, currency_code: "CNY" };
  const result = await planOrderFxSettlement(input({ finance: finance(mixed) }));
  assert.equal(result.ok, true);
  assert.equal(result.items[0].actualProfit, 38.8);
  assert.equal(result.items[0].attribution.fx_gain_loss_cny, -18.2);
  assert.equal(result.items[0].attribution.business_variance_cny, 7);
});

test("missing bill fields, initial estimate, signature evidence, active order and unknown currency stay pending", async () => {
  const noCollecting = await planOrderFxSettlement(input({ finance: finance(rows().filter(row => row.service_type !== "collecting_fee")) }));
  assert.equal(noCollecting.code, "ORDER_PROFIT_FINAL_BILL_INCOMPLETE");
  const noEstimate = await planOrderFxSettlement(input({ initialEstimates: new Map() }));
  assert.equal(noEstimate.code, "ORDER_PROFIT_INITIAL_ESTIMATE_PENDING");
  const unsigned = await planOrderFxSettlement(input({ fxState: { ...state(), signedFx: null } }));
  assert.equal(unsigned.code, "ORDER_PROFIT_SIGNED_FX_PENDING");
  const active = await planOrderFxSettlement(input({ accounting: { outcome_type: "active" } }));
  assert.equal(active.code, "ORDER_PROFIT_TERMINAL_STATUS_PENDING");
  const unknown = await planOrderFxSettlement(input({ finance: { ok: false, code: "FX_FINANCE_CURRENCY_UNKNOWN" } }));
  assert.equal(unknown.code, "FX_FINANCE_CURRENCY_UNKNOWN");
  for (const result of [noCollecting, noEstimate, unsigned, active, unknown]) assert.deepEqual(result.items, []);
});

test("a no-delivery cancellation uses its order-day archive and never fabricates a signing date", async () => {
  const cancelled = state();
  cancelled.signedFx = null;
  cancelled.signed_business_date = null;
  const result = await planOrderFxSettlement(input({ fxState: cancelled, finance: finance(rows(), 10),
    accounting: { outcome_type: "cancelled_pre_fulfillment", loss_profile_code: "none" }, initialEstimates: new Map([[1, 0]]) }));
  assert.equal(result.ok, true);
  assert.equal(result.settlementBasis, "no_delivery_order_day");
  assert.equal(result.items[0].actualProfit, -1);
  assert.equal(result.items[0].attribution.fx_gain_loss_cny, 0);
  assert.equal(result.items[0].purchaseCost, 0);
  assert.equal(result.items[0].packagingCost, 0);
});

test("late fees keep the signed pin while updating only actual inputs and preserving the first estimate baseline", async () => {
  const before = await planOrderFxSettlement(input());
  const later = rows();
  later.push({ ...later[2], id: 4, operation_id: "late", service_type: "other", amount: -25 });
  const after = await planOrderFxSettlement(input({ finance: finance(later) }));
  assert.equal(after.finalFx.id, before.finalFx.id);
  assert.equal(after.items[0].actualProfit, before.items[0].actualProfit - 2);
  assert.equal(after.items[0].attribution.initial_estimated_profit_cny, 50);
  assert.equal(after.items[0].attribution.fx_gain_loss_cny, -15.5);
});

test("a refunded income anchor is not counted again as a platform fee", async () => {
  const raw = [...rows(), { id: 4, shop_id: 9, posting_number: "123-1", operation_id: "refund", service_type: "income", amount: -1000, accruals_for_sale: -1000, currency_code: "RUB" }];
  const result = await planOrderFxSettlement(input({ finance: finance(raw), accounting: { outcome_type: "after_delivery_return", loss_profile_code: "purchase_collecting_international" } }));
  assert.equal(result.ok, true);
  assert.equal(result.categoryTotals.income, 80);
  assert.equal(result.items[0].totalFinanceFeeCny, 16);
});

test("finance integration branches before unchanged V1 arithmetic and records pending/immutable baseline evidence", () => {
  const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const apply = source.slice(source.indexOf("async function applyOzonFinanceToOrdersMysql("), source.indexOf("export async function syncOzonFinanceMysql("));
  assert.ok(apply.indexOf('if (itemVersions.some(usesDailyProfitFx))') < apply.indexOf("const financeRows = await orderFinanceRowsWithParentAllocationMysql"));
  assert.match(apply, /inputs\?\.estimate\?\.fxPending/);
  assert.match(apply, /ORDER BY order_item_id, revision_no/);
  assert.match(apply, /uses_estimated_collecting: false/);
  assert.match(apply, /fx_attribution: projection.attribution/);
  assert.match(apply, /formulaVersion !== itemVersions\[0\]/);
  assert.match(apply, /fx_pending: fxPending/);
});

test("validation fingerprints include all item weights but only the target's cost and actual revision", () => {
  const first = { ...items()[0], formula_version: "V2", current_actual_revision_id: 10 };
  const second = { ...first, id: 2, ozon_sku: "101", current_actual_revision_id: 20 };
  const input = { order: { order_id: 1, shop_id: 9, order_status: "delivered", ordered_at: "2026-10-26T00:00:00Z" },
    items: [first, second], targetItemId: 2, fxState: state(), finance: finance(rows()) };
  const fingerprint = fxSettlementInputFingerprint(input);
  assert.equal(fxSettlementInputFingerprint({ ...input, items: [{ ...first, current_actual_revision_id: 11, purchase_cost_cny: 0 }, second] }), fingerprint);
  assert.notEqual(fxSettlementInputFingerprint({ ...input, items: [{ ...first, quantity: 2 }, second] }), fingerprint);
  assert.notEqual(fxSettlementInputFingerprint({ ...input, items: [first, { ...second, purchase_cost_cny: 25 }] }), fingerprint);
  assert.notEqual(fxSettlementInputFingerprint({ ...input, items: [first, { ...second, current_actual_revision_id: 21 }] }), fingerprint);
});

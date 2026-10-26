import test from "node:test";
import assert from "node:assert/strict";
import { attributeOrderProfitFx, moneyToCny, validateDailyFxSnapshot } from "../src/services/profit-formulas/v2/fx.js";
import * as v2 from "../src/services/profit-formulas/v2/profit.js";
import * as v2Aggregation from "../src/services/profit-formulas/v2/aggregation.js";
import * as v1 from "../src/services/profit-formulas/v1/profit.js";
import * as v1Aggregation from "../src/services/profit-formulas/v1/aggregation.js";
import * as v2Outcome from "../src/services/profit-formulas/v2/order-outcome.js";
import * as v1Outcome from "../src/services/profit-formulas/v1/order-outcome.js";

const snapshot = (rate = 10, businessDate = "2026-10-25") => ({
  id: "1", business_date: businessDate, source_date: businessDate, rate,
  currency_from: "CNY", currency_to: "RUB", source: "CBR"
});
const attribute = (overrides = {}) => attributeOrderProfitFx({
  initialEstimatedProfitCny: 50, actualNetAmounts: [{ amount: 1000, currency: "RUB" }],
  actualCnyCost: 50, orderFx: snapshot(10), signedFx: snapshot(12.5, "2026-10-26"), ...overrides
});

test("same RUB net and CNY costs isolate the signed-day FX loss", () => {
  assert.deepEqual(attribute(), {
    initial_estimated_profit_cny: 50, actual_profit_at_order_rate_cny: 50,
    actual_profit_at_signed_rate_cny: 30, fx_gain_loss_cny: -20,
    business_variance_cny: 0, rounding_difference_cny: 0, total_variance_cny: -20
  });
});

test("mixed fees separate business changes from FX without converting CNY costs twice", () => {
  const result = attribute({ actualNetAmounts: [
    { amount: 1000, currency: "RUB" }, { amount: -70, currency: "RUB" }, { amount: -30, currency: "RUB" }
  ], actualCnyCost: 55 });
  assert.equal(result.actual_profit_at_order_rate_cny, 35);
  assert.equal(result.actual_profit_at_signed_rate_cny, 17);
  assert.equal(result.fx_gain_loss_cny, -18);
  assert.equal(result.business_variance_cny, -15);
  assert.equal(result.total_variance_cny, -33);
});

test("CNY proceeds and expenses are invariant under RUB FX changes", () => {
  const result = attribute({ initialEstimatedProfitCny: 35, actualNetAmounts: [
    { amount: 100, currency: "CNY" }, { amount: -15, currency: "CNY" }
  ] });
  assert.equal(result.fx_gain_loss_cny, 0);
  assert.equal(result.actual_profit_at_signed_rate_cny, 35);
  assert.equal(moneyToCny(17.123456, "CNY"), 17.123456);
});

test("conversion keeps precision until the total is rounded", () => {
  assert.equal(moneyToCny(1, "RUB", snapshot(3)), 1 / 3);
  const result = attribute({ initialEstimatedProfitCny: 0, actualCnyCost: 0, orderFx: snapshot(3),
    signedFx: snapshot(3, "2026-10-26"), actualNetAmounts: Array.from({ length: 3 }, () => ({ amount: 1, currency: "RUB" })) });
  assert.equal(result.actual_profit_at_signed_rate_cny, 1);
});

test("rounding residual reconciles the saved estimate and rounded actual exactly", () => {
  const result = attribute({ initialEstimatedProfitCny: 1, actualCnyCost: 0.01,
    actualNetAmounts: [{ amount: 3, currency: "RUB" }], orderFx: snapshot(11.32), signedFx: snapshot(12.3869, "2026-10-26") });
  assert.equal(result.rounding_difference_cny, -0.01);
  assert.equal(Math.round(result.total_variance_cny * 100), Math.round(result.fx_gain_loss_cny * 100)
    + Math.round(result.business_variance_cny * 100) + Math.round(result.rounding_difference_cny * 100));
});

test("missing, unsupported or ambiguous currency never defaults to RUB", () => {
  for (const currency of [undefined, null, "", " ", "USD", "EUR"]) {
    assert.throws(() => moneyToCny(10, currency, snapshot()), { code: "ORDER_PROFIT_FX_INVALID" });
  }
  assert.throws(() => moneyToCny(10, "RUB"), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.throws(() => moneyToCny(null, "CNY"), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.throws(() => moneyToCny(true, "CNY"), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.throws(() => moneyToCny(Number.MAX_VALUE, "RUB", snapshot(Number.MIN_VALUE)), { code: "ORDER_PROFIT_FX_INVALID" });
});

test("only a valid dated archived CNY to RUB quote is accepted", () => {
  for (const overrides of [
    { id: null }, { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { rate: null }, { rate: 0 }, { rate: -1 },
    { rate: Infinity }, { source: "" }, { currency_from: "RUB", currency_to: "CNY" },
    { source_date: "2026-10-26" }, { business_date: "2026-02-30" }, { business_date: "2026-10-25T00:00:00Z" }
  ]) assert.throws(() => validateDailyFxSnapshot({ ...snapshot(), ...overrides }), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.throws(() => validateDailyFxSnapshot(snapshot(), { businessDate: "2026-10-26" }), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.equal(validateDailyFxSnapshot({ ...snapshot(), source_date: "2026-10-23" }).source_date, "2026-10-23");
});

test("attribution refuses missing net amounts and a signed date before the order", () => {
  assert.throws(() => attribute({ actualNetAmounts: [] }), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.throws(() => attribute({ signedFx: snapshot(12.5, "2026-10-24") }), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.throws(() => attribute({ initialEstimatedProfitCny: null }), { code: "ORDER_PROFIT_FX_INVALID" });
});

test("validation and attribution never mutate archived snapshots or actual rows", () => {
  const ordered = Object.freeze(snapshot());
  const signed = Object.freeze(snapshot(12.5, "2026-10-26"));
  const rows = Object.freeze([Object.freeze({ amount: 1000, currency: "RUB" })]);
  assert.equal(attribute({ orderFx: ordered, signedFx: signed, actualNetAmounts: rows }).fx_gain_loss_cny, -20);
  assert.notEqual(validateDailyFxSnapshot(ordered), ordered);
  assert.equal(ordered.rate, 10);
});

const estimateInput = () => ({
  salePrice: 100, quantity: 2, orderBusinessDate: "2026-10-25", fx: snapshot(10),
  product: { purchase_cost: 15, domestic_shipping: 1, international_shipping: 3,
    handling_fee: 0.5, exchange_rate: 999, return_rate: 0, withdrawal_fee_rate: 0,
    advertising_rate: 0, pricing_effective_at: "2026-10-24 16:00:00" },
  mapping: { commission_low: 0.12, commission_high: 0.17 }
});

test("V2 estimate uses only the pinned order-day rate and frozen V1 cost math", () => {
  const input = estimateInput();
  const original = structuredClone(input);
  assert.deepEqual(v2.estimateItemProfit(input), v1.estimateItemProfit({ ...input, product: { ...input.product, exchange_rate: 10 } }));
  assert.deepEqual(input, original);
  assert.deepEqual(v2.estimateItemProfit({ ...input, product: { ...input.product, pricing_effective_at: undefined } }),
    v2.estimateItemProfit({ ...input, product: { ...input.product, pricing_effective_at: "2026-10-25" } }));
  assert.deepEqual(v2.estimateItemProfit({ ...input, product: { ...input.product, pricing_effective_at: new Date("2026-10-24T16:00:00Z") } }), v2.estimateItemProfit(input));
});

test("V2 rejects wrong date or non-CNY estimate amounts instead of guessing", () => {
  assert.throws(() => v2.estimateItemProfit({ ...estimateInput(), orderBusinessDate: undefined }), /orderBusinessDate/);
  assert.throws(() => v2.estimateItemProfit({ ...estimateInput(), fx: snapshot(12.5, "2026-10-26") }), { code: "ORDER_PROFIT_FX_INVALID" });
  assert.throws(() => v2.estimateItemProfit({ ...estimateInput(), salePriceCurrency: "RUB" }), /CNY/);
  assert.throws(() => v2.estimateItemProfit({ ...estimateInput(), product: { ...estimateInput().product, pricing_effective_at: "2026-10-26" } }), /下单日/);
});

test("original RUB pricing preserves commission threshold despite rounded CNY conversion", () => {
  const input = { ...estimateInput(), salePrice: 121.1, fx: snapshot(12.3869), pricingAmountRub: 1500 };
  assert.equal(v2.estimateItemProfit(input).commissionRate, 0.12);
  assert.equal(v2.estimateItemProfit({ ...input, pricingAmountRub: 1500.01 }).commissionRate, 0.17);
  assert.equal(v2.estimateItemProfit(input).commissionSource, "fallback");
  const raw = { ...input, mapping: { commissions_json: JSON.stringify([{ sale_schema: "fbs", percent: 18 }]), sale_schema: "fbs" } };
  assert.equal(v2.estimateItemProfit(raw).commissionRate, 0.18);
  assert.equal(v2.estimateItemProfit(raw).commissionSource, "ozon");
});

test("V2 aggregation accepts already converted CNY finance fields without a second FX step", () => {
  const fields = { terminalNoRevenue: false, itemSale: 80, purchaseCost: 40, domesticShipping: 2,
    actualInternationalShipping: 3, packagingCost: 1, commissionFeeCny: 4,
    actualServiceFeeCny: 1, returnLoss: 0, advertisingCost: 0, otherFee: 0 };
  assert.deepEqual(v2Aggregation.aggregateActualProfit(fields), v1Aggregation.aggregateActualProfit(fields));
  assert.equal(v2Aggregation.aggregateActualProfit(fields).actualProfit, 29);
  assert.equal(v2Aggregation.aggregateActualProfit({ ...fields, terminalNoRevenue: true }).actualProfit, -51);
  assert.equal(v2Aggregation.aggregateEstimatedProfit, v1Aggregation.aggregateEstimatedProfit);
  assert.equal(v2Outcome.classifyOrderAccounting, v1Outcome.classifyOrderAccounting);
});

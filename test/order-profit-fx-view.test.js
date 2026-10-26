import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dailyFxEvidenceRows, dailyFxPendingText, fxAttributionRows } from "../frontend/orders/utils/profit-calculation-versions.js";
import { shanghaiDateText } from "../frontend/admin/utils/shanghai-date.js";

const fx = {
  ordered_business_date: "2026-10-25", signed_business_date: "2026-10-26", state: "ready",
  orderFx: { id: "41", rate: "10.000000000000", source: "cbr", source_date: "2026-10-23" },
  signedFx: { id: "42", rate: "12.500000000000", source: "cbr", source_date: "2026-10-26" }
};

test("daily FX evidence stays optional for historical orders and identifies both archives", () => {
  assert.deepEqual(dailyFxEvidenceRows(null), []);
  assert.equal(dailyFxPendingText(null), "");
  const dates = [];
  const rows = dailyFxEvidenceRows(fx, (day) => {
    dates.push(day);
    return shanghaiDateText(`${day}T00:00:00+08:00`);
  });
  assert.equal(rows[0].value, "2026-10-25");
  assert.match(rows[1].value, /1 CNY = 10\.000000000000 RUB.*CBR.*#41/);
  assert.equal(rows[2].value, "2026-10-23");
  assert.equal(rows[3].value, "2026-10-26");
  assert.match(rows[4].value, /#42/);
  assert.deepEqual(dates, ["2026-10-25", "2026-10-23", "2026-10-26", "2026-10-26"]);
});

test("pending evidence explains unavailable inputs without showing invented rates or profits", () => {
  const pending = { ...fx, state: "awaiting_order_rate", orderFx: null, signedFx: null, signed_business_date: null };
  assert.match(dailyFxPendingText(pending), /下单日.*预估利润尚未完成/);
  const rows = dailyFxEvidenceRows(pending);
  assert.match(rows[1].value, /未使用固定汇率/);
  assert.equal(rows[3].value, "尚未签收");
  assert.equal(rows[4].value, "签收后冻结");
  assert.match(dailyFxPendingText({ ...pending, state: "awaiting_sale_currency" }), /售价及原币币种/);
  assert.match(dailyFxPendingText({ ...pending, state: "awaiting_signed_rate" }), /真实利润尚未结算/);
  assert.equal(dailyFxPendingText(fx), "");
  assert.match(dailyFxPendingText({ ...fx, last_error_code: "ORDER_PROFIT_FINAL_BILL_INCOMPLETE" }), /完整结算费用尚未齐全/);
  assert.match(dailyFxPendingText({ ...fx, last_error_code: "FX_FINANCE_CURRENCY_UNKNOWN" }), /核对原始账单/);
});

test("only settled actual revisions display saved FX attribution including true zero", () => {
  const revision = { layer: "actual", outputs: { profit_status: "accrued" }, inputs: { fx_attribution: {
    initial_estimated_profit_cny: 50, actual_profit_at_order_rate_cny: 50,
    actual_profit_at_signed_rate_cny: 30, fx_gain_loss_cny: -20,
    business_variance_cny: 0, rounding_difference_cny: 0, total_variance_cny: -20
  } } };
  const rows = fxAttributionRows(revision);
  assert.equal(rows.length, 7);
  assert.equal(rows.find(row => row.label === "汇率波动损益").value, "CNY -20.00");
  assert.equal(rows.find(row => row.label === "业务变化差额").value, "CNY 0.00");
  assert.deepEqual(fxAttributionRows({ ...revision, outputs: { profit_status: "pending" } }), []);
  assert.deepEqual(fxAttributionRows({ ...revision, layer: "estimate" }), []);
  assert.deepEqual(fxAttributionRows({ ...revision, inputs: {} }), []);
});

test("FX UI remains within the existing lazy appendix and preserves the fee comparison table", () => {
  const page = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
  const component = readFileSync(new URL("../frontend/orders/components/ProfitCalculationVersions.vue", import.meta.url), "utf8");
  const table = readFileSync(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");
  const appendix = page.indexOf("<summary>计算依据与版本记录</summary>");
  const fxProp = page.indexOf(':fx="detailDialog.data?.profit_fx || null"');
  assert.ok(appendix > page.indexOf(':data="detailProfit.rows"'));
  assert.ok(fxProp > appendix && fxProp < page.indexOf("</details>", appendix));
  assert.match(page, /v-if="profitVersionsExpanded"/);
  assert.match(component, /<template v-if="fx">/);
  assert.match(component, /fxAttributionRows\(revision\)\.length/);
  assert.match(component, /shanghaiDateText/);
  assert.doesNotMatch(table, /profit_fx|dailyFx|fxAttribution/);
  for (const label of ["预估金额", "真实金额", "差异", "说明"]) assert.ok(page.includes(`label="${label}"`));
});

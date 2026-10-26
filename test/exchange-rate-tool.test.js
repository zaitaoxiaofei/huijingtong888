import assert from "node:assert/strict";
import test from "node:test";
import { getExchangeRateTool, getExchangeRateToday } from "../src/services/exchange-rate-tool.js";

const now = Date.parse("2026-10-26T09:00:00Z");
const scope = { id: 7, isDefault: false, financeAuthorized: true };
const quote = (business_date = "2026-10-26", rate = "12.5", id = "2") => ({ id, business_date, source_date: business_date,
  currency_from: "CNY", currency_to: "RUB", source: "cbr", rate });
const pinned = (prefix, day, id, rate) => Object.fromEntries(Object.entries({ archive_id: id, archive_day: day, source_date: day,
  currency_from: "CNY", currency_to: "RUB", source: "cbr", rate }).map(([key, value]) => [`${prefix}_${key}`, value]));
const fixtureRow = (overrides = {}) => ({ order_item_id: 1, order_id: 10, shop_id: 3, shop_tenant_id: 7, status: "delivered",
  tracking_stage: "delivered", logistics_status: "delivered", delivered_at: "2026-10-25 18:00:00", accrued_at: "2026-10-26 00:00:00",
  ozon_sku: "sku", current_quantity: 2, settlement_state: "accrued", profit_status: "accrued", lock_reason: "finance_accrued_signed_day_fx",
  calc_tenant_key: "7", fx_tenant_key: "7", formula_version: "V2", legacy_baseline: 0, current_actual_revision_id: 20,
  fx_state: "ready", last_error_code: null, prices_json: JSON.stringify([{ ozon_sku: "sku", amount: 1000, currency: "RUB" }]),
  ordered_business_date: "2026-09-25", signed_business_date: "2026-10-26", order_fx_id: "1", signed_fx_id: "2",
  ...pinned("ordered", "2026-09-25", "1", "10"), ...pinned("signed", "2026-10-26", "2", "12.5"),
  actual_inputs_json: JSON.stringify({ fx_attribution: { fx_gain_loss_cny: -20, settlement_basis: "signed_day" } }),
  actual_outputs_json: JSON.stringify({ settlement_state: "accrued", profit_status: "accrued" }),
  actual_rate_version_json: JSON.stringify({ order_fx: { id: "1" }, signed_fx: { id: "2" } }),
  estimate_inputs_json: JSON.stringify({ quantity: 2, estimate: { formulaVersion: "V2", fx: { id: "1" }, orderBusinessDate: "2026-09-25", salePriceCny: 100 } }),
  estimate_outputs_json: JSON.stringify({ quantity: 2, estimated_profit: 30 }), ...overrides });
const openRow = (overrides = {}) => fixtureRow({ status: "delivering", tracking_stage: "shipping", logistics_status: "delivering",
  delivered_at: null, accrued_at: null, signed_business_date: null, signed_fx_id: null, current_actual_revision_id: null,
  settlement_state: "estimated", profit_status: "estimated", lock_reason: null, ...overrides });
function fakeDb({ rows = [], history = [quote()], latest = history.at(-1), mysqlShape = false } = {}) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    assert.match(sql.trim(), /^SELECT /, "read-only tool must never perform DDL or writes");
    const result = sql.includes("FROM orders o") ? rows : sql.includes("LIMIT 1") ? latest ? [latest] : [] : history;
    return mysqlShape ? [result, []] : result;
  } };
}

test("public curve exposes daily direction, gaps and source dates without reading private business tables", async () => {
  const db = fakeDb({ history: [quote("2026-10-24", "10", "1"), quote()], mysqlShape: true });
  const value = await getExchangeRateTool(db, { now, query: { from: "2026-10-24", to: "2026-10-26" } });
  assert.equal(value.month_impact, null);
  assert.equal(db.calls.length, 2);
  assert.ok(db.calls.every(call => !call.sql.includes("orders")));
  assert.equal(value.public.points[0].rate, 10);
  assert.equal(value.public.points[0].rate_cny_per_rub, 0.1);
  assert.equal(value.public.points[1].rate, null);
  assert.deepEqual(value.public.coverage, { expected_days: 3, available_days: 2, missing_days: 1, invalid_days: 0, complete: false });
  assert.equal(value.public.today.available, true);
  assert.equal(value.timezone, "Asia/Shanghai");
});

test("today-only performs one public read and never substitutes a previous archive for today", async () => {
  const db = fakeDb({ history: [], latest: quote("2026-10-25", "12", "1") });
  const value = await getExchangeRateToday(db, { now });
  assert.equal(db.calls.length, 1);
  assert.equal(value.public.today.available, false);
  assert.equal(value.public.today.rate, null);
  assert.equal(value.public.today.reason, "TODAY_ARCHIVE_MISSING");
  assert.equal(value.public.latest.business_date, "2026-10-25");
  assert.equal(value.public.latest.rate, 12);
  const beijing = await getExchangeRateToday(fakeDb({ history: [], latest: quote("2026-10-27") }), { now: "2026-10-26T17:00:00Z" });
  assert.equal(beijing.public.today.business_date, "2026-10-27");
});

test("rolling ranges clamp month ends and reject future, invalid or oversized custom intervals", async () => {
  const value = await getExchangeRateTool(fakeDb(), { now: "2024-03-31T02:00:00Z", query: { range: "month" } });
  assert.deepEqual(value.public.range, { preset: "month", from: "2024-03-01", to: "2024-03-31" });
  const year = await getExchangeRateTool(fakeDb(), { now: "2024-03-01T02:00:00Z" });
  assert.equal(year.public.coverage.expected_days, 366);
  for (const query of [{ from: "2026-02-30" }, { from: "2026-10-27" }, { to: "2026-10-27" }, { from: "2020-01-01" }, { range: "all" }]) {
    const db = fakeDb();
    await assert.rejects(getExchangeRateTool(db, { now, query }), { code: "EXCHANGE_RATE_TOOL_FILTER_INVALID" });
    assert.equal(db.calls.length, 0);
  }
});

test("invalid and duplicate archive days stay explicit gaps, never interpolated or selected arbitrarily", async () => {
  const db = fakeDb({ history: [quote(), quote("2026-10-26", "13", "3")], latest: quote() });
  const result = await getExchangeRateTool(db, { now, query: { from: "2026-10-26" } });
  assert.equal(result.public.today.available, false);
  assert.equal(result.public.today.reason, "ARCHIVE_CONFLICT");
  assert.equal(result.public.coverage.invalid_days, 1);
  const bad = await getExchangeRateToday(fakeDb({ latest: quote("2026-10-26", "0") }), { now });
  assert.equal(bad.public.today.reason, "ARCHIVE_INVALID");
});

test("realized uses the latest actual revision's input attribution, supports output compatibility and excludes legacy baselines", async () => {
  const outputOnly = fixtureRow({ order_item_id: 2, actual_inputs_json: "{}", actual_outputs_json: JSON.stringify({
    settlement_state: "accrued", profit_status: "accrued", fx_attribution: { fx_gain_loss_cny: 5, settlement_basis: "signed_day" } }) });
  const legacy = fixtureRow({ order_item_id: 3, formula_version: "V1", legacy_baseline: 1 });
  const db = fakeDb({ rows: [fixtureRow(), outputOnly, legacy] });
  const value = await getExchangeRateTool(db, { now, tenantScope: scope });
  assert.equal(value.month_impact.realized.amount_cny, -15);
  assert.equal(value.month_impact.realized.eligible_items, 2);
  assert.equal(value.month_impact.realized.excluded_items, 1);
  assert.equal(value.month_impact.excluded.legacy_items, 1);
  const sql = db.calls.find(call => call.sql.includes("FROM orders o")).sql;
  assert.match(sql, /actual\.id=calc\.current_actual_revision_id/);
  assert.match(sql, /actual\.tenant_key=calc\.tenant_key/);
  assert.match(sql, /actual\.order_item_id=oi\.id/);
  assert.doesNotMatch(sql, /first_estimate|estimate_inputs_json|estimate_outputs_json/);
  assert.equal(Object.hasOwn(value.month_impact, "total"), false);
});

test("pending or conflicting actual evidence never becomes zero realized gain", async () => {
  const conflict = fixtureRow({ actual_outputs_json: JSON.stringify({ settlement_state: "accrued", profit_status: "accrued",
    fx_attribution: { fx_gain_loss_cny: -99, settlement_basis: "signed_day" } }) });
  const missing = fixtureRow({ order_item_id: 2, actual_inputs_json: "{}" });
  const incomplete = fixtureRow({ order_item_id: 3, last_error_code: "ORDER_PROFIT_FINAL_BILL_INCOMPLETE" });
  const value = await getExchangeRateTool(fakeDb({ rows: [conflict, missing, incomplete] }), { now, tenantScope: scope });
  assert.equal(value.month_impact.realized.amount_cny, null);
  assert.equal(value.month_impact.realized.known_amount_cny, null);
  assert.equal(value.month_impact.realized.pending_items, 3);
  assert.equal(value.month_impact.realized.coverage_complete, false);
  assert.deepEqual(value.month_impact.realized.reasons.map(row => row.code).sort(), ["ACTUAL_FX_ATTRIBUTION_CONFLICT", "ACTUAL_FX_ATTRIBUTION_MISSING", "ACTUAL_SETTLEMENT_PENDING"]);
});

test("unsigned cross-month confirmed RUB and reference CNY sales stay separately attributed without modifying source evidence", async () => {
  const cny = openRow({ order_item_id: 2, prices_json: JSON.stringify([{ ozon_sku: "sku", amount: 100, currency: "CNY" }]) });
  const cancelled = openRow({ order_item_id: 3, status: "cancelled", cancel_reason: "buyer_cancelled" });
  const rows = [openRow(), cny, cancelled], original = JSON.stringify(rows);
  const value = await getExchangeRateTool(fakeDb({ rows }), { now, tenantScope: scope });
  assert.equal(value.month_impact.open.rub_revenue_exposure, 2000);
  assert.equal(value.month_impact.open.known_rub_revenue_impact_cny, -40);
  assert.equal(value.month_impact.open.net_impact_cny, null);
  assert.equal(value.month_impact.open.eligible_items, 2);
  assert.equal(value.month_impact.open.included_items, 2);
  assert.equal(value.month_impact.open.pending_items, 0);
  assert.equal(value.month_impact.open.coverage_complete, true);
  assert.equal(value.month_impact.open.confirmed_rub_items, 1);
  assert.equal(value.month_impact.open.reference_cny_items, 1);
  assert.equal(value.month_impact.open.reference_rub_revenue, 2000);
  assert.equal(value.month_impact.open.reference_cny_sales_amount, 200);
  assert.equal(value.month_impact.open.reference_cny_impact_cny, -40);
  assert.equal(value.month_impact.open.estimated_sales_income_fx_cny, -80);
  assert.equal(value.month_impact.excluded.terminal_unsigned_items, 1);
  assert.equal(value.month_impact.basis.prediction, false);
  assert.equal(value.month_impact.basis.combined_total, false);
  assert.equal(value.month_impact.basis.includes_fees, false);
  assert.equal(value.month_impact.basis.includes_CNY_cost_revaluation, false);
  assert.match(value.month_impact.basis.cny_reference_evidence, /simulation_only/);
  assert.match(value.month_impact.basis.open, /including_prior_months/);
  assert.equal(JSON.stringify(rows), original);
  const cnyOnly = await getExchangeRateTool(fakeDb({ rows: [cny] }), { now, tenantScope: scope });
  assert.equal(cnyOnly.month_impact.open.known_rub_revenue_impact_cny, null);
  assert.equal(cnyOnly.month_impact.open.rub_revenue_exposure, null);
  assert.equal(cnyOnly.month_impact.open.estimated_sales_income_fx_cny, -40);
  assert.equal(cnyOnly.month_impact.open.reference_cny_items, 1);
});

test("100 CNY original sales at frozen 10 versus today's 12.5 estimate a reference 1000 RUB receipt and -20 CNY income effect", async () => {
  const row = openRow({ current_quantity: 1, prices_json: JSON.stringify([{ ozon_sku: "sku", amount: 100, currency: "CNY" }]),
    estimate_inputs_json: JSON.stringify({ quantity: 1, estimate: { formulaVersion: "V2", fx: { id: "1" }, orderBusinessDate: "2026-09-25" } }),
    estimate_outputs_json: JSON.stringify({ quantity: 1, estimated_profit: 99999 }) });
  const original = JSON.stringify(row), result = await getExchangeRateTool(fakeDb({ rows: [row] }), { now, tenantScope: scope });
  assert.equal(result.month_impact.open.reference_cny_sales_amount, 100);
  assert.equal(result.month_impact.open.reference_rub_revenue, 1000);
  assert.equal(result.month_impact.open.reference_cny_impact_cny, -20);
  assert.equal(result.month_impact.open.estimated_sales_income_fx_cny, -20);
  assert.equal(result.month_impact.open.known_rub_revenue_impact_cny, null);
  assert.equal(result.month_impact.open.net_impact_cny, null);
  assert.equal(JSON.stringify(row), original);
});

test("missing current quantity, currency or archived order-day pin remains pending", async () => {
  const rows = [openRow({ current_quantity: null }), openRow({ order_item_id: 2, current_quantity: 0 }),
  openRow({ order_item_id: 3, prices_json: JSON.stringify([{ ozon_sku: "sku", amount: 100, currency: "" }]) }),
  openRow({ order_item_id: 4, order_fx_id: "999" })];
  const value = await getExchangeRateTool(fakeDb({ rows }), { now, tenantScope: scope });
  assert.equal(value.month_impact.open.pending_items, 4);
  assert.equal(value.month_impact.open.known_rub_revenue_impact_cny, null);
  assert.equal(value.month_impact.open.rub_revenue_exposure, null);
  assert.equal(value.month_impact.open.net_impact_cny, null);
  assert.equal(value.month_impact.open.estimated_sales_income_fx_cny, null);
  const unavailable = await getExchangeRateTool(fakeDb({ rows: [openRow()], history: [], latest: null }), { now, tenantScope: scope });
  assert.deepEqual(unavailable.month_impact.open.reasons, [{ code: "TODAY_ARCHIVE_MISSING", count: 1 }]);
});

test("gross income exposure uses frozen unit prices and current unsigned quantity without requiring a profit estimate or fees", async () => {
  const row = openRow({ estimate_inputs_json: null, estimate_outputs_json: null }), before = JSON.stringify(row);
  const initial = await getExchangeRateTool(fakeDb({ rows: [row] }), { now, tenantScope: scope });
  assert.equal(initial.month_impact.open.estimated_sales_income_fx_cny, -40);
  assert.equal(initial.month_impact.open.pending_items, 0);
  assert.equal(initial.month_impact.basis.original_estimate, "frozen_original_unit_price_and_current_unsigned_quantity");
  assert.equal(JSON.stringify(row), before);
  const changed = { ...row, current_quantity: 1 }, changedBefore = JSON.stringify(changed);
  const reduced = await getExchangeRateTool(fakeDb({ rows: [changed] }), { now, tenantScope: scope });
  assert.equal(reduced.month_impact.open.rub_revenue_exposure, 1000);
  assert.equal(reduced.month_impact.open.estimated_sales_income_fx_cny, -20);
  assert.equal(JSON.stringify(changed), changedBefore);
});

test("private scope must be explicit and authorized; public-only never queries orders, even with client selectors", async () => {
  for (const tenantScope of [{ id: 7, isDefault: false }, { id: 7, isDefault: false, financeAuthorized: false }, { id: 0, isDefault: true, financeAuthorized: true }]) {
    const db = fakeDb();
    await assert.rejects(getExchangeRateTool(db, { now, tenantScope }), { code: "EXCHANGE_RATE_TOOL_FINANCE_FORBIDDEN" });
    assert.equal(db.calls.length, 0);
  }
  const publicDb = fakeDb();
  assert.equal((await getExchangeRateTool(publicDb, { now, query: { tenant_id: 8, shop_id: 99 } })).month_impact, null);
  assert.ok(publicDb.calls.every(call => !call.sql.includes("FROM orders")));
  await assert.rejects(getExchangeRateTool(fakeDb({ rows: [fixtureRow({ shop_tenant_id: 8 })] }), { now, tenantScope: scope }), { code: "EXCHANGE_RATE_TOOL_SCOPE_CONFLICT" });
  await assert.rejects(getExchangeRateTool(fakeDb({ rows: [fixtureRow({ calc_tenant_key: "8" })] }), { now, tenantScope: scope }), { code: "EXCHANGE_RATE_TOOL_SCOPE_CONFLICT" });
});

test("legacy NULL shops are accepted only by default scope with matching admin calculation ownership", async () => {
  const row = fixtureRow({ shop_tenant_id: null, calc_tenant_key: "admin", fx_tenant_key: "admin" });
  const value = await getExchangeRateTool(fakeDb({ rows: [row] }), { now, tenantScope: { id: 1, isDefault: true, financeAuthorized: true } });
  assert.equal(value.month_impact.realized.amount_cny, -20);
  await assert.rejects(getExchangeRateTool(fakeDb({ rows: [row] }), { now, tenantScope: scope }), { code: "EXCHANGE_RATE_TOOL_SCOPE_CONFLICT" });
});

test("missing calculation-version metadata is reported as unknown rather than an established legacy V1 baseline", async () => {
  const value = await getExchangeRateTool(fakeDb({ rows: [fixtureRow({ formula_version: null, calc_tenant_key: null })] }), { now, tenantScope: scope });
  assert.equal(value.month_impact.excluded.legacy_items, 0);
  assert.equal(value.month_impact.excluded.unversioned_items, 1);
  assert.equal(value.month_impact.realized.excluded_items, 1);
  assert.deepEqual(value.month_impact.realized.reasons, [{ code: "PROFIT_FORMULA_VERSION_UNKNOWN", count: 1 }]);
});

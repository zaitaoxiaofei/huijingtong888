import { orderProfitFxBusinessDate, ORDER_PROFIT_DAILY_FX_SOURCE } from "./order-profit-daily-fx.js";
import { dailyFxQuery } from "./order-profit-daily-fx-schema.js";
import { validateDailyFxSnapshot } from "./profit-formulas/v2/fx.js";
import { getProfitFormula, usesDailyProfitFx } from "./profit-formulas/registry.js";

const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const parse = value => { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } };
const amount = value => ["number", "string"].includes(typeof value) && String(value).trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const reason = (bucket, code) => { bucket.reasons.set(code, (bucket.reasons.get(code) || 0) + 1); };
const reasons = map => [...map].map(([code, count]) => ({ code, count }));
const checkedDay = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail("EXCHANGE_RATE_TOOL_FILTER_INVALID", "汇率查询日期需要北京日期 YYYY-MM-DD");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw fail("EXCHANGE_RATE_TOOL_FILTER_INVALID", "汇率查询日期无效");
  return value;
};
const shiftDay = (day, days) => new Date(Date.parse(day + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
function previousMonths(day, count) {
  const [year, month, date] = day.split("-").map(Number), target = new Date(Date.UTC(year, month - 1 - count, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, last));
  return target.toISOString().slice(0, 10);
}
function rangeFor(query, today) {
  const preset = query.range || "year";
  if (!["month", "quarter", "year"].includes(preset)) throw fail("EXCHANGE_RATE_TOOL_FILTER_INVALID", "汇率范围请选择近一个月、近三个月或近一年");
  const to = query.to ? checkedDay(query.to) : today;
  const from = query.from ? checkedDay(query.from) : shiftDay(previousMonths(to, { month: 1, quarter: 3, year: 12 }[preset]), 1);
  if (from > to || to > today || (Date.parse(to) - Date.parse(from)) / 86400000 + 1 > 400) {
    throw fail("EXCHANGE_RATE_TOOL_FILTER_INVALID", "汇率开始日期不能晚于结束日期，不能查询未来，单次最多 400 天");
  }
  return { preset: query.from || query.to ? "custom" : preset, from, to };
}
function archivePoint(row, businessDate) {
  if (!row) return { business_date: businessDate, rate: null, rate_rub_per_cny: null, rate_cny_per_rub: null, archive_id: null, source_date: null, reason: "TODAY_ARCHIVE_MISSING" };
  try {
    const value = validateDailyFxSnapshot({ id: row.id, business_date: row.business_date, source_date: row.source_date,
      currency_from: row.currency_from, currency_to: row.currency_to, source: row.source, rate: row.rate }, { businessDate });
    if (value.source !== ORDER_PROFIT_DAILY_FX_SOURCE) throw Error("source");
    return { business_date: value.business_date, rate: value.rate, rate_rub_per_cny: value.rate, rate_cny_per_rub: 1 / value.rate,
      archive_id: value.id, source_date: value.source_date, reason: null };
  } catch { return { business_date: businessDate, rate: null, rate_rub_per_cny: null, rate_cny_per_rub: null, archive_id: null, source_date: null, reason: "ARCHIVE_INVALID" }; }
}
const rateSelect = `SELECT CAST(id AS CHAR) id, DATE_FORMAT(business_date,'%Y-%m-%d') business_date,
  DATE_FORMAT(source_date,'%Y-%m-%d') source_date, currency_from,currency_to,source,CAST(rate AS CHAR) rate
  FROM order_profit_daily_fx_rates`;

function privateScope(scope) {
  if (scope == null) return null;
  if (!Number.isSafeInteger(Number(scope.id)) || Number(scope.id) <= 0 || scope.financeAuthorized !== true || typeof scope.isDefault !== "boolean") {
    throw fail("EXCHANGE_RATE_TOOL_FINANCE_FORBIDDEN", "需要当前企业有效财务权限才能查看订单汇差", 403);
  }
  return { id: Number(scope.id), isDefault: scope.isDefault };
}
const keyForShop = row => Number(row.shop_tenant_id) > 0 ? String(Number(row.shop_tenant_id)) : "admin";
function pinnedRate(row, prefix, businessDate) {
  return validateDailyFxSnapshot({ id: row[`${prefix}_archive_id`], business_date: row[`${prefix}_archive_day`],
    source_date: row[`${prefix}_source_date`], currency_from: row[`${prefix}_currency_from`], currency_to: row[`${prefix}_currency_to`],
    source: row[`${prefix}_source`], rate: row[`${prefix}_rate`] }, { businessDate });
}
function attributionFrom(row) {
  const inputs = parse(row.actual_inputs_json), outputs = parse(row.actual_outputs_json);
  const input = inputs?.fx_attribution, output = outputs?.fx_attribution;
  if (!input && !output) return { code: "ACTUAL_FX_ATTRIBUTION_MISSING" };
  if (input && output && ["fx_gain_loss_cny", "settlement_basis"].some(key => String(input[key]) !== String(output[key]))) return { code: "ACTUAL_FX_ATTRIBUTION_CONFLICT" };
  const value = input || output;
  if (amount(value.fx_gain_loss_cny) === null || value.settlement_basis !== "signed_day") return { code: "ACTUAL_FX_ATTRIBUTION_MISSING" };
  return { value: Number(value.fx_gain_loss_cny) };
}

async function monthImpact(db, scope, today, currentRate) {
  const from = today.slice(0, 7) + "-01", next = new Date(from + "T00:00:00Z");
  next.setUTCMonth(next.getUTCMonth() + 1);
  const toExclusive = next.toISOString().slice(0, 10), utc = day => new Date(day + "T00:00:00+08:00").toISOString().slice(0, 19).replace("T", " ");
  const owner = "(CASE WHEN s.tenant_id > 0 THEN CAST(s.tenant_id AS CHAR) ELSE 'admin' END) COLLATE utf8mb4_0900_ai_ci";
  const rows = await dailyFxQuery(db, `SELECT oi.id order_item_id,o.id order_id,o.shop_id,s.tenant_id shop_tenant_id,
      o.status,o.tracking_stage,o.logistics_status,o.delivered_at,o.accrued_at,o.cancel_reason,o.cancel_type,o.cancel_initiator,o.cancelled_after_ship,
      oi.ozon_sku,oi.quantity current_quantity,oi.settlement_state,opi.profit_status,opi.lock_reason,
      calc.tenant_key calc_tenant_key,calc.formula_version,calc.legacy_baseline,calc.current_actual_revision_id,
      fx.tenant_key fx_tenant_key,fx.state fx_state,fx.last_error_code,fx.prices_json,fx.order_fx_id,fx.signed_fx_id,
      DATE_FORMAT(fx.ordered_business_date,'%Y-%m-%d') ordered_business_date,
      DATE_FORMAT(fx.signed_business_date,'%Y-%m-%d') signed_business_date,
      CAST(ordered.id AS CHAR) ordered_archive_id,DATE_FORMAT(ordered.business_date,'%Y-%m-%d') ordered_archive_day,
      DATE_FORMAT(ordered.source_date,'%Y-%m-%d') ordered_source_date,ordered.currency_from ordered_currency_from,
      ordered.currency_to ordered_currency_to,ordered.source ordered_source,CAST(ordered.rate AS CHAR) ordered_rate,
      CAST(signed.id AS CHAR) signed_archive_id,DATE_FORMAT(signed.business_date,'%Y-%m-%d') signed_archive_day,
      DATE_FORMAT(signed.source_date,'%Y-%m-%d') signed_source_date,signed.currency_from signed_currency_from,
      signed.currency_to signed_currency_to,signed.source signed_source,CAST(signed.rate AS CHAR) signed_rate,
      actual.inputs_json actual_inputs_json,actual.outputs_json actual_outputs_json,actual.rate_version_json actual_rate_version_json
    FROM orders o JOIN shops s ON s.id=o.shop_id JOIN order_items oi ON oi.order_id=o.id
    LEFT JOIN order_profit_calc_state calc ON calc.order_item_id=oi.id AND calc.order_id=o.id AND calc.tenant_key=${owner}
    LEFT JOIN order_profit_fx_state fx ON fx.order_id=o.id AND fx.tenant_key=${owner}
    LEFT JOIN order_profit_items opi ON opi.order_item_id=oi.id
    LEFT JOIN order_profit_daily_fx_rates ordered ON ordered.id=fx.order_fx_id
    LEFT JOIN order_profit_daily_fx_rates signed ON signed.id=fx.signed_fx_id
    LEFT JOIN order_profit_calc_revisions actual ON actual.id=calc.current_actual_revision_id AND actual.tenant_key=calc.tenant_key
      AND actual.order_id=o.id AND actual.order_item_id=oi.id AND actual.layer='actual' AND actual.formula_version='V2' AND actual.legacy_baseline=0
    WHERE (s.tenant_id=?${scope.isDefault ? " OR s.tenant_id IS NULL" : ""}) AND (
      (fx.signed_business_date>=? AND fx.signed_business_date<?) OR (o.delivered_at>=? AND o.delivered_at<?)
      OR (fx.signed_business_date IS NULL AND o.delivered_at IS NULL AND
        (calc.formula_version='V2' OR (o.ordered_at>=? AND o.ordered_at<?))))
    ORDER BY o.id,oi.id`, [scope.id, from, toExclusive, utc(from), utc(toExclusive), utc(from), utc(toExclusive)]);
  const realized = { eligible_items: 0, included_items: 0, pending_items: 0, excluded_items: 0, reasons: new Map() };
  const open = { eligible_items: 0, included_items: 0, pending_items: 0, excluded_items: 0, reasons: new Map() };
  const excluded = { legacy_items: 0, unversioned_items: 0, terminal_unsigned_items: 0, outside_month_items: 0 };
  let realizedSum = 0, openSum = 0, rubExposure = 0;
  let referenceImpact = 0, referenceRubRevenue = 0, referenceCnySales = 0, confirmedRubItems = 0, referenceCnyItems = 0;
  const seen = new Set();
  for (const row of rows) {
    const key = keyForShop(row);
    if (!(Number(row.shop_tenant_id) === scope.id || (scope.isDefault && row.shop_tenant_id === null))
      || (row.calc_tenant_key != null && row.calc_tenant_key !== key) || (row.fx_tenant_key != null && row.fx_tenant_key !== key)
      || seen.has(String(row.order_item_id))) throw fail("EXCHANGE_RATE_TOOL_SCOPE_CONFLICT", "订单汇差归属或关联不一致，停止汇总", 409);
    seen.add(String(row.order_item_id));
    const signed = row.signed_business_date || (row.delivered_at ? orderProfitFxBusinessDate(row.delivered_at) : null);
    const isCurrentSigned = signed && signed >= from && signed < toExclusive;
    const bucket = isCurrentSigned ? realized : open;
    if (["V1", "V3"].includes(row.formula_version) || Number(row.legacy_baseline || 0)) {
      excluded.legacy_items++;bucket.excluded_items++;reason(bucket, "LEGACY_FX_BASELINE_UNAVAILABLE");continue;
    }
    if (!usesDailyProfitFx(row.formula_version)) {
      excluded.unversioned_items++;bucket.excluded_items++;reason(bucket, "PROFIT_FORMULA_VERSION_UNKNOWN");continue;
    }
    const outcome = getProfitFormula(row.formula_version).outcome.classifyOrderOutcome(row);
    if (!isCurrentSigned && (signed || outcome !== "active")) {
      if (signed) { excluded.outside_month_items++;continue; }
      excluded.terminal_unsigned_items++;open.excluded_items++;reason(open, "TERMINAL_UNSIGNED_EXCLUDED");continue;
    }
    bucket.eligible_items++;
    const pending = code => { bucket.pending_items++;reason(bucket, code); };
    if (!row.fx_tenant_key) { pending("FX_STATE_MISSING");continue; }
    let orderedFx;
    try {
      orderedFx = pinnedRate(row, "ordered", row.ordered_business_date);
      if (String(orderedFx.id) !== String(row.order_fx_id) || orderedFx.business_date > today) throw Error("pin");
    } catch { pending("ORDER_FX_ARCHIVE_INVALID");continue; }
    if (isCurrentSigned) {
      let signedFx;
      try {
        signedFx = pinnedRate(row, "signed", row.signed_business_date);
        if (String(signedFx.id) !== String(row.signed_fx_id) || signedFx.business_date < orderedFx.business_date || signedFx.business_date > today) throw Error("pin");
      } catch { pending("SIGNED_FX_ARCHIVE_INVALID");continue; }
      const rateVersion = parse(row.actual_rate_version_json), output = parse(row.actual_outputs_json);
      if (row.fx_state !== "ready" || row.last_error_code || row.settlement_state !== "accrued" || row.profit_status !== "accrued"
        || row.lock_reason !== "finance_accrued_signed_day_fx" || !row.current_actual_revision_id
        || output?.settlement_state !== "accrued" || output?.profit_status !== "accrued"
        || String(rateVersion?.order_fx?.id) !== String(orderedFx.id) || String(rateVersion?.signed_fx?.id) !== String(signedFx.id)) {
        pending("ACTUAL_SETTLEMENT_PENDING");continue;
      }
      const attribution = attributionFrom(row);
      if (attribution.code) { pending(attribution.code);continue; }
      realizedSum += attribution.value;realized.included_items++;continue;
    }
    if (!currentRate.available) { pending(currentRate.reason || "TODAY_ARCHIVE_MISSING");continue; }
    const quantity = amount(row.current_quantity);
    if (!(quantity > 0)) { pending("ESTIMATE_QUANTITY_UNKNOWN");continue; }
    const prices = parse(row.prices_json), matches = Array.isArray(prices) ? prices.filter(price => String(price.ozon_sku) === String(row.ozon_sku)) : [];
    const price = matches[0];
    if (matches.length !== 1 || !["CNY", "RUB"].includes(price?.currency) || amount(price?.amount) === null || Number(price.amount) < 0) {
      pending("ORIGINAL_SALE_CURRENCY_UNKNOWN");continue;
    }
    const originalSale = Number(price.amount) * quantity;
    const confirmedRub = price.currency === "RUB";
    // User-approved reference simulation only. A CNY seller price is not
    // relabelled as original RUB evidence or written into order settlement.
    const receipt = confirmedRub ? originalSale : originalSale * orderedFx.rate;
    const baselineCny = confirmedRub ? originalSale / orderedFx.rate : originalSale;
    const effect = receipt / currentRate.rate - baselineCny;
    if (!Number.isFinite(effect)) { pending("ORIGINAL_SALE_CURRENCY_UNKNOWN");continue; }
    if (confirmedRub) { rubExposure += receipt;openSum += effect;confirmedRubItems++; }
    else { referenceRubRevenue += receipt;referenceCnySales += originalSale;referenceImpact += effect;referenceCnyItems++; }
    open.included_items++;
  }
  return { month: today.slice(0, 7), from, to_exclusive: toExclusive, currency: "CNY",
    realized: { ...realized, reasons: reasons(realized.reasons), amount_cny: realized.pending_items ? null : round(realizedSum),
      known_amount_cny: realized.included_items ? round(realizedSum) : realized.eligible_items ? null : 0, coverage_complete: realized.pending_items === 0 },
    open: { ...open, reasons: reasons(open.reasons), net_impact_cny: null,
      estimated_sales_income_fx_cny: open.included_items ? round(openSum + referenceImpact) : open.eligible_items ? null : 0,
      confirmed_rub_items: confirmedRubItems, reference_cny_items: referenceCnyItems,
      known_rub_revenue_impact_cny: confirmedRubItems ? round(openSum) : open.eligible_items ? null : 0,
      rub_revenue_exposure: confirmedRubItems ? round(rubExposure) : open.eligible_items ? null : 0,
      reference_cny_impact_cny: referenceCnyItems ? round(referenceImpact) : null,
      reference_rub_revenue: referenceCnyItems ? round(referenceRubRevenue) : null,
      reference_cny_sales_amount: referenceCnyItems ? round(referenceCnySales) : null, coverage_complete: open.pending_items === 0 },
    excluded, basis: { realized: "current_beijing_signed_month_latest_actual_revision", open: "all_current_unsigned_active_v2_including_prior_months",
      open_measure: "confirmed_RUB_receipts_plus_CNY_order_day_reference_sales_income_only", prediction: false, combined_total: false,
      cny_reference_assumption: "original_CNY_sales_amount_times_quantity_times_frozen_order_day_RUB_per_CNY_then_revalue_at_today_rate",
      cny_reference_evidence: "simulation_only_not_original_currency_or_settlement_evidence", includes_fees: false, includes_CNY_cost_revaluation: false,
      original_estimate: "frozen_original_unit_price_and_current_unsigned_quantity", positive_means: "CNY_gain", negative_means: "CNY_loss" } };
}

// The caller resolves an active enterprise and checks financial permission.
// A null scope reads only shared archives; neither query params nor platform
// authority supplies enterprise scope. This module performs no fetch or writes.
export async function getExchangeRateTool(db, { tenantScope = null, query = {}, now = Date.now() } = {}) {
  const scope = privateScope(tenantScope), nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw fail("EXCHANGE_RATE_TOOL_FILTER_INVALID", "汇率工具查询时间无效");
  const today = orderProfitFxBusinessDate(nowDate), range = rangeFor(query, today);
  const [history, latestRows] = await Promise.all([
    dailyFxQuery(db, `${rateSelect} WHERE business_date>=? AND business_date<=? AND currency_from='CNY' AND currency_to='RUB' AND source=? ORDER BY business_date,id`, [range.from, range.to, ORDER_PROFIT_DAILY_FX_SOURCE]),
    dailyFxQuery(db, `${rateSelect} WHERE business_date<=? AND currency_from='CNY' AND currency_to='RUB' AND source=? ORDER BY business_date DESC,id DESC LIMIT 1`, [today, ORDER_PROFIT_DAILY_FX_SOURCE])
  ]);
  const byDay = new Map();
  for (const row of history) {
    const point = archivePoint(row, row.business_date);
    if (byDay.has(point.business_date)) byDay.set(point.business_date, { ...point, rate: null, rate_rub_per_cny: null, rate_cny_per_rub: null, archive_id: null, reason: "ARCHIVE_CONFLICT" });
    else byDay.set(point.business_date, point);
  }
  const points = [];
  for (let date = range.from; date <= range.to; date = shiftDay(date, 1)) points.push(byDay.get(date) || archivePoint(null, date));
  const latest = latestRows[0] ? archivePoint(latestRows[0], latestRows[0].business_date) : null;
  const todayPoint = byDay.get(today) || (latest?.business_date === today ? latest : archivePoint(null, today));
  const current = { ...todayPoint, available: todayPoint.rate !== null };
  const availableDays = points.filter(point => point.rate !== null).length;
  return { timezone: "Asia/Shanghai", as_of: nowDate.toISOString(), public: { range, source: ORDER_PROFIT_DAILY_FX_SOURCE,
    currency_from: "CNY", currency_to: "RUB", points, today: current, latest,
    coverage: { expected_days: points.length, available_days: availableDays, missing_days: points.length - availableDays,
      invalid_days: points.filter(point => point.reason && point.reason !== "TODAY_ARCHIVE_MISSING").length, complete: availableDays === points.length } },
    month_impact: scope ? await monthImpact(db, scope, today, current) : null };
}

export async function getExchangeRateToday(db, { now = Date.now() } = {}) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw fail("EXCHANGE_RATE_TOOL_FILTER_INVALID", "汇率工具查询时间无效");
  const today = orderProfitFxBusinessDate(date);
  const rows = await dailyFxQuery(db, `${rateSelect} WHERE business_date<=? AND currency_from='CNY' AND currency_to='RUB' AND source=? ORDER BY business_date DESC,id DESC LIMIT 1`, [today, ORDER_PROFIT_DAILY_FX_SOURCE]);
  const latest = rows[0] ? archivePoint(rows[0], rows[0].business_date) : null;
  const point = latest?.business_date === today ? latest : archivePoint(null, today);
  return { timezone: "Asia/Shanghai", as_of: date.toISOString(), public: { today: { ...point, available: point.rate !== null }, latest } };
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse, compileScript, compileStyle, compileTemplate } from "@vue/compiler-sfc";
import { buildDailyExchangeChart, exchangeForecastAmount, exchangeImpactMoney, exchangeImpactTone, exchangeRateNumber, exchangeRateQuery, exchangeRateReasonText, exchangeRateText } from "../frontend/admin/utils/exchange-rate-tool.js";

test("exchange tool query defaults to one year and uses Beijing calendar dates without enterprise selectors", () => {
  assert.equal(exchangeRateQuery(), "/api/exchange-rates/tool?range=year");
  assert.equal(exchangeRateQuery("quarter"), "/api/exchange-rates/tool?range=quarter");
  assert.equal(exchangeRateQuery("month", ["2024-02-29", "2024-03-01"]), "/api/exchange-rates/tool?range=month&from=2024-02-29&to=2024-03-01");
  assert.equal(exchangeRateQuery("other"), "/api/exchange-rates/tool?range=year");
  for (const dates of [["2026-02-29", "2026-03-01"], ["2026-02-30", "2026-03-01"], ["2026-03-02", "2026-03-01"], ["2025-01-01", "2026-02-05"]]) assert.throws(() => exchangeRateQuery("year", dates));
  assert.doesNotThrow(() => exchangeRateQuery("year", ["2025-01-01", "2026-02-04"]));
});

test("money display distinguishes missing, true zero, income gains and losses", () => {
  for (const missing of [null, undefined, "", "  ", false, Infinity, NaN]) {
    assert.equal(exchangeRateNumber(missing), null);
    assert.equal(exchangeImpactMoney(missing), "待核对");
    assert.equal(exchangeImpactTone(missing), "neutral");
  }
  assert.equal(exchangeImpactMoney(0), "¥0.00");
  assert.equal(exchangeImpactMoney(-16), "−¥16.00");
  assert.equal(exchangeImpactMoney("5.125"), "+¥5.13");
  assert.equal(exchangeImpactTone(-16), "negative");
  assert.equal(exchangeImpactTone(5), "positive");
  assert.equal(exchangeRateText(null), "—");
  assert.equal(exchangeRateText(0), "—");
  assert.equal(exchangeRateText(12.5), "12.5000");
  assert.equal(exchangeRateText(0.08, 6), "0.080000");
});

test("combined reference forecast wins over the confirmed RUB subset and never hides an unknown total", () => {
  const combined = { estimated_sales_income_fx_cny: -25, reference_cny_impact_cny: -20, known_rub_revenue_impact_cny: -5, reference_cny_items: 2, confirmed_rub_items: 1 };
  assert.equal(exchangeForecastAmount(combined), -25);
  assert.equal(exchangeForecastAmount({ ...combined, estimated_sales_income_fx_cny: 0 }), 0);
  assert.equal(exchangeForecastAmount({ ...combined, estimated_sales_income_fx_cny: null }), null);
  assert.equal(exchangeForecastAmount({ ...combined, estimated_sales_income_fx_cny: undefined }), null);
  assert.equal(exchangeForecastAmount({ known_rub_revenue_impact_cny: -5 }), -5, "only an absent new field accepts the older explicit RUB contract");
  assert.equal(exchangeForecastAmount(null), null);
});

test("daily curve uses actual daily rates, explicit inverse direction, and gaps without interpolation", () => {
  const chart = buildDailyExchangeChart([
    { business_date: "2026-10-26", rate: 12.5, rate_rub_per_cny: 12.5 },
    { business_date: "2026-10-24", rate: 10, rate_rub_per_cny: 10 },
    { business_date: "2026-10-25", rate: null },
    { business_date: "invalid", rate: 200 }
  ]);
  assert.equal(chart.paths.length, 2);
  assert.equal(chart.points.length, 2);
  assert.deepEqual(chart.points.map(point => point.business_date), ["2026-10-24", "2026-10-26"]);
  assert.equal(chart.paths.every(path => !path.includes(" L")), true);
  assert.ok(chart.points[1].x > chart.points[0].x);
  assert.ok(chart.points[1].y < chart.points[0].y);
  assert.equal(buildDailyExchangeChart([{ business_date: "2026-10-24", rate: 10 }, { business_date: "2026-10-26", rate: 11 }]).paths.length, 2, "an absent day also breaks the curve");
  assert.equal(buildDailyExchangeChart([{ business_date: "2026-10-24", rate: 10 }, { business_date: "2026-10-25", rate: 11 }]).paths.length, 1);
  assert.deepEqual(buildDailyExchangeChart([{ business_date: "2026-10-24", rate: null }]).points, []);
  const flat = buildDailyExchangeChart([{ business_date: "2026-10-24", rate: 10 }]);
  assert.ok(flat.points.every(point => Number.isFinite(point.y)));
});

test("one year is represented by at most 366 genuine daily points", () => {
  const rows = Array.from({ length: 366 }, (_, index) => ({ business_date: new Date(Date.UTC(2023, 11, 31 + index)).toISOString().slice(0, 10), rate: 10 + index / 1000 }));
  const chart = buildDailyExchangeChart(rows);
  assert.equal(chart.points.length, 366);
  assert.equal(chart.paths.length, 1);
  assert.equal(chart.xTicks.length, 3);
  assert.equal(chart.yTicks.length, 4);
});

test("pending reason codes are translated into business impact without claiming missing money is zero", () => {
  assert.match(exchangeRateReasonText("TODAY_ARCHIVE_MISSING"), /今日汇率/);
  assert.match(exchangeRateReasonText("ACTUAL_SETTLEMENT_PENDING"), /结算账单/);
  assert.match(exchangeRateReasonText("ORIGINAL_SALE_CURRENCY_UNKNOWN"), /原币销售收入/);
  assert.equal(exchangeRateReasonText("SETTLEMENT_RUB_EXPOSURE_UNKNOWN"), "人民币标价订单的卢布结算金额尚未确认，暂不计入预计汇差");
  assert.equal(exchangeRateReasonText("new_reason"), "部分数据待核对");
});

test("standalone exchange tool compiles and preserves API, privacy and embedded boundaries", () => {
  const filename = "frontend/admin/views/tools/ExchangeRateToolView.vue";
  const source = readFileSync(filename, "utf8");
  const { descriptor, errors } = parse(source, { filename });
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: "exchange-rate-tool" });
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: "exchange-rate-tool", compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
  for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename, id: "data-v-exchange-rate-tool", scoped: style.scoped }).errors, []);
  assert.match(source, /v-if="!props\.embedded"/);
  assert.match(source, /const preset = ref\("year"\)/);
  assert.match(source, /signal\.aborted.*scope !== currentApiCacheScope/);
  assert.match(source, /onDeactivated\(stopRequest\)/);
  assert.match(source, /erp:auth-scope-changed/);
  assert.match(source, /shanghaiDateTimeText/);
  assert.match(source, /当前账号可查看公共参考汇率/);
  assert.match(source, /待签收预计销售收入汇差（参考估算）/);
  assert.match(source, /人民币标价按下单日汇率估算卢布参考收入，再按今日汇率比较；不含费用，不是官方结算金额/);
  assert.match(source, /reference_cny_items/);
  assert.match(source, /confirmed_rub_items/);
  assert.match(source, /曲线上升表示每人民币可兑更多卢布；等额卢布收入折回人民币会减少/);
  assert.match(source, /包含跨月存量/);
  assert.match(source, /不合并为总损益/);
  assert.doesNotMatch(source, /router|localStorage|sessionStorage|apiClient\.(post|put|patch|delete)|net_impact_cny|known_amount_cny/);
  assert.doesNotMatch(descriptor.styles.map(style => style.content).join(""), /#[0-9a-f]{3,8}\b/i);
});

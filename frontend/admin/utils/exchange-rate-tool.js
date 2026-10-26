import { shanghaiDateText } from "./shanghai-date.js";

const DAY_MS = 86400000;
const PRESETS = new Set(["month", "quarter", "year"]);

export function exchangeRateNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function exchangeRateText(value, digits = 4) {
  const number = exchangeRateNumber(value);
  return number !== null && number > 0 ? number.toFixed(digits) : "—";
}

export function exchangeImpactMoney(value) {
  const number = exchangeRateNumber(value);
  if (number === null) return "待核对";
  return `${number > 0 ? "+" : number < 0 ? "−" : ""}¥${Math.abs(number).toFixed(2)}`;
}

export function exchangeImpactTone(value) {
  const number = exchangeRateNumber(value);
  return number === null || number === 0 ? "neutral" : number > 0 ? "positive" : "negative";
}

export function exchangeForecastAmount(open) {
  if (!open || typeof open !== "object") return null;
  // An explicit null means the combined forecast is unknown, even when one part is known.
  const value = Object.hasOwn(open, "estimated_sales_income_fx_cny")
    ? open.estimated_sales_income_fx_cny
    : open.known_rub_revenue_impact_cny;
  return exchangeRateNumber(value);
}

function dayTime(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return null;
  const time = Date.parse(`${day}T00:00:00+08:00`);
  return Number.isFinite(time) && shanghaiDateText(new Date(time)) === day ? time : null;
}

export function exchangeRateQuery(preset = "year", dates = null) {
  const query = new URLSearchParams({ range: PRESETS.has(preset) ? preset : "year" });
  if (dates?.length) {
    const [from, to] = dates;
    const fromTime = dayTime(from), toTime = dayTime(to);
    if (fromTime === null || toTime === null || fromTime > toTime) throw new Error("请选择正确的开始和结束日期");
    if ((toTime - fromTime) / DAY_MS + 1 > 400) throw new Error("日期区间最多查询 400 天，请缩小范围");
    query.set("from", from);
    query.set("to", to);
  }
  return `/api/exchange-rates/tool?${query}`;
}

export function exchangeRateReasonText(reason) {
  const labels = {
    TODAY_ARCHIVE_MISSING: "今日汇率尚未存档",
    ARCHIVE_INVALID: "汇率存档需要核对",
    ARCHIVE_CONFLICT: "汇率存档存在冲突，待核对",
    LEGACY_FX_BASELINE_UNAVAILABLE: "旧规则订单缺少可追溯的汇差依据",
    FX_STATE_MISSING: "部分订单的汇率依据待补齐",
    ORDER_FX_ARCHIVE_INVALID: "部分订单的下单汇率待核对",
    SIGNED_FX_ARCHIVE_INVALID: "部分订单的签收汇率待核对",
    ACTUAL_SETTLEMENT_PENDING: "部分订单的完整结算账单尚未齐全",
    ACTUAL_FX_ATTRIBUTION_MISSING: "部分订单的真实汇差依据待补齐",
    ACTUAL_FX_ATTRIBUTION_CONFLICT: "部分订单的真实汇差依据存在冲突",
    FIRST_VALID_ESTIMATE_MISSING: "部分订单尚缺最初的有效预估依据",
    ESTIMATE_FX_PIN_MISMATCH: "部分订单的预估汇率依据待核对",
    ORIGINAL_SALE_CURRENCY_UNKNOWN: "部分订单的原币销售收入待核对",
    SETTLEMENT_RUB_EXPOSURE_UNKNOWN: "人民币标价订单的卢布结算金额尚未确认，暂不计入预计汇差",
    ESTIMATE_QUANTITY_UNKNOWN: "部分订单的预估数量待核对",
    TERMINAL_UNSIGNED_EXCLUDED: "未签收即终止的订单未纳入预计收入汇差",
    FX_DAILY_RATE_MISSING: "当天汇率尚未存档",
    ORDER_FX_ARCHIVE_MISSING: "部分订单的汇率依据待补齐",
    ORDER_FX_NOT_READY: "部分订单的汇率依据待补齐",
    FX_FINANCE_SOURCE_INCOMPLETE: "部分订单的结算账单尚未齐全",
    ORDER_PROFIT_FINAL_BILL_INCOMPLETE: "部分订单的结算账单尚未齐全",
    FX_FINANCE_CURRENCY_UNKNOWN: "部分原始账单币种待核对",
    FX_FINANCE_SOURCE_UNRECONCILED: "部分原始账单尚未核平",
    FX_ORDER_RATE_MISSING: "部分订单的下单汇率待补齐",
    FX_TODAY_RATE_MISSING: "今日汇率尚未存档",
    FX_ACTUAL_ATTRIBUTION_MISSING: "部分订单的真实汇差依据待补齐"
  };
  return labels[String(reason || "")] || "部分数据待核对";
}

// One point represents one Beijing-calendar day. Missing days break the line.
export function buildDailyExchangeChart(points = []) {
  const rows = points.filter(row => dayTime(row?.business_date) !== null)
    .map(row => ({ ...row, rate: exchangeRateNumber(row.rate_rub_per_cny ?? row.rate) }))
    .sort((a, b) => a.business_date.localeCompare(b.business_date));
  const valid = rows.filter(row => row.rate !== null && row.rate > 0);
  if (!valid.length) return { paths: [], points: [], yTicks: [], xTicks: [], width: 1000, height: 260 };
  const width = 1000, height = 260;
  const left = 68, right = 24, top = 24, bottom = 40;
  const from = dayTime(rows[0].business_date), to = dayTime(rows.at(-1).business_date);
  const min = Math.min(...valid.map(row => row.rate)), max = Math.max(...valid.map(row => row.rate));
  const padding = Math.max((max - min) * 0.15, max * 0.001, 0.0001);
  const lower = Math.max(0, min - padding), upper = max + padding;
  const x = time => left + ((time - from) / Math.max(DAY_MS, to - from)) * (width - left - right);
  const y = rate => top + (upper - rate) / (upper - lower) * (height - top - bottom);
  const plotted = [], paths = [];
  let path = "", previousTime = null;
  for (const row of rows) {
    const time = dayTime(row.business_date);
    if (row.rate === null || row.rate <= 0) {
      if (path) paths.push(path);
      path = "";
      previousTime = null;
      continue;
    }
    if (previousTime !== null && time - previousTime > DAY_MS) {
      if (path) paths.push(path);
      path = "";
    }
    const point = { ...row, x: x(time), y: y(row.rate) };
    plotted.push(point);
    path += `${path ? " L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    previousTime = time;
  }
  if (path) paths.push(path);
  const tickRows = [rows[0], rows[Math.floor((rows.length - 1) / 2)], rows.at(-1)];
  return {
    paths, points: plotted, width, height,
    yTicks: Array.from({ length: 4 }, (_, index) => {
      const rate = lower + (upper - lower) * index / 3;
      return { y: y(rate), label: rate.toFixed(4) };
    }),
    xTicks: [...new Map(tickRows.map(row => [row.business_date, { x: x(dayTime(row.business_date)), date: row.business_date }])).values()]
  };
}

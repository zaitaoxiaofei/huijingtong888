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

export function preciseExchangeRateText(value) {
  const number = exchangeRateNumber(value);
  return number !== null && number > 0 ? number.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 12 }) : "—";
}

export function nearestExchangeChartPoint(chart, x) {
  if (!chart?.points?.length || !Number.isFinite(x)) return null;
  return chart.points.reduce((nearest, point) => Math.abs(point.x - x) < Math.abs(nearest.x - x) ? point : nearest);
}

export function exchangeChartKeyboardPoint(chart, selectedDay, key) {
  const points = chart?.points || [];
  if (!points.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return null;
  if (key === "Home") return points[0];
  if (key === "End") return points.at(-1);
  const index = points.findIndex(point => point.business_date === selectedDay);
  if (index < 0) return key === "ArrowLeft" ? points.at(-1) : points[0];
  return points[Math.max(0, Math.min(points.length - 1, index + (key === "ArrowLeft" ? -1 : 1)))];
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

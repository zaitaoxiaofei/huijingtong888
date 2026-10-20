const SOURCE_URL = "https://www.cbr.ru/scripts/XML_daily_eng.asp";
let cached = null;
let expiresAt = 0;
const historicalRates = new Map();

export function parseCbrCnyRate(xml) {
  const currency = [...String(xml || "").matchAll(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/gi)]
    .map((match) => match[0])
    .find((item) => /<CharCode>\s*CNY\s*<\/CharCode>/i.test(item));
  if (!currency) throw new Error("俄罗斯央行汇率数据中没有人民币 CNY");
  const nominal = Number(currency.match(/<Nominal>\s*([^<]+)\s*<\/Nominal>/i)?.[1]?.replace(",", "."));
  const value = Number(currency.match(/<Value>\s*([^<]+)\s*<\/Value>/i)?.[1]?.replace(",", "."));
  const rate = value / nominal;
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("俄罗斯央行人民币汇率格式无效");
  const sourceDate = String(xml).match(/<ValCurs\b[^>]*Date="([^"]+)"/i)?.[1] || "";
  return { rate: Math.round(rate * 10000) / 10000, source_date: sourceDate };
}

export async function currentPricingReferenceRate({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (cached && now < expiresAt) return cached;
  const response = await fetchImpl(SOURCE_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("俄罗斯央行汇率接口暂不可用");
  const data = parseCbrCnyRate(await response.text());
  cached = {
    currency_from: "CNY", currency_to: "RUB", ...data,
    source: "俄罗斯央行每日官方参考汇率",
    source_url: SOURCE_URL
  };
  expiresAt = now + 60 * 60 * 1000;
  return cached;
}

export async function cbrCnyRateForDate(dateText, { fetchImpl = fetch } = {}) {
  const rawDate = String(dateText || "").trim();
  const date = dateText instanceof Date ? dateText : new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawDate)
    ? rawDate : `${rawDate.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) throw new Error("OGL 订单日期无效，无法取得订单日俄罗斯央行汇率");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (historicalRates.has(day)) return historicalRates.get(day);
  const [year, month, dateOfMonth] = day.split("-");
  const response = await fetchImpl(`${SOURCE_URL}?date_req=${dateOfMonth}/${month}/${year}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`OGL 订单日俄罗斯央行汇率获取失败：${day}`);
  const result = parseCbrCnyRate(await response.text());
  historicalRates.set(day, result);
  return result;
}

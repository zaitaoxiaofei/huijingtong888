const SOURCE_URL = "https://www.cbr.ru/scripts/XML_daily_eng.asp";
let cached = null;
let expiresAt = 0;

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

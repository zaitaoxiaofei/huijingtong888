export const OGL_EFFECTIVE_FROM = "2026-10-19 16:00:00"; // 2026-10-20 00:00 Beijing time

export const OGL_RATES = [
  { serviceClass: "Extra Small", minWeightG: 1, maxWeightG: 500, minPriceRub: 1, maxPriceRub: 1500, perTicketCny: 2.8, perGramCny: 0.0242 },
  { serviceClass: "Budget", minWeightG: 500, maxWeightG: 35000, minPriceRub: 1, maxPriceRub: 1500, perTicketCny: 22.2, perGramCny: 0.0164 },
  { serviceClass: "Small", minWeightG: 1, maxWeightG: 2000, minPriceRub: 1501, maxPriceRub: 7000, perTicketCny: 15.5, perGramCny: 0.0242 },
  { serviceClass: "Big", minWeightG: 2000, maxWeightG: 35000, minPriceRub: 1501, maxPriceRub: 7000, perTicketCny: 34.8, perGramCny: 0.0164 },
  { serviceClass: "Premium Small", minWeightG: 1, maxWeightG: 5000, minPriceRub: 7001, maxPriceRub: 250000, perTicketCny: 21.3, perGramCny: 0.0242 },
  { serviceClass: "Premium Big", minWeightG: 5001, maxWeightG: 35000, minPriceRub: 7001, maxPriceRub: 250000, perTicketCny: 60, perGramCny: 0.0222 }
];

export function oglElectronicServiceFeeRub(parcelValueRub) {
  const value = Number(parcelValueRub);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(200, Math.max(15, value * 0.02));
}

export function oglChargeableWeightG(serviceClass, weightG, length, width, height) {
  const actual = Math.max(10, Number(weightG));
  return /^(?:Big|Premium Big)$/.test(String(serviceClass))
    ? Math.max(actual, Number(length) * Number(width) * Number(height) / 12)
    : actual;
}

export function oglDimensionsValid(length, width, height) {
  const sides = [length, width, height].map(Number).sort((a, b) => b - a);
  return sides.every((side) => Number.isFinite(side) && side > 0)
    && sides[0] <= 200 && sides[1] <= 80 && sides[2] <= 80;
}

export function oglRuleFreightCny(rule, { weightG, length, width, height, parcelValueRub, exchangeRate }) {
  if (!oglDimensionsValid(length, width, height) || !(Number(exchangeRate) > 0)) return null;
  const serviceClass = [...OGL_RATES].sort((a, b) => b.serviceClass.length - a.serviceClass.length)
    .find((rate) => String(rule.name || "").endsWith(rate.serviceClass))?.serviceClass;
  if (!serviceClass) return null;
  const chargeableWeightG = oglChargeableWeightG(serviceClass, weightG, length, width, height);
  if (chargeableWeightG < Number(rule.min_weight_g) || chargeableWeightG > Number(rule.max_weight_g)
    || Number(parcelValueRub) < Number(rule.min_price_rub) || Number(parcelValueRub) > Number(rule.max_price_rub)) return null;
  const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  const transportCny = round(Number(rule.base_fee_cny || 0) + chargeableWeightG * Number(rule.per_gram_cny) + Number(rule.per_ticket_cny));
  const serviceFeeRub = oglElectronicServiceFeeRub(parcelValueRub);
  const serviceFeeCny = round(serviceFeeRub / Number(exchangeRate));
  return { transportCny, serviceFeeRub, serviceFeeCny, totalCny: round(transportCny + serviceFeeCny), chargeableWeightG };
}

export function oglParcelValueRub(rawJson) {
  let payload;
  try { payload = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson; } catch { return 0; }
  const products = payload?.raw?.products || payload?.products || payload?.result?.products;
  if (!Array.isArray(products) || !products.length) return 0;
  const amounts = products.map((product) => Number(product?.price) * Number(product?.quantity || 1));
  return amounts.every((amount) => Number.isFinite(amount) && amount > 0)
    ? amounts.reduce((sum, amount) => sum + amount, 0) : 0;
}

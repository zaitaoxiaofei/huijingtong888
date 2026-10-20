import { currentEffectiveLogisticsRules } from "./effective-logistics-rules.js";
import { oglChargeableWeightG, oglDimensionsValid, oglElectronicServiceFeeRub } from "../../../src/ogl-rates.js";

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const CHANNEL_ORDER = ["express", "standard", "economy"];
const CHANNEL_LABELS = { express: "空运", standard: "陆空", economy: "陆运" };

export function channelLabel(channel) { return CHANNEL_LABELS[String(channel || "").toLowerCase()] || String(channel || ""); }

export function threeChannelQuotes(quotes = [], preferredBand = null) {
  return CHANNEL_ORDER.flatMap((channel) => {
    const matches = quotes.filter((quote) => String(quote.channel || "").toLowerCase() === channel);
    const preferred = preferredBand === null ? [] : matches.filter((quote) => quote.band === preferredBand);
    const eligible = preferred.length ? preferred : matches;
    return eligible.length ? [eligible.reduce((best, quote) => Number(quote.priceCny) < Number(best.priceCny) ? quote : best)] : [];
  });
}

export function defaultLogisticsQuote(quotes = []) {
  return quotes.find((quote) => String(quote.channel || "").toLowerCase() === "standard") || quotes[0] || null;
}

function serviceClass(name) {
  return ["Premium Big", "Premium Small", "Extra Small", "Budget", "Big", "Small"]
    .find((item) => new RegExp(item.replace(" ", "\\s+"), "i").test(String(name || ""))) || "";
}

function permittedDimensions(kind, dimensions) {
  const { length, width, height } = dimensions;
  if (![length, width, height].every((value) => Number.isFinite(value) && value > 0)) return false;
  const longest = Math.max(length, width, height);
  const sum = length + width + height;
  if (kind === "Extra Small") return longest <= 60 && sum <= 90;
  if (kind === "Budget" || kind === "Small") return longest <= 60 && sum <= 150;
  if (kind === "Premium Small") return longest <= 150 && sum <= 250;
  if (kind === "Premium Big") {
    const sorted = [length, width, height].sort((a, b) => b - a);
    return sum <= 310 && sorted[0] <= 150 && sorted[1] <= 80 && sorted[2] <= 80;
  }
  if (kind === "Big") return longest <= 150 && sum <= 310;
  return false;
}

export function logisticsRuleMismatchReasons(rule, { priceRub, weightG, length, width, height }) {
  if (!rule) return [];
  const reasons = [];
  const price = Number(priceRub);
  const actualWeight = Number(weightG);
  const minPrice = Number(rule.min_price_rub);
  const maxPrice = Number(rule.max_price_rub);
  const kind = serviceClass(rule.name);
  const ogl = String(rule.carrier || "").toUpperCase() === "OGL";
  if (Number.isFinite(price) && (price < minPrice || price > maxPrice)) {
    reasons.push(`货值 ₽${round(price)} 超出该档 ₽${minPrice}–${maxPrice}`);
  }
  const chargeableWeight = ogl
    ? oglChargeableWeightG(kind, actualWeight, length, width, height)
    : ["Big", "Premium Big"].includes(kind)
      ? Math.max(actualWeight, Number(length) * Number(width) * Number(height) / 12)
      : actualWeight;
  if (Number.isFinite(chargeableWeight) && (chargeableWeight < Number(rule.min_weight_g) || chargeableWeight > Number(rule.max_weight_g))) {
    reasons.push(`计费重 ${round(chargeableWeight)}g 超出该档 ${rule.min_weight_g}–${rule.max_weight_g}g`);
  }
  const validDimensions = ogl
    ? oglDimensionsValid(length, width, height)
    : permittedDimensions(kind, { length: Number(length), width: Number(width), height: Number(height) });
  if (!validDimensions) reasons.push(ogl
    ? "包裹长宽高不符合 OGL 限制（最长边≤200cm，其余两边≤80cm）"
    : "包裹尺寸超出该档限制");
  return reasons;
}

export function quoteLogisticsRules(rules, { carrier, priceRub, weightG, length, width, height, exchangeRate }, at = new Date()) {
  const price = Number(priceRub);
  const weight = Number(weightG);
  if (![price, weight].every((value) => Number.isFinite(value) && value > 0)) return [];
  return currentEffectiveLogisticsRules(rules, at)
    .filter((rule) => String(rule.carrier || "").toUpperCase() === String(carrier || "").toUpperCase())
    .flatMap((rule) => {
      if (String(rule.mode || "") !== "per_gram") return [];
      const kind = serviceClass(rule.name);
      const ogl = String(rule.carrier || "").toUpperCase() === "OGL";
      if (ogl && !(Number(exchangeRate) > 0)) return [];
      if (!kind || !(ogl
        ? oglDimensionsValid(length, width, height)
        : permittedDimensions(kind, { length: Number(length), width: Number(width), height: Number(height) }))) return [];
      if (price < Number(rule.min_price_rub) || price > Number(rule.max_price_rub)) return [];
      const volumeWeightG = !ogl && ["Big", "Premium Big"].includes(kind)
        ? Number(length) * Number(width) * Number(height) / 12
        : 0;
      const chargeableWeightG = ogl
        ? oglChargeableWeightG(kind, weight, length, width, height)
        : Math.max(weight, volumeWeightG);
      if (chargeableWeightG < Number(rule.min_weight_g) || chargeableWeightG > Number(rule.max_weight_g)) return [];
      const transportCny = round(Number(rule.base_fee_cny) + chargeableWeightG * Number(rule.per_gram_cny) + Number(rule.per_ticket_cny));
      const serviceFeeRub = ogl ? oglElectronicServiceFeeRub(price) : 0;
      const serviceFeeCny = serviceFeeRub && Number(exchangeRate) > 0 ? round(serviceFeeRub / Number(exchangeRate)) : 0;
      return [{
        id: rule.id, name: rule.name, carrier: rule.carrier, channel: rule.channel,
        priceCny: round(transportCny + serviceFeeCny), transportCny, serviceFeeRub, serviceFeeCny,
        chargeableWeightG: round(chargeableWeightG),
        effectiveFrom: rule.effective_from, source: rule.note || ""
      }];
    })
    .sort((a, b) => a.priceCny - b.priceCny);
}

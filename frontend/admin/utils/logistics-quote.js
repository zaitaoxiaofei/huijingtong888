import { currentEffectiveLogisticsRules } from "./effective-logistics-rules.js";

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const CHANNEL_ORDER = ["express", "standard", "economy"];
const CHANNEL_LABELS = { express: "空运", standard: "陆空", economy: "陆运" };

export function channelLabel(channel) { return CHANNEL_LABELS[String(channel || "").toLowerCase()] || String(channel || ""); }

export function threeChannelQuotes(quotes = []) {
  return CHANNEL_ORDER.flatMap((channel) => {
    const matches = quotes.filter((quote) => String(quote.channel || "").toLowerCase() === channel);
    return matches.length ? [matches.reduce((best, quote) => Number(quote.priceCny) < Number(best.priceCny) ? quote : best)] : [];
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

export function quoteLogisticsRules(rules, { carrier, priceRub, weightG, length, width, height }, at = new Date()) {
  const price = Number(priceRub);
  const weight = Number(weightG);
  if (![price, weight].every((value) => Number.isFinite(value) && value > 0)) return [];
  return currentEffectiveLogisticsRules(rules, at)
    .filter((rule) => String(rule.carrier || "").toUpperCase() === String(carrier || "").toUpperCase())
    .flatMap((rule) => {
      if (String(rule.mode || "") !== "per_gram") return [];
      const kind = serviceClass(rule.name);
      if (!kind || !permittedDimensions(kind, { length: Number(length), width: Number(width), height: Number(height) })) return [];
      if (price < Number(rule.min_price_rub) || price > Number(rule.max_price_rub)) return [];
      const volumeWeightG = ["Big", "Premium Big"].includes(kind)
        ? Number(length) * Number(width) * Number(height) / 12
        : 0;
      const chargeableWeightG = Math.max(weight, volumeWeightG);
      if (chargeableWeightG < Number(rule.min_weight_g) || chargeableWeightG > Number(rule.max_weight_g)) return [];
      return [{
        id: rule.id, name: rule.name, carrier: rule.carrier, channel: rule.channel,
        priceCny: round(Number(rule.base_fee_cny) + chargeableWeightG * Number(rule.per_gram_cny) + Number(rule.per_ticket_cny)),
        chargeableWeightG: round(chargeableWeightG),
        effectiveFrom: rule.effective_from, source: rule.note || ""
      }];
    })
    .sort((a, b) => a.priceCny - b.priceCny);
}

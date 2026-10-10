import { currentEffectiveLogisticsRules } from "./effective-logistics-rules.js";
import { quoteLogisticsRules } from "./logistics-quote.js";
import { calculatePricing } from "./pricing-tool.js";

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const bandForRub = (priceRub) => priceRub <= 1500 ? 0 : priceRub <= 5000 ? 1 : 2;

export function pricingLogisticsCandidates(rules, form, rates, at = new Date()) {
  if (!Array.isArray(rates) || rates.length !== 3 || !Number(form.purchaseCost) || !Number(form.weight)
    || !Number(form.exchangeRate) || !Number(form.length) || !Number(form.width) || !Number(form.height)) return [];
  return currentEffectiveLogisticsRules(rules, at)
    .filter((rule) => String(rule.carrier || "").toUpperCase() === String(form.carrier || "").toUpperCase() && rule.mode === "per_gram")
    .flatMap((rule) => {
      const chargeableWeightG = /(?:Premium Big|\bBig\b)/i.test(rule.name)
        ? Math.max(Number(form.weight), Number(form.length) * Number(form.width) * Number(form.height) / 12)
        : Number(form.weight);
      const estimatedFreight = round(Number(rule.base_fee_cny) + chargeableWeightG * Number(rule.per_gram_cny) + Number(rule.per_ticket_cny));
      return rates.flatMap((commissionRate, band) => {
        try {
          const pricing = calculatePricing({ ...form, commissionRate, freight: estimatedFreight });
          if (bandForRub(pricing.saleRub) !== band) return [];
          const quote = quoteLogisticsRules([rule], {
            carrier: form.carrier, priceRub: pricing.saleRub, weightG: form.weight,
            length: form.length, width: form.width, height: form.height
          }, at)[0];
          if (!quote) return [];
          return [{ ...quote, saleRub: pricing.saleRub, commissionRate, band }];
        } catch { return []; }
      });
    })
    .sort((a, b) => a.saleRub - b.saleRub);
}

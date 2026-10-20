import { currentEffectiveLogisticsRules } from "./effective-logistics-rules.js";
import { quoteLogisticsRules } from "./logistics-quote.js";
import { calculatePricing } from "./pricing-tool.js";
import { oglChargeableWeightG, oglElectronicServiceFeeRub } from "../../../src/ogl-rates.js";

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const bandForRub = (priceRub) => priceRub <= 1500 ? 0 : priceRub <= 5000 ? 1 : 2;

export function pricingLogisticsCandidates(rules, form, rates, at = new Date()) {
  if (!Array.isArray(rates) || rates.length !== 3 || !Number(form.purchaseCost) || !Number(form.weight)
    || !Number(form.exchangeRate) || !Number(form.length) || !Number(form.width) || !Number(form.height)) return [];
  return currentEffectiveLogisticsRules(rules, at)
    .filter((rule) => String(rule.carrier || "").toUpperCase() === String(form.carrier || "").toUpperCase() && rule.mode === "per_gram")
    .flatMap((rule) => {
      const chargeableWeightG = String(rule.carrier || "").toUpperCase() === "OGL"
        ? oglChargeableWeightG(/Premium Big$/i.test(rule.name) ? "Premium Big" : /\bBig$/i.test(rule.name) ? "Big" : "Small", form.weight, form.length, form.width, form.height)
        : /(?:Premium Big|\bBig\b)/i.test(rule.name)
        ? Math.max(Number(form.weight), Number(form.length) * Number(form.width) * Number(form.height) / 12)
        : Number(form.weight);
      const estimatedFreight = round(Number(rule.base_fee_cny) + chargeableWeightG * Number(rule.per_gram_cny) + Number(rule.per_ticket_cny));
      return rates.flatMap((commissionRate, band) => {
        try {
          let pricing = calculatePricing({ ...form, commissionRate, freight: estimatedFreight });
          if (String(rule.carrier || "").toUpperCase() === "OGL") {
            for (let index = 0; index < 8; index += 1) {
              const serviceFeeCny = round(oglElectronicServiceFeeRub(pricing.saleRub) / Number(form.exchangeRate));
              const next = calculatePricing({ ...form, commissionRate, freight: round(estimatedFreight + serviceFeeCny) });
              if (next.saleCny === pricing.saleCny) break;
              pricing = next;
            }
          }
          if (bandForRub(pricing.saleRub) !== band) return [];
          const quote = quoteLogisticsRules([rule], {
            carrier: form.carrier, priceRub: pricing.saleRub, weightG: form.weight,
            length: form.length, width: form.width, height: form.height, exchangeRate: form.exchangeRate
          }, at)[0];
          if (!quote) return [];
          return [{ ...quote, saleRub: pricing.saleRub, commissionRate, band }];
        } catch { return []; }
      });
    })
    .sort((a, b) => a.saleRub - b.saleRub);
}

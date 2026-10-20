import test from "node:test";
import assert from "node:assert/strict";
import { quoteLogisticsRules, channelLabel, threeChannelQuotes, defaultLogisticsQuote } from "../frontend/admin/utils/logistics-quote.js";
import { OGL_RATES, oglElectronicServiceFeeRub, oglParcelValueRub } from "../src/ogl-rates.js";

test("three local channels appear in Express, Standard, Economy order", () => {
  const quotes = [
    { id: 1, channel: "economy", priceCny: 9 },
    { id: 2, channel: "express", priceCny: 15 },
    { id: 3, channel: "standard", priceCny: 12 },
    { id: 4, channel: "express", priceCny: 13 }
  ];
  assert.deepEqual(threeChannelQuotes(quotes).map((quote) => quote.id), [4, 3, 1]);
  assert.equal(defaultLogisticsQuote(threeChannelQuotes(quotes)).id, 3);
  assert.deepEqual(["express", "standard", "economy"].map(channelLabel), ["空运", "陆空", "陆运"]);
  const tiered = [{ id: 5, channel: "standard", band: 0, priceCny: 9 }, { id: 6, channel: "standard", band: 1, priceCny: 9 }];
  assert.equal(threeChannelQuotes(tiered, 1)[0].id, 6);
});

const at = "2026-10-10T00:00:00+08:00";
const rule = {
  id: 1, version_group_id: 1, enabled: 1, effective_from: "2026-07-24 00:00:00",
  effective_to: null, name: "GUOO 经济 Extra Small", carrier: "GUOO", channel: "economy",
  mode: "per_gram",
  min_weight_g: 1, max_weight_g: 500, min_price_rub: 1, max_price_rub: 1500,
  base_fee_cny: 0, per_gram_cny: 0.0281, per_ticket_cny: 3.37
};

test("current carrier quote matches weight, price and package dimensions", () => {
  const quotes = quoteLogisticsRules([rule], {
    carrier: "GUOO", priceRub: 1200, weightG: 300, length: 20, width: 20, height: 10
  }, at);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].priceCny, 11.8);
  assert.equal(quotes[0].chargeableWeightG, 300);
  assert.equal(quoteLogisticsRules([rule], {
    carrier: "CEL", priceRub: 1200, weightG: 300, length: 20, width: 20, height: 10
  }, at).length, 0);
});

test("quote excludes obsolete, out-of-tier and oversized rules", () => {
  const payload = { carrier: "GUOO", priceRub: 1200, weightG: 300, length: 20, width: 20, height: 10 };
  assert.equal(quoteLogisticsRules([rule], { ...payload, priceRub: 1600 }, at).length, 0);
  assert.equal(quoteLogisticsRules([rule], { ...payload, length: 70 }, at).length, 0);
  assert.equal(quoteLogisticsRules([{ ...rule, effective_to: "2026-10-09 00:00:00" }], payload, at).length, 0);
});

test("big items use volumetric weight when higher", () => {
  const big = { ...rule, name: "CEL 陆运经济 Big", carrier: "CEL", max_weight_g: 30000, max_price_rub: 7000 };
  const [quote] = quoteLogisticsRules([big], {
    carrier: "CEL", priceRub: 2000, weightG: 200, length: 60, width: 40, height: 30
  }, at);
  assert.equal(quote.chargeableWeightG, 6000);
});

test("premium big respects the second and third side limits", () => {
  const premium = { ...rule, name: "GUOO 经济 Premium Big", min_weight_g: 5001, max_weight_g: 30000, min_price_rub: 7001, max_price_rub: 250000 };
  const payload = { carrier: "GUOO", priceRub: 10000, weightG: 6000, length: 120, width: 90, height: 20 };
  assert.equal(quoteLogisticsRules([premium], payload, at).length, 0);
  assert.equal(quoteLogisticsRules([premium], { ...payload, width: 80 }, at).length, 1);
});

test("GUOO premium big quotes a 120 by 20 by 30 cm, 5.5 kg package", () => {
  const premium = { ...rule, name: "GUOO 标准 Premium Big", channel: "standard",
    min_weight_g: 5001, max_weight_g: 30000, min_price_rub: 7001, max_price_rub: 250000,
    per_gram_cny: 0.0314, per_ticket_cny: 69.64 };
  const [quote] = quoteLogisticsRules([premium], {
    carrier: "GUOO", priceRub: 788 * 11.32, weightG: 5500, length: 120, width: 20, height: 30
  }, at);
  assert.equal(quote.chargeableWeightG, 6000);
  assert.equal(quote.priceCny, 258.04);
});

test("OGL uses the cheaper overlapping land rule and adds its capped electronic service fee", () => {
  const rules = OGL_RATES.map((rate, index) => ({
    id: index + 100, version_group_id: index + 100, enabled: 1,
    effective_from: "2026-10-20T00:00:00+08:00", effective_to: null,
    name: `OGL 陆运 ${rate.serviceClass}`, carrier: "OGL", channel: "economy", mode: "per_gram",
    min_weight_g: rate.minWeightG, max_weight_g: rate.maxWeightG,
    min_price_rub: rate.minPriceRub, max_price_rub: rate.maxPriceRub,
    base_fee_cny: 0, per_gram_cny: rate.perGramCny, per_ticket_cny: rate.perTicketCny
  }));
  const date = "2026-10-20T00:00:00+08:00";
  const payload = { carrier: "OGL", priceRub: 1000, weightG: 500, length: 20, width: 15, height: 10, exchangeRate: 10 };
  const quotes = quoteLogisticsRules(rules, payload, date);
  assert.equal(defaultLogisticsQuote(threeChannelQuotes(quotes)).name, "OGL 陆运 Extra Small");
  assert.equal(quotes.find((quote) => quote.name.endsWith("Extra Small")).priceCny, 16.9);
  assert.equal(oglElectronicServiceFeeRub(100), 15);
  assert.equal(oglElectronicServiceFeeRub(20000), 200);
  const [big] = quoteLogisticsRules(rules, { ...payload, priceRub: 5000, weightG: 2200,
    length: 100, width: 60, height: 6 }, date);
  assert.equal(big.chargeableWeightG, 3000);
  assert.equal(big.transportCny, 84);
  assert.equal(big.serviceFeeCny, 10);
  assert.equal(big.priceCny, 94);
  assert.equal(quoteLogisticsRules(rules, { ...payload, length: 201 }, date).length, 0);
});

test("OGL reads the parcel total from Ozon raw product prices", () => {
  assert.equal(oglParcelValueRub(JSON.stringify({ products: [
    { price: "200", quantity: 1 }, { price: "100", quantity: 2 }
  ] })), 400);
  assert.equal(oglParcelValueRub("invalid"), 0);
});

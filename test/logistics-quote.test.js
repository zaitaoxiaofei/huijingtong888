import test from "node:test";
import assert from "node:assert/strict";
import { quoteLogisticsRules } from "../frontend/admin/utils/logistics-quote.js";

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

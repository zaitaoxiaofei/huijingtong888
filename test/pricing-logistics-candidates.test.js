import test from "node:test";
import assert from "node:assert/strict";
import { pricingLogisticsCandidates } from "../frontend/admin/utils/pricing-logistics-candidates.js";

const at = new Date("2026-10-10T00:00:00+08:00");
const rule = {
  id: 7, version_group_id: 7, enabled: 1, effective_from: "2026-07-24 00:00:00", effective_to: null,
  name: "GUOO 标准 Small", carrier: "GUOO", channel: "standard", mode: "per_gram",
  min_weight_g: 1, max_weight_g: 500, min_price_rub: 1, max_price_rub: 5000,
  base_fee_cny: 0, per_gram_cny: 0.04, per_ticket_cny: 5
};
const form = {
  carrier: "GUOO", purchaseCost: 23, weight: 120, length: 11, width: 10, height: 10,
  exchangeRate: 12.6739, domesticCost: 0, adRate: 10, otherRate: 0,
  returnRate: 10, returnLoss: 0, targetMargin: 50, discountRate: 50
};

test("pricing automatically uses the valid rFBS tier when the initially selected lower tier cannot apply", () => {
  const quotes = pricingLogisticsCandidates([rule], form, [12, 17, 20.5], at);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].channel, "standard");
  assert.equal(quotes[0].band, 1);
  assert.equal(quotes[0].commissionRate, 17);
  assert.ok(quotes[0].saleRub > 1500 && quotes[0].saleRub <= 5000);
  assert.equal(quotes[0].priceCny, 9.8);
});

test("pricing still rejects package dimensions outside the current carrier rules", () => {
  assert.deepEqual(pricingLogisticsCandidates([rule], { ...form, length: 70 }, [12, 17, 20.5], at), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { estimateItemProfit } from "../src/profit.js";
import { getProfitFormula } from "../src/services/profit-formulas/registry.js";

const v1EstimateItemProfit = getProfitFormula("V1").estimateItemProfit;
const priceBoundaries = [49.99, 50, 50.01, 749.99, 750, 750.01];
const fallbackCommission = { commission_low: 0.123, commission_high: 0.178 };
const rawCommission = {
  sale_schema: "fbs",
  commissions_json: JSON.stringify([{ sale_schema: "fbo", percent: 9 }, { sale_schema: "fbs", percent: 17.5 }])
};
const product = {
  purchase_cost: 9.99, domestic_shipping: 1.23, purchase_quantity: 3, handling_fee: 0.5,
  package_weight_g: 300, length_cm: 12, width_cm: 10, height_cm: 8,
  exchange_rate: 12.3869, return_rate: 0.05, withdrawal_fee_rate: 0.012, advertising_rate: 0.02
};

function compareSuccessful(input, label) {
  const expected = estimateItemProfit(structuredClone(input));
  const actual = v1EstimateItemProfit(structuredClone(input));
  assert.deepEqual(actual, expected, label);
  assert.ok(Number.isFinite(actual.profit), `${label}: a successful quote must produce a finite profit`);
  return actual;
}

function errorMessage(calculate, input, label) {
  let captured;
  try { calculate(structuredClone(input)); } catch (error) { captured = error; }
  assert.ok(captured instanceof Error, `${label}: the invalid OGL sample must fail`);
  return captured.message;
}

test("V1 matches explicit logistics quotes at price thresholds with raw and fallback commissions (32 samples)", () => {
  let count = 0;
  for (const salePrice of [0, ...priceBoundaries, 150]) {
    for (const quantity of [1, 3]) {
      for (const mapping of [fallbackCommission, rawCommission]) {
        const result = compareSuccessful({ salePrice, quantity, mapping, product: {
          ...product, logistics_rule_id: 1, logistics_rule_name: "GUOO standard Extra Small",
          logistics_rule_carrier: "GUOO", logistics_rule_channel: "economy",
          logistics_rule_base_fee_cny: 0.13, logistics_rule_per_gram_cny: 0.0281, logistics_rule_per_ticket_cny: 3.37
        } }, `explicit price=${salePrice}, qty=${quantity}, commission=${mapping === rawCommission ? "ozon" : "fallback"}`);
        assert.equal(result.category, "GUOO standard Extra Small");
        assert.equal(result.commissionSource, mapping === rawCommission ? "ozon" : "fallback");
        count++;
      }
    }
  }
  assert.equal(count, 32);
});

test("V1 matches CEL fallback across channels, rate dates and price thresholds (36 samples)", () => {
  let count = 0;
  for (const salePrice of priceBoundaries) {
    for (const shipping_method of ["air", "air_land", "land"]) {
      for (const pricing_effective_at of ["2026-07-23T12:00:00Z", "2026-07-25T12:00:00Z"]) {
        const result = compareSuccessful({ salePrice, quantity: count % 2 ? 3 : 1,
          mapping: count % 2 ? rawCommission : fallbackCommission,
          product: { ...product, shipping_method, pricing_effective_at }
        }, `CEL price=${salePrice}, channel=${shipping_method}, effective=${pricing_effective_at}`);
        assert.ok(Object.hasOwn(result, "freight"), "the sample must reach the CEL quote branch");
        assert.ok(result.category);
        count++;
      }
    }
  }
  assert.equal(count, 36);
});

test("V1 matches manual freight when no rate can match, including multiple items (12 samples)", () => {
  let count = 0;
  for (const salePrice of priceBoundaries) {
    for (const quantity of [1, 3]) {
      const result = compareSuccessful({ salePrice, quantity, mapping: quantity === 1 ? fallbackCommission : rawCommission,
        product: { ...product, length_cm: 300, width_cm: 100, height_cm: 100, international_shipping: 8.765 }
      }, `manual price=${salePrice}, qty=${quantity}`);
      assert.equal(Object.hasOwn(result, "freight"), false, "oversized packages must use the manual fallback");
      count++;
    }
  }
  assert.equal(count, 12);
});

// Independent synthetic fixtures cover all six existing OGL bands. No production order data is used.
const oglCases = [
  ["Extra Small", 1, 500, 1, 1500, 2.8, 0.0242, 40, 500],
  ["Budget", 500, 35000, 1, 1500, 22.2, 0.0164, 500, 1000],
  ["Small", 1, 2000, 1501, 7000, 15.5, 0.0242, 300, 3000],
  ["Big", 2000, 35000, 1501, 7000, 34.8, 0.0164, 2200, 5000],
  ["Premium Small", 1, 5000, 7001, 250000, 21.3, 0.0242, 1000, 10000],
  ["Premium Big", 5001, 35000, 7001, 250000, 60, 0.0222, 5500, 20000]
];

function oglInput(fixture = oglCases[0], quantity = 1, parcelValueRub = fixture[8]) {
  const [serviceClass, minWeight, maxWeight, minPrice, maxPrice, ticketFee, gramFee, weight] = fixture;
  return {
    salePrice: parcelValueRub / product.exchange_rate / quantity, quantity,
    mapping: quantity === 1 ? fallbackCommission : rawCommission,
    product: { ...product, package_weight_g: weight, logistics_rule_id: 2, logistics_rule_carrier: "OGL",
      logistics_rule_name: `OGL land ${serviceClass}`, logistics_rule_channel: "economy",
      logistics_rule_base_fee_cny: 0, logistics_rule_per_gram_cny: gramFee, logistics_rule_per_ticket_cny: ticketFee,
      logistics_rule_min_weight_g: minWeight, logistics_rule_max_weight_g: maxWeight,
      logistics_rule_min_price_rub: minPrice, logistics_rule_max_price_rub: maxPrice,
      ...(quantity > 1 ? { ogl_parcel_value_rub: parcelValueRub } : {})
    }
  };
}

test("V1 matches OGL six bands, actual and volumetric weights, parcel allocation and minimum weight (15 samples)", () => {
  let count = 0;
  for (const fixture of oglCases) {
    for (const quantity of [1, 3]) {
      const result = compareSuccessful(oglInput(fixture, quantity), `OGL ${fixture[0]}, qty=${quantity}`);
      assert.ok(result.freight > 0);
      assert.equal(result.category, `OGL land ${fixture[0]}`);
      count++;
    }
  }
  for (const [fixture, dimensions] of [[oglCases[3], [100, 60, 6]], [oglCases[5], [120, 60, 10]]]) {
    const input = oglInput(fixture, 3);
    [input.product.length_cm, input.product.width_cm, input.product.height_cm] = dimensions;
    const result = compareSuccessful(input, `OGL ${fixture[0]} volumetric weight`);
    assert.ok(result.freight > fixture[7] * fixture[6] + fixture[5], "volumetric weight exceeds actual-weight transport cost");
    count++;
  }
  const minimumWeightInput = oglInput();
  minimumWeightInput.product.package_weight_g = 1;
  compareSuccessful(minimumWeightInput, "OGL minimum chargeable actual weight");
  assert.equal(++count, 15);
});

test("V1 matches OGL electronic service fee floors and caps on both sides of their boundaries (12 samples)", () => {
  let count = 0;
  for (const [fixture, values] of [[oglCases[0], [749.99, 750, 750.01]], [oglCases[4], [9999.99, 10000, 10000.01]]]) {
    for (const parcelValueRub of values) {
      for (const quantity of [1, 3]) {
        compareSuccessful(oglInput(fixture, quantity, parcelValueRub), `OGL service fee parcel=${parcelValueRub}, qty=${quantity}`);
        count++;
      }
    }
  }
  assert.equal(count, 12);
});

test("V1 rejects invalid OGL quotes with exactly the existing error message (8 samples)", () => {
  const invalidProducts = [
    { length_cm: 0 }, { length_cm: 201 }, { width_cm: 81, height_cm: 81 },
    { package_weight_g: 501 }, { ogl_parcel_value_rub: 0.99 }, { ogl_parcel_value_rub: 1500.01 },
    { exchange_rate: 0 }, { logistics_rule_name: "OGL unknown service class" }
  ];
  for (const overrides of invalidProducts) {
    const input = oglInput();
    Object.assign(input.product, overrides);
    const label = `invalid OGL ${JSON.stringify(overrides)}`;
    const expected = errorMessage(estimateItemProfit, input, label);
    assert.match(expected, /OGL/);
    assert.equal(errorMessage(v1EstimateItemProfit, input, label), expected, label);
  }
});

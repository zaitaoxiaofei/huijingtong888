import assert from "node:assert/strict";
import test from "node:test";
import { calculateCelFbsPricing } from "../src/celRates.js";

const extraSmall = {
  listing_price_rub: 1500,
  sale_rmb: 100,
  package_weight_g: 100,
  length_cm: 10,
  width_cm: 10,
  height_cm: 10
};

test("CEL V7.24 switches rates at Beijing midnight", () => {
  const before = calculateCelFbsPricing({ ...extraSmall, ordered_at: "2026-07-23T15:59:59Z" });
  const after = calculateCelFbsPricing({ ...extraSmall, ordered_at: "2026-07-23T16:00:00Z" });
  assert.equal(before.channels.find((row) => row.key === "standard")?.amount, 6.76);
  assert.equal(after.channels.find((row) => row.key === "standard")?.amount, 7.3);
});

test("CEL V7.24 Premium Big uses the quoted 12000 volumetric divisor", () => {
  const result = calculateCelFbsPricing({
    listing_price_rub: 8000,
    sale_rmb: 700,
    package_weight_g: 6000,
    length_cm: 40,
    width_cm: 40,
    height_cm: 60,
    ordered_at: "2026-07-24T00:00:00+08:00"
  });
  assert.equal(result.category, "Premium Big");
  assert.equal(result.volumetricWeightKg, 8);
  assert.equal(result.chargeableWeightKg, 8);
  assert.equal(result.channels.find((row) => row.key === "standard")?.amount, 320.84);
});

import assert from "node:assert/strict";
import test from "node:test";

import { detectOrderLogisticsCarrier } from "../src/services/order-logistics-carrier.js";

test("logistics carrier detects GUOO without requiring a detailed weight route", () => {
  assert.equal(detectOrderLogisticsCarrier("tpl_provider: GUOO"), "guoo");
  assert.equal(detectOrderLogisticsCarrier("GUOO Economy Extra Small"), "guoo");
});

test("logistics carrier detects CEL, Hunchun and postal families", () => {
  assert.equal(detectOrderLogisticsCarrier("CEL Economy Big"), "cel");
  assert.equal(detectOrderLogisticsCarrier("Hunchun 2"), "cel");
  assert.equal(detectOrderLogisticsCarrier("China Post"), "postal");
});

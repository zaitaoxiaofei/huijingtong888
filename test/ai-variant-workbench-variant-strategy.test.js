import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVariantStrategy,
  buildVariantTargets
} from "../frontend/admin/utils/aiVariantWorkbench/variantStrategy.js";

test("VariantStrategy expands all TENET models", () => {
  const targets = buildVariantTargets("TENET 全部车型");

  assert.deepEqual(targets.map((item) => item.label), ["TENET T4", "TENET T4L", "TENET T7", "TENET T8"]);
});

test("VariantStrategy splits comma, newline, ideographic comma, and semicolon targets", () => {
  const targets = buildVariantTargets("TENET T4, TENET T7\nBELGEE X70、HAVAL Jolion;CHERY TIGGO7");

  assert.deepEqual(targets.map((item) => item.label), [
    "TENET T4",
    "TENET T7",
    "BELGEE X70",
    "HAVAL JOLION",
    "CHERY TIGGO7"
  ]);
});

test("VariantStrategy outputs structured targets", () => {
  const [target] = buildVariantTargets("TENET T7");

  assert.deepEqual(target, {
    label: "TENET T7",
    brand: "TENET",
    model: "T7",
    rawText: "TENET T7"
  });
});

test("VariantStrategy keeps noFakeCompatibility enabled", () => {
  const strategy = buildVariantStrategy({
    variantType: "vehicle",
    rawTargets: "TENET T7",
    variantPlan: { commonDetailImages: true },
    categoryStrategy: { negativePrompt: "No fake compatibility." }
  });

  assert.equal(strategy.riskRules.noFakeCompatibility, true);
});

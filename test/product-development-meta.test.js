import assert from "node:assert/strict";
import test from "node:test";
import { resolveDevelopmentMeta, resolveDraftDevelopmentMeta, vehicleMetaFromTarget } from "../src/services/product-development-meta.js";

test("explicit material optimizer copy type wins over AI offer-id inference", () => {
  assert.deepEqual(resolveDevelopmentMeta({
    internal_code: "AI-OPT-A-793602",
    development_type: "copy"
  }), {
    development_type: "copy",
    vehicle_brand: "",
    vehicle_model: "",
    vehicle_model_key: ""
  });
});

test("legacy AI offer ids without an explicit type still infer fission", () => {
  const meta = resolveDevelopmentMeta({ internal_code: "AI-HONDA-VEZEL-001" });
  assert.equal(meta.development_type, "fission");
  assert.equal(meta.vehicle_brand, "HONDA");
  assert.equal(meta.vehicle_model, "VEZEL");
});

test("vehicle target keeps the real brand and full model instead of VAR offer prefix", () => {
  assert.deepEqual(vehicleMetaFromTarget("TENET PLUS L6"), {
    vehicle_brand: "TENET",
    vehicle_model: "PLUS L6",
    vehicle_model_key: "tenet-plusl6"
  });
  assert.deepEqual(vehicleMetaFromTarget("LYNK & CO 900"), {
    vehicle_brand: "LYNK & CO",
    vehicle_model: "900",
    vehicle_model_key: "lynkco-900"
  });
  assert.deepEqual(vehicleMetaFromTarget("VOLGA K40"), {
    vehicle_brand: "VOLGA",
    vehicle_model: "K40",
    vehicle_model_key: "volga-k40"
  });
  assert.equal(vehicleMetaFromTarget("奇瑞 瑞虎 7").vehicle_brand, "CHERY");
  assert.equal(vehicleMetaFromTarget("unknown accessory"), null);
});

test("fission draft uses target vehicle ahead of the source draft and offer prefix", () => {
  const meta = resolveDraftDevelopmentMeta({ internal_code: "VAR-TENET-PLUS-L6-123" }, {
    body: { ai_optimization: { target_variant_value: "TENET PLUS L6" } },
    sourceDraft: { vehicle_brand: "CHERY", vehicle_model: "TIGGO 7" },
    fallbackType: "fission"
  });
  assert.deepEqual(meta, {
    development_type: "fission",
    vehicle_brand: "TENET",
    vehicle_model: "PLUS L6",
    vehicle_model_key: "tenet-plusl6"
  });
});

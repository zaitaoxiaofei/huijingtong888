import assert from "node:assert/strict";
import test from "node:test";
import { resolveDevelopmentMeta } from "../src/services/product-development-meta.js";

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

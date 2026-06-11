import assert from "node:assert/strict";
import test from "node:test";
import { buildProductDNA } from "../frontend/admin/utils/aiVariantWorkbench/productDna.js";

test("ProductDNA records known brand, model, and material facts", () => {
  const dna = buildProductDNA({
    id: "p1",
    name: "TENET T7 threshold protector",
    category: "门槛条",
    brand: "TENET",
    model: "T7",
    material: "ABS",
    imageUrl: "/main.png"
  });

  assert.match(dna.constraints.knownFacts.join("\n"), /品牌: TENET/);
  assert.match(dna.constraints.knownFacts.join("\n"), /车型\/型号: T7/);
  assert.match(dna.constraints.knownFacts.join("\n"), /材质: ABS/);
});

test("ProductDNA moves missing material, color, quantity, and size into unknownFacts", () => {
  const dna = buildProductDNA({
    id: "p2",
    name: "TENET T7 threshold protector",
    category: "门槛条",
    brand: "TENET",
    model: "T7"
  });

  assert.ok(dna.constraints.unknownFacts.includes("材质"));
  assert.ok(dna.constraints.unknownFacts.includes("颜色"));
  assert.ok(dna.constraints.unknownFacts.includes("数量"));
  assert.ok(dna.constraints.unknownFacts.includes("尺寸"));
});

test("ProductDNA does not copy unknownFacts into knownFacts", () => {
  const dna = buildProductDNA({
    id: "p3",
    name: "Unknown material product",
    category: "汽车用品"
  });

  const knownText = dna.constraints.knownFacts.join("\n");
  for (const unknown of dna.constraints.unknownFacts) {
    assert.doesNotMatch(knownText, new RegExp(`${unknown}:\\s*$`));
  }
});

test("ProductDNA treats imported selection dimensions as known facts", () => {
  const dna = buildProductDNA({
    id: "p-selection",
    name: "Selection product",
    category: "Auto accessory",
    material: "ABS",
    color: "Black",
    lengthCm: 30,
    widthCm: 20,
    heightCm: 10,
    packageWeightG: 500,
    raw: {
      length_cm: 30,
      width_cm: 20,
      height_cm: 10,
      package_weight_g: 500
    }
  });

  const knownText = dna.constraints.knownFacts.join("\n");
  assert.match(knownText, /30/);
  assert.match(knownText, /20/);
  assert.match(knownText, /10/);
});

test("ProductDNA includes default forbidden claims", () => {
  const dna = buildProductDNA({ id: "p4", name: "Product" });

  assert.ok(dna.constraints.forbiddenClaims.includes("official authorization"));
  assert.ok(dna.constraints.forbiddenClaims.includes("unsupported compatibility"));
});

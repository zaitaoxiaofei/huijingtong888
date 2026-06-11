import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSafetyRules,
  buildPromptVariables,
  templateVariablesForRender
} from "../frontend/admin/utils/aiVariantWorkbench/promptRender.js";

function samplePromptVariables() {
  return buildPromptVariables({
    id: "r1",
    variantTarget: "TENET T7",
    product: {
      id: "p1",
      name: "TENET T7 threshold protector",
      category: "门槛条",
      brand: "TENET",
      model: "T7",
      material: "ABS"
    }
  }, "mainImage", {
    variantStrategy: {
      variantType: "vehicle",
      targets: [{ label: "TENET T7", brand: "TENET", model: "T7", rawText: "TENET T7" }],
      globalPrompt: "Keep material unchanged.",
      fieldRules: { mainImage: "Use OEM style." },
      riskRules: { negativePrompt: "No fake compatibility." }
    }
  });
}

test("templateVariablesForRender exposes core template variables", () => {
  const variables = templateVariablesForRender(samplePromptVariables());

  assert.ok(variables.productDNA);
  assert.ok(variables.variantStrategy);
  assert.equal(variables.field, "mainImage");
  assert.ok(variables.target);
  assert.ok(variables.riskRules);
});

test("appendSafetyRules appends noFabricationRules", () => {
  const rendered = appendSafetyRules("Prompt body", samplePromptVariables());

  assert.match(rendered, /No fabrication rules:/);
  assert.match(rendered, /Do not invent unknown product parameters/);
});

test("appendSafetyRules keeps unknownFacts warning", () => {
  const promptVariables = samplePromptVariables();
  promptVariables.productDNA.constraints.unknownFacts.push("颜色");
  const rendered = appendSafetyRules("Prompt body", promptVariables);

  assert.match(rendered, /Unknown facts must not be invented:/);
  assert.match(rendered, /颜色/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildGenerationSnapshot } from "../frontend/admin/utils/aiVariantWorkbench/generationSnapshot.js";

function makeSnapshot() {
  const row = {
    id: "r1",
    productId: "p1",
    sourceProductId: "base1",
    variantTarget: "TENET T7",
    variantType: "vehicle",
    title: "Title",
    tags: ["tag"],
    description: "Description"
  };
  row.self = row;
  return buildGenerationSnapshot({
    row,
    field: "title",
    promptVariables: {
      productDNA: { base: { brand: "TENET" } },
      variantStrategy: { variantType: "vehicle" },
      target: { label: "TENET T7", brand: "TENET", model: "T7", rawText: "TENET T7" },
      currentRow: row
    },
    renderedPrompt: "Rendered prompt",
    templateSource: "ai-prompt-template",
    templateId: 12,
    templateVersion: "v1",
    fallbackReason: ""
  });
}

test("GenerationSnapshot includes source, prompt, and generatedAt", () => {
  const snapshot = makeSnapshot();

  assert.equal(snapshot.templateSource, "ai-prompt-template");
  assert.equal(snapshot.renderedPrompt, "Rendered prompt");
  assert.ok(snapshot.generatedAt);
});

test("GenerationSnapshot stores lightweight currentRow summary without cycles", () => {
  const snapshot = makeSnapshot();

  assert.deepEqual(Object.keys(snapshot.promptVariables.currentRow).sort(), [
    "description",
    "id",
    "productId",
    "sourceProductId",
    "tags",
    "title",
    "variantTarget",
    "variantType"
  ].sort());
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test("GenerationSnapshot remains compatible with stage two fields", () => {
  const snapshot = makeSnapshot();

  assert.ok("productDNA" in snapshot);
  assert.ok("variantStrategy" in snapshot);
  assert.ok("field" in snapshot);
  assert.ok("target" in snapshot);
  assert.ok("promptVariables" in snapshot);
  assert.ok("templateId" in snapshot);
  assert.ok("templateVersion" in snapshot);
  assert.ok("fallbackReason" in snapshot);
});

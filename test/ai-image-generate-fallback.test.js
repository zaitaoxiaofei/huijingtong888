import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/server/services/ai/aiWorkflowService.js", import.meta.url), "utf8");

test("AI image generation builds a fallback prompt from product context", () => {
  assert.match(source, /buildImagePromptFallback\(payload\)/);
  assert.match(source, /payload\.variantTarget/);
  assert.match(source, /row\?\.productName/);
  assert.match(source, /Do not add unrelated vehicle models/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const taskSource = readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");
const frontendSource = readFileSync(new URL("../frontend/admin/api/tools/aiImageGenerator.js", import.meta.url), "utf8");

test("general AI image generation uses the persistent task worker", () => {
  assert.match(taskSource, /if \(\["mainImage", "detailImages"\]\.includes\(fieldKey\)\) \{/);
  assert.match(taskSource, /const output = await generateImages\(input\)/);
  assert.match(taskSource, /return persistGeneratedImageOutput\(output, input, fieldKey\)/);
  assert.match(taskSource, /finalPrompt: limitText/);
  assert.match(taskSource, /sourceImageUrl: cleanText/);
  assert.match(taskSource, /finalPrompt: value\.finalPrompt/);
  assert.match(frontendSource, /post\("\/api\/ai-generation\/tasks"/);
  assert.match(frontendSource, /fieldKey: "mainImage"/);
  assert.match(frontendSource, /\/api\/ai-generation\/tasks\?taskIds=/);
  assert.doesNotMatch(frontendSource, /post\("\/api\/ai\/generate-images"/);
});

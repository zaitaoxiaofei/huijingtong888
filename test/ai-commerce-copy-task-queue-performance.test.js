import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const taskSource = readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");
const frontendSource = readFileSync(new URL("../frontend/admin/api/tools/aiImageGenerator.js", import.meta.url), "utf8");

test("commerce copy generation uses the persistent AI task queue", () => {
  assert.match(taskSource, /"commerceCopy"/);
  assert.match(taskSource, /fieldKey === "commerceCopy"\) return generateCommerceCopy\(input\)/);
  assert.match(taskSource, /fieldKey === "commerceCopy"\) return fitJsonBytes\(pruneEmpty\(input\)/);
  assert.match(frontendSource, /fieldKey: "commerceCopy"/);
  assert.match(frontendSource, /sourceModule: "ai_commerce_copy"/);
  assert.doesNotMatch(frontendSource, /post\("\/api\/ai\/generate-commerce-copy"/);
});

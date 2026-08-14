import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/ai-variant-lab.js", import.meta.url), "utf8");
const runtimeLimiter = fs.readFileSync(new URL("../src/services/ai-image-runtime-limiter.js", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");

test("AI variant polling uses summary-only batch reads", () => {
  assert.match(view, /summaryOnly:\s*true/);
  assert.match(view, /\?summary=1/);
  assert.match(service, /const summaryOnly = !fullDetail/);
  assert.match(service, /summary_only:\s*true/);
});

test("legacy AI batch polling defaults to memory-safe summaries", () => {
  assert.match(service, /const fullDetail = \["1", "true"\]/);
  assert.match(view, /\?full=1/);
});

test("AI image workers do not retain full image results for the whole batch", () => {
  assert.doesNotMatch(service, /const results = \[\];[\s\S]{0,3000}results\.push\(result\)/);
  assert.match(service, /resultSummary\.push\(\{/);
  assert.match(service, /resultSummary\.length > 100/);
});

test("AI image generation concurrency has process-wide adaptive memory caps", () => {
  assert.match(service, /Math\.min\(4, positiveInteger\(options\.imageConcurrency/);
  assert.match(service, /adaptiveAiImageConcurrency\(Math\.max\(1, Math\.min\(poolMaxConcurrency/);
  assert.match(runtimeLimiter, /GLOBAL_CONCURRENCY_CAP[\s\S]*AI_IMAGE_GLOBAL_CONCURRENCY_CAP \|\| 12/);
  assert.match(runtimeLimiter, /rssMb >= 1400[\s\S]*limit = Math\.min\(limit, 1\)/);
  assert.match(runtimeLimiter, /state\.activeTotal >= adaptivePoolLimit/);
});

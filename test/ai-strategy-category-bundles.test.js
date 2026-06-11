import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/ai-strategies.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/aiStrategies.js", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../frontend/admin/api/settings/aiStrategies.js", import.meta.url), "utf8");

test("AI strategy library defines category tree and bundle tables", () => {
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS ai_strategy_category_nodes/);
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS ai_strategy_bundles/);
  assert.doesNotMatch(serviceSource, /CATEGORY_NODE_SEED/);
  assert.doesNotMatch(serviceSource, /STRATEGY_BUNDLE_SEED/);
  assert.doesNotMatch(serviceSource, /door-sill-stainless/);
});

test("AI strategy bundle matching and resolve routes are exposed", () => {
  assert.match(routeSource, /GET \/api\/ai-strategy-category-nodes/);
  assert.match(routeSource, /POST \/api\/ai-strategy-category-nodes/);
  assert.match(routeSource, /GET \/api\/ai-strategy-bundles/);
  assert.match(routeSource, /POST \/api\/ai-strategy-bundles\/match/);
  assert.match(routeSource, /services\.matchAiStrategyBundles/);
});

test("AI strategy bundle client API and plan selection contract exist", () => {
  assert.match(apiSource, /function listAiStrategyCategoryNodes/);
  assert.match(apiSource, /function createAiStrategyCategoryNode/);
  assert.match(apiSource, /function updateAiStrategyCategoryNode/);
  assert.match(apiSource, /function listAiStrategyBundles/);
  assert.match(apiSource, /function matchAiStrategyBundles/);
  assert.match(serviceSource, /bundleKey \|\| body\.bundle_key/);
  assert.match(serviceSource, /bundle:\s*selectedBundle/);
  assert.match(serviceSource, /resolveBundleStrategyKeys/);
  assert.match(serviceSource, /scoreBundleMatch/);
});

test("AI strategy bundle list qualifies joined table columns", () => {
  const bundleListSource = serviceSource.match(/export async function aiStrategyBundles[\s\S]*?export async function aiStrategyBundleDetail/)?.[0] || "";
  assert.match(bundleListSource, /b\.enabled = \?/);
  assert.match(bundleListSource, /b\.category_node_id = \?/);
  assert.match(bundleListSource, /LOWER\(b\.title\) LIKE \?/);
  assert.doesNotMatch(bundleListSource, /clauses\.push\("enabled = \?"/);
});

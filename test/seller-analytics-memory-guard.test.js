import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("../frontend/admin/views/analytics/SellerAnalyticsView.vue", import.meta.url), "utf8");

test("seller analytics polling uses lightweight run summaries", () => {
  assert.match(view, /getSellerAnalyticsCollectRuns\(\{[^}]*summary:\s*1/);
  assert.match(service, /String\(query\.summary \|\| query\.lightweight \|\| ''\) === '1'/);
  assert.match(service, /function summarizeCollectRun\(/);
});

test("seller analytics does not retain raw metric payloads in product caches", () => {
  const normalizer = service.slice(service.indexOf("function normalizeProductMetricItem"), service.indexOf("function pickMetricValue"));
  assert.doesNotMatch(normalizer, /raw:\s*item/);
  assert.match(service, /setInterval\(pruneExpiredAnalyticsCaches, 60 \* 1000\)\.unref\(\)/);
});

test("active collection polling refreshes analysis only after the run finishes", () => {
  const polling = view.slice(view.indexOf("function startPolling"), view.indexOf("function stopPolling"));
  assert.match(polling, /loadRunsMeta\(true\)/);
  assert.match(polling, /refreshData\(true, \{ refreshMeta: false \}\)/);
  assert.match(polling, /5000/);
});

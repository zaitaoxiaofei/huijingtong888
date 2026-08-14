import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");

test("seller analytics schema initialization is coalesced and cached", () => {
  assert.match(source, /let sellerAnalyticsSchemaReady = false/);
  assert.match(source, /let sellerAnalyticsSchemaPromise = null/);
  assert.match(source, /sellerAnalyticsSchemaPromise = ensureSellerAnalyticsSchemaOnce\(\)/);
});

test("seller analytics shares normalized products across pages and sorts", () => {
  assert.match(source, /const analysisInflight = new Map\(\)/);
  assert.match(source, /scope: 'normalized_products'/);
  assert.doesNotMatch(source.match(/const baseCacheQuery = \{[\s\S]*?\n  \}/)?.[0] || "", /keyword|sort_key|sort_order/);
  assert.match(source, /products: analyzedProducts/);
});

test("seller analytics analysis uses a lightweight snapshot read", () => {
  assert.match(source, /lightweight: true/);
  assert.match(source, /COALESCE\(response_body, raw_data\) AS response_body/);
  assert.match(source, /idx_seller_todos_all_list \(tenant_id, biz_date, score, updated_at\)/);
});

test("seller analytics prefers persisted metrics with a snapshot fallback", () => {
  assert.match(source, /async function buildAnalysisBaseFromPersistedMetrics/);
  assert.match(source, /idx_seller_metrics_tenant_captured \(tenant_id, captured_at\)/);
  assert.match(source, /ROW_NUMBER\(\) OVER/);
  assert.match(source, /query\.persisted_metrics \?\? query\.persistedMetrics/);
  assert.match(source, /source: String\(query\.persisted_metrics/);
});

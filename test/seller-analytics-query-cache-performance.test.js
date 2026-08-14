import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");

test("seller analytics coalesces repeated heavy enrichment queries with bounded cache", () => {
  assert.match(source, /const analyticsQueryCache = new Map\(\)/);
  assert.match(source, /const analyticsQueryInflight = new Map\(\)/);
  assert.match(source, /ANALYTICS_QUERY_CACHE_MAX_ENTRIES = 8/);
  assert.match(source, /cachedAnalyticsQuery\(cacheKey, \(\) => mysqlQuery/);
  assert.match(source, /cachedAnalyticsQuery\(cacheKey, \(\) => db\.getRepository\('FbsPosting'\)\.find/);
  assert.match(source, /while \(analyticsQueryCache\.size > ANALYTICS_QUERY_CACHE_MAX_ENTRIES\)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const masterSource = readFileSync(new URL("../src/services/mysql-master-data-cache.js", import.meta.url), "utf8");
const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const analyticsSource = readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");

test("seller auth binding probes are reused and concurrent saves are coalesced", () => {
  assert.match(analyticsSource, /AUTH_BINDING_PROBE_REUSE_MS = 5 \* 60 \* 1000/);
  assert.match(analyticsSource, /const authBindingSaveInflight = new Map\(\)/);
  assert.match(analyticsSource, /cookieFingerprint = cookie \? crypto\.createHash\('sha256'\)/);
  assert.match(analyticsSource, /if \(inflight\) return inflight/);
  assert.match(analyticsSource, /Date\.now\(\) - existingLastOkAt < AUTH_BINDING_PROBE_REUSE_MS/);
  assert.match(analyticsSource, /authBindingSaveInflight\.delete\(key\)/);
  assert.match(analyticsSource, /payload = null/);
});

test("long-lived runtime caches have explicit capacity bounds", () => {
  assert.match(masterSource, /MASTER_DATA_CACHE_MAX_ENTRIES = 120/);
  assert.match(masterSource, /masterDataCache\.size > MASTER_DATA_CACHE_MAX_ENTRIES/);
  assert.match(listingSource, /ATTRIBUTE_VALUE_MEMORY_CACHE_MAX_ENTRIES = 240/);
  assert.match(listingSource, /attributeValueMemoryCache\.size > ATTRIBUTE_VALUE_MEMORY_CACHE_MAX_ENTRIES/);
  assert.match(listingSource, /CATEGORY_ATTRIBUTE_ID_SET_CACHE_MAX_ENTRIES = 500/);
  assert.match(analyticsSource, /ANALYTICS_QUERY_CACHE_MAX_ENTRIES = 8/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("seller analytics browser profiles are isolated by tenant and store", async () => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seller-browser-profile-"));
  process.env.UPLOADS_ROOT = uploadsRoot;
  const module = await import(`../src/services/seller-analytics-browser-profiles.js?test=${Date.now()}`);
  const first = module.sellerAnalyticsBrowserProfileStatus({ store_id: "store-a" }, "tenant-a");
  const second = module.sellerAnalyticsBrowserProfileStatus({ store_id: "store-b" }, "tenant-a");
  const third = module.sellerAnalyticsBrowserProfileStatus({ store_id: "store-a" }, "tenant-b");

  assert.equal(first.configured, false);
  assert.equal(second.configured, false);
  assert.equal(third.configured, false);
  assert.equal(first.store_id, "store-a");
  assert.equal(second.store_id, "store-b");
  assert.equal(third.store_id, "store-a");
  assert.equal(first.running, false);
});

test("background seller analytics uses saved auth state with a managed isolated browser", () => {
  const source = fs.readFileSync(new URL("../src/services/seller-analytics-browser-profiles.js", import.meta.url), "utf8");
  assert.match(source, /const contextLaunches = new Map\(\)/);
  assert.match(source, /await chromium\.launch\(/);
  assert.match(source, /browser\.newContext\(\{[\s\S]*storageState:/);
  assert.match(source, /context\.storageState\(\)/);
});

test("seller analytics routes expose browser profile lifecycle", async () => {
  const source = fs.readFileSync(new URL("../src/server/routes/sellerAnalytics.js", import.meta.url), "utf8");
  assert.match(source, /GET \/api\/db\/seller-analytics\/browser-profile/);
  assert.match(source, /POST \/api\/db\/seller-analytics\/browser-profile\/prepare/);
  assert.match(source, /POST \/api\/db\/seller-analytics\/browser-profile\/confirm/);
});

test("scheduled seller analytics sync accepts a configured browser profile", () => {
  const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /sellerAnalyticsBrowserProfileStatus/);
  assert.match(source, /!browserProfile\?\.configured && \(!binding\?\.bound \|\| binding\?\.stale\)/);
  assert.match(source, /shopConcurrency = Math\.max\(1, Math\.min\(6/);
});

test("direct seller analytics sync accepts a configured browser profile without cookie binding", () => {
  const source = fs.readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");
  assert.match(source, /if \(!binding && !browserProfile\.configured\)/);
  assert.match(source, /browser_profile: browserProfile/);
});

test("seller analytics pagination stops before Ozon offset 1000", () => {
  const source = fs.readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");
  assert.match(source, /const SELLER_ANALYTICS_MAX_OFFSET = 1000/);
  assert.match(source, /if \(nextOffset >= SELLER_ANALYTICS_MAX_OFFSET\)/);
});

test("seller analytics snapshots do not duplicate successful response JSON", () => {
  const source = fs.readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");
  assert.match(source, /const keepDebugHeaders = Number\(responseStatus \|\| 0\) >= 400/);
  assert.match(source, /response_body: stringifyJson\(responseBody\)/);
  assert.match(source, /raw_data: null/);
});

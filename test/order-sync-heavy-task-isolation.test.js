import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("background synchronization uses independent module lanes", () => {
  assert.match(serverSource, /const backgroundModuleLanes = new Map\(\)/);
  assert.match(serverSource, /function claimBackgroundModuleLane\(moduleKey, jobKey\)/);
  assert.match(serverSource, /function releaseBackgroundModuleLane\(moduleKey, jobKey\)/);
  assert.doesNotMatch(serverSource, /backgroundHeavyTaskRunning/);
  assert.doesNotMatch(serverSource, /backgroundOrderTaskRunning/);

  const expectedLanes = {
    orders: ["order_status_sync", "cancelled_order_sync", "posting_detail_sync", "posting_detail_deep_sync"],
    analytics: ["analytics_refresh", "seller_analytics_daily_sync"],
    advertising: ["advertising_sync", "advertising_today_sync"],
    inventory: ["ozon_stock_sync"],
    listing: ["ozon_category_sync"]
  };
  for (const [moduleKey, jobKeys] of Object.entries(expectedLanes)) {
    for (const jobKey of jobKeys) {
      assert.match(serverSource, new RegExp(`claimBackgroundModuleLane\\("${moduleKey}", "${jobKey}"\\)`));
      assert.match(serverSource, new RegExp(`releaseBackgroundModuleLane\\("${moduleKey}", "${jobKey}"\\)`));
    }
  }
  assert.match(serverSource, /maxConcurrent: Math\.max\(5, Number\(config\.scheduledJobsMaxConcurrent \|\| 5\)\)/);
  assert.match(serverSource, /backgroundOrderSyncRunning\) return \{ skipped: true, reason: "already_running", retryDelaySeconds: 30 \}/);
});

test("seller analytics shop synchronization cannot occupy a scheduler slot forever", () => {
  assert.match(serverSource, /function withBackgroundOperationTimeout\(promise, timeoutMs/);
  assert.match(serverSource, /5 \* 60 \* 1000/);
  assert.match(serverSource, /withBackgroundOperationTimeout\(syncOneSellerAnalyticsShop\(/);
  assert.match(serverSource, /BACKGROUND_OPERATION_TIMEOUT/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const layout = read("../frontend/admin/layouts/AdminLayout.vue");
const selection = read("../frontend/admin/views/selection/SelectionView.vue");
const onlineProducts = read("../frontend/admin/views/inventory/OnlineProductsView.vue");
const analytics = read("../frontend/admin/views/analytics/SellerAnalyticsView.vue");
const aiRecords = read("../frontend/admin/views/listing/AiMaterialOptimizationRecordsView.vue");

test("workspace keep-alive cache is bounded", () => {
  assert.match(layout, /<KeepAlive :max="6">/);
});

test("cached polling pages pause while deactivated", () => {
  assert.match(selection, /onDeactivated\(stopListingJobPolling\)/);
  assert.match(onlineProducts, /onDeactivated\(stopOnlineProductSyncPolling\)/);
  assert.match(analytics, /onDeactivated\(\(\) => \{[\s\S]{0,160}stopPolling\(\);[\s\S]{0,160}stopPluginPolling\(\);/);
  assert.match(aiRecords, /onDeactivated\(stopRefreshTimer\)/);
});

test("cached polling pages resume only when activated", () => {
  assert.match(selection, /onActivated\(\(\) => \{[\s\S]{0,120}startListingJobPolling\(\)/);
  assert.match(onlineProducts, /onActivated\(async \(\) => \{/);
  assert.match(analytics, /onActivated\(\(\) => \{[\s\S]{0,120}startPolling\(\);/);
  assert.match(aiRecords, /onActivated\(startRefreshTimer\)/);
});

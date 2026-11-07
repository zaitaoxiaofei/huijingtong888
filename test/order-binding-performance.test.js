import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const composableSource = fs.readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const submitStart = pageSource.indexOf("async function submitInventoryDialog()");
const submitEnd = pageSource.indexOf("\nfunction ", submitStart);
const submitBlock = pageSource.slice(submitStart, submitEnd);

test("order binding submits the inventory recipe in the same request", () => {
  assert.match(submitBlock, /apiClient\.post\("\/api\/online-products\/bind"[\s\S]*inventory_recipe/);
  assert.doesNotMatch(submitBlock, /apiClient\.post\("\/api\/sku-inventory-recipes"/);
});

test("combined binding performs outbound sync once and defers historical profit work", () => {
  const bindBlock = serviceSource.match(/export async function bindOnlineProductMysql[\s\S]*?\n}\n\nfunction scheduleBindingProfitRecalculationMysql/)?.[0] || "";
  assert.match(bindBlock, /saveSkuInventoryRecipeMysql\([\s\S]*syncOutbound: false/);
  assert.equal((bindBlock.match(/syncOutboundForOpenOrdersMysql\(/g) || []).length, 1);
  assert.match(bindBlock, /scheduleBindingProfitRecalculationMysql\(mappingId\)/);
  assert.doesNotMatch(bindBlock, /await recalculateOrderItemsForMappingMysql/);
});

test("order binding bypasses stale list and count caches before completion", () => {
  assert.match(
    submitBlock,
    /ElMessage\.success\("库存绑定已更新"\);\s*resetInventoryDialog\(\);\s*await loadOrders\(\{ silent: true, forceRefresh: true, includeCounts: true \}\)/
  );
  assert.match(composableSource, /const showLoading = options\.silent !== true;\s*if \(showLoading\) loading\.value = true/);
  assert.match(composableSource, /if \(options\.forceRefresh\) \{[\s\S]*ordersListCache\.clear\(\)[\s\S]*ordersMetaCache\.clear\(\)/);
});

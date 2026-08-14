import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const declaredDependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies
};

test("removed legacy dependencies stay out of the runtime package", () => {
  for (const dependency of ["@zxing/library", "jimp", "openai"]) {
    assert.equal(declaredDependencies[dependency], undefined);
  }
});

test("superseded zero-reference modules stay removed", () => {
  const removedFiles = [
    "frontend/admin/views/tools/EcommerceImageSplitter.vue",
    "frontend/admin/views/procurement/ProcurementView.vue",
    "src/services/historical-profit-review.js",
    "src/services/order-profit-recalculation.js",
    "frontend/orders/components/OrdersBulkActions.vue",
    "frontend/orders/components/OrdersPagination.vue",
    "frontend/config/components/ConfigLegacyPlaceholder.vue",
    "frontend/admin/views/profit/ProfitView.vue",
    "frontend/admin/views/profit/ProfitDashboardView.vue",
    "frontend/admin/views/profit/ProfitRankingView.vue",
    "frontend/admin/components/profit/ProfitTrendChart.vue",
    "frontend/admin/views/procurement/InboundView.vue",
    "frontend/admin/components/listing/WatermarkPreview.vue",
    "frontend/admin/components/profit/ProfitModuleTabs.vue",
    "frontend/admin/components/inventory/InventorySectionTabs.vue",
    "frontend/admin/views/inventory/inventory-sections.js",
    "frontend/orders/main.js",
    "src/services/analytics-refresh-entry.js",
    "src/services/order-profit-detail-snapshots-entry.js",
    "src/services/inventory-entry.js",
    "src/services/orders-ops-entry.js",
    "src/services/catalog.js",
    "frontend/admin/utils/aiVariantWorkbench/index.js",
    "src/services/procurement.js",
    "src/services/sync.js",
    "src/services/sync-entry.js",
    "src/services/procurement-entry.js",
    "src/services/catalog-product-write-entry.js",
    "src/services/catalog-products-entry.js",
    "frontend/admin/views/profit/ProfitReconciliationView.vue"
  ];
  for (const file of removedFiles) {
    assert.equal(fs.existsSync(file), false, `${file} should remain removed`);
  }
});

test("customer message translation has no unreachable duplicate provider call", () => {
  const source = fs.readFileSync("src/services/customer-message-translation.js", "utf8");
  const runtimeSource = fs.readFileSync("src/services/mysql-runtime-services.js", "utf8");
  assert.doesNotMatch(source, /Translate the Russian customer message template into Chinese meaning/);
  assert.equal(
    source.match(/export async function translateCustomerMessageTemplateZh/g)?.length,
    1
  );
  assert.match(runtimeSource, /import \{ translateCustomerMessageTemplateZh \} from "\.\/customer-message-translation\.js"/);
});

test("mysql cutover keeps extracted domain logic outside the monolith", () => {
  const source = fs.readFileSync("src/services/mysql-cutover.js", "utf8");
  assert.match(source, /from "\.\/mysql-procurement-plan\.js"/);
  assert.match(source, /from "\.\/mysql-order-shipping-packages\.js"/);
  assert.match(source, /from "\.\/mysql-order-profit-detail-snapshots\.js"/);
  assert.match(source, /from "\.\/mysql-online-product-status\.js"/);
  assert.match(source, /from "\.\/mysql-online-product-sku\.js"/);
  assert.match(source, /from "\.\/mysql-inventory-alert-snapshots\.js"/);
  assert.match(source, /from "\.\/mysql-fbp-normalizers\.js"/);
  assert.match(source, /from "\.\/mysql-order-label-utils\.js"/);
  assert.match(source, /from "\.\/mysql-procurement-list\.js"/);
  assert.doesNotMatch(source, /export function normalizePurchasePlanMysql\(body/);
  assert.doesNotMatch(source, /export function buildSplitShippingPackagesMysql\(items/);
});

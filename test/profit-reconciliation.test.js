import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/server/routes/profit.js", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const riskView = readFileSync(new URL("../frontend/admin/views/profit/ProfitInventoryRisksView.vue", import.meta.url), "utf8");
const itemView = readFileSync(new URL("../frontend/admin/views/profit/ProfitOrderItemVariancesView.vue", import.meta.url), "utf8");
const inventoryView = readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");

test("profit reconciliation only compares signed finance-accrued order items", () => {
  assert.match(backend, /profitReconciliationMysql/);
  assert.match(backend, /profit_status, oi\.settlement_state, ''\) = 'accrued'/);
  assert.match(backend, /buildOrderOutcomeSql\("o", "mysql"\)/);
  assert.match(backend, /outcome\.deliveredSigned/);
  assert.match(route, /GET \/api\/profit-reconciliation/);
  assert.match(route, /GET \/api\/profit-reconciliation\/products/);
  assert.match(route, /GET \/api\/profit-reconciliation\/items/);
  assert.match(runtime, /profitReconciliation: profitReconciliationMysql/);
});

test("profit reconciliation exposes inventory evidence and component variances", () => {
  assert.match(backend, /missing_weight/);
  assert.match(backend, /shipping_method_mismatch/);
  assert.match(backend, /logistics_variance/);
  assert.match(backend, /purchase_variance/);
  assert.match(backend, /flag_counts/);
  assert.match(backend, /profitReconciliationMysql\(query = \{\}\)[\s\S]*?const productId = Number\(query\.productId \|\| query\.product_id \|\| 0\);/);
  assert.match(riskView, /库存利润风险/);
  assert.match(riskView, /编辑库存/);
  assert.match(riskView, /重算预估/);
  assert.match(itemView, /订单商品行差异/);
  assert.match(itemView, /真实利润/);
  assert.match(itemView, /只看库存问题/);
  assert.match(itemView, /shanghaiDateTimeText\(row\.delivered_at\)/);
  assert.match(itemView, /逐项利润对比/);
  assert.match(itemView, /采购成本/);
  assert.match(itemView, /国际运费/);
  assert.match(itemView, /判断与下一步/);
  assert.match(backend, /estimated_packaging_cost/);
  assert.match(backend, /actual_ozon_service_fee/);
  assert.match(inventoryView, /recalculateAfterSave/);
});

test("profit reconciliation keeps Ozon transport fees separate from service fees", () => {
  assert.match(backend, /marketplaceredistributionofdeliveryservicesoperation/);
  assert.match(backend, /agencyfeeaggregator3plglobal/);
  assert.match(backend, /marketplaceserviceitemredistributionlastmile/);
  assert.match(backend, /COALESCE\(opi\.international_shipping_cny, 0\) AS actual_international_shipping/);
  assert.match(backend, /COALESCE\(opi\.ozon_service_fee_cny, 0\) AS actual_ozon_service_fee/);
  assert.doesNotMatch(
    backend,
    /COALESCE\(opi\.ozon_service_fee_cny,\s*opi\.international_shipping_cny/
  );
});

test("profit reconciliation resolves latest order status through the current order index", () => {
  assert.match(backend, /LEFT JOIN order_status_history osh ON osh\.id = \(\s*SELECT MAX\(latest_history\.id\)/);
  assert.doesNotMatch(backend, /SELECT order_id, MAX\(id\) AS latest_id FROM order_status_history GROUP BY order_id/);
  assert.match(backend, /const shopsPromise = shopsMysql\(\)/);
});

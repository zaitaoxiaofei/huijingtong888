import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const dashboard = source("../frontend/admin/views/DashboardView.vue");
const billing = source("../frontend/admin/views/profit/MonthlyBillingDetailsView.vue");
const ordersToolbar = source("../frontend/orders/components/OrdersToolbar.vue");
const aftersales = source("../frontend/admin/views/profit/ProfitAftersalesView.vue");
const inventoryRisks = source("../frontend/admin/views/profit/ProfitInventoryRisksView.vue");
const orderVariances = source("../frontend/admin/views/profit/ProfitOrderItemVariancesView.vue");
const carHeatmap = source("../frontend/admin/views/analytics/OrderCarHeatmapView.vue");
const financeCenter = source("../frontend/admin/views/finance/FinanceCenterView.vue");
const advertising = source("../frontend/admin/views/advertising/AdvertisingDailyView.vue");
const sellerAnalytics = source("../frontend/admin/views/analytics/SellerAnalyticsView.vue");
const inventoryView = source("../frontend/admin/views/inventory/InventoryView.vue");
const inventoryToolbar = source("../frontend/admin/components/inventory/InventoryPageToolbar.vue");
const purchaseList = source("../frontend/admin/views/procurement/PurchaseListView.vue");
const purchaseHistory = source("../frontend/admin/views/procurement/PurchaseHistoryView.vue");
const standard = source("../docs/FRONTEND_INTERACTION_DESIGN_STANDARD.md");

test("sample pages share the ERP interaction primitives", () => {
  assert.match(dashboard, /class="dashboard-date-control"/);
  assert.match(dashboard, /<el-date-picker/);
  assert.match(billing, /ErpPageHeader/);
  assert.match(billing, /ErpFilterBar/);
  assert.match(billing, /ErpPeriodSwitcher/);
  assert.match(ordersToolbar, /orders-toolbar-btn-primary/);
  assert.match(ordersToolbar, /orders-toolbar-btn-secondary/);
});

test("finance and analytics migration uses shared headers and filter bars", () => {
  for (const page of [aftersales, inventoryRisks, orderVariances, carHeatmap]) {
    assert.match(page, /ErpPageHeader/);
    assert.match(page, /ErpFilterBar/);
  }
});

test("complex finance and analytics pages adopt shared interaction boundaries", () => {
  assert.match(financeCenter, /ErpPageHeader/);
  for (const page of [advertising, sellerAnalytics]) {
    assert.match(page, /ErpPageHeader/);
    assert.match(page, /ErpFilterBar/);
  }
});

test("inventory and procurement pages adopt shared interaction boundaries", () => {
  assert.match(inventoryView, /ErpPageHeader/);
  assert.match(inventoryToolbar, /ErpFilterBar/);
  for (const page of [purchaseList, purchaseHistory]) {
    assert.match(page, /ErpPageHeader/);
    assert.match(page, /ErpFilterBar/);
  }
});

test("design standard protects frontend and backend boundaries", () => {
  assert.match(standard, /不得改变 API、数据库、利润计算或任务执行逻辑/);
  assert.match(standard, /PageFooterPagination/);
  assert.match(standard, /ErpPageHeader/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const layout = source("../frontend/admin/layouts/AdminLayout.vue");
const globalStyles = source("../frontend/admin/styles/index.css");
const inventoryToolbar = source("../frontend/admin/components/inventory/InventoryPageToolbar.vue");
const publishRecords = source("../frontend/admin/views/listing/ListingPublishRecordsView.vue");
const dashboard = source("../frontend/admin/views/DashboardView.vue");
const ordersTable = source("../frontend/orders/components/OrdersTable.vue");
const ordersStyles = source("../frontend/orders/orders-view.css");
const appStore = source("../frontend/admin/stores/app.js");
const router = source("../frontend/admin/router/index.js");
const mobileLayout = source("../frontend/admin/layouts/MobileLayout.vue");
const mobileHome = source("../frontend/admin/views/mobile/MobileHomeView.vue");
const pageHeader = source("../frontend/admin/components/ErpPageHeader.vue");
const filterBar = source("../frontend/admin/components/ErpFilterBar.vue");
const settings = source("../frontend/admin/views/settings/SettingsView.vue");
const mobileInventory = source("../frontend/admin/views/mobile/MobileInventoryView.vue");
const inventoryProducts = source("../frontend/admin/views/inventory/InventoryProductsPage.vue");
const mobileStockAlerts = source("../frontend/admin/views/mobile/MobileStockAlertsView.vue");
const inventoryAlerts = source("../frontend/admin/views/inventory/InventoryAlertsPage.vue");
const mobileOnlineProducts = source("../frontend/admin/views/mobile/MobileOnlineProductsView.vue");
const onlineProducts = source("../frontend/admin/views/inventory/OnlineProductsView.vue");
const inventoryFbp = source("../frontend/admin/views/inventory/InventoryFbpPage.vue");
const inventoryHidden = source("../frontend/admin/views/inventory/InventoryHiddenPage.vue");
const inventorySuppliers = source("../frontend/admin/views/inventory/InventorySuppliersPage.vue");
const purchaseList = source("../frontend/admin/views/procurement/PurchaseListView.vue");
const platformOrders = source("../frontend/admin/views/procurement/ProcurementPlatformOrdersView.vue");
const listingAutomation = source("../frontend/admin/views/listing/ListingAutomationView.vue");
const sellerAnalytics = source("../frontend/admin/views/analytics/SellerAnalyticsView.vue");
const selection = source("../frontend/admin/views/selection/SelectionView.vue");
const orderCarHeatmap = source("../frontend/admin/views/analytics/OrderCarHeatmapView.vue");
const advertising = source("../frontend/admin/views/advertising/AdvertisingDailyView.vue");
const materialCenter = source("../frontend/admin/views/settings/MaterialCenterView.vue");
const scheduledJobs = source("../frontend/admin/views/settings/ScheduledJobsView.vue");
const ozonActions = source("../frontend/admin/views/marketing/OzonActionsView.vue");

test("mobile admin navigation uses an overlay drawer without changing desktop collapse state", () => {
  assert.match(layout, /window\.matchMedia\("\(max-width: 1100px\), \(max-width: 1366px\) and \(any-pointer: coarse\)"\)/);
  assert.match(layout, /is-mobile-navigation-open/);
  assert.match(layout, /erp-mobile-navigation-mask/);
  assert.match(layout, /function handleNavigationToggle\(\)/);
  assert.match(globalStyles, /\.erp-shell\.is-mobile-navigation-open \.erp-sidebar/);
  assert.match(globalStyles, /transform: translateX\(-102%\)/);
});

test("mobile shared layout prevents dialogs and dense tables from squeezing the viewport", () => {
  assert.match(globalStyles, /width: calc\(100vw - 20px\) !important/);
  assert.match(globalStyles, /-webkit-overflow-scrolling: touch/);
  assert.match(globalStyles, /\.inventory-page-shell \.erp-data-table[\s\S]*?min-width: 980px/);
  assert.match(inventoryToolbar, /@media \(max-width: 760px\)/);
  assert.match(inventoryToolbar, /grid-template-columns: 1fr/);
});

test("listing drafts and publish records keep filters usable and tables scrollable on phones", () => {
  assert.match(publishRecords, /@media \(max-width: 760px\)/);
  assert.match(publishRecords, /\.toolbar-filters,[\s\S]*?grid-template-columns: 1fr/);
  assert.match(publishRecords, /\.publish-table,[\s\S]*?min-width: 1080px/);
});

test("dense phone tables recommend landscape and disable fixed columns that cover content", () => {
  assert.match(ordersTable, /mobile-landscape-hint/);
  assert.match(globalStyles, /\.mobile-landscape-hint/);
  assert.match(globalStyles, /\.el-table-fixed-column--right[\s\S]*?position: static !important/);
  assert.match(ordersStyles, /\.orders-table[\s\S]*?min-width: 1480px/);
  assert.match(ordersStyles, /\.orders-table \.el-table__fixed-right[\s\S]*?display: none !important/);
});

test("dashboard phone layout contains wide date controls and page content", () => {
  assert.match(dashboard, /\.commerce-dashboard \{[\s\S]*?overflow-x: hidden/);
  assert.match(dashboard, /\.dashboard-date-control \{[\s\S]*?grid-template-columns: 32px minmax\(0, 1fr\) 32px/);
  assert.match(dashboard, /\.dashboard-date-control__today[\s\S]*?display: none/);
});

test("responsive foundation classifies windows and changes density without scaling the canvas", () => {
  assert.match(appStore, /if \(width < 768\) return "compact"/);
  assert.match(appStore, /if \(width < 1101\) return "medium"/);
  assert.match(appStore, /if \(width < 1280\) return "compact-desktop"/);
  assert.match(appStore, /if \(width < 1600\) return "standard"/);
  assert.match(appStore, /document\.documentElement\.dataset\.density/);
  const responsiveFoundation = globalStyles.slice(globalStyles.indexOf("/* Responsive foundation:"));
  assert.doesNotMatch(responsiveFoundation, /transform:\s*scale\(/);
});

test("mobile redirect preserves the requested desktop route", () => {
  assert.match(router, /desktopTarget:\s*to\.fullPath/);
});

test("mobile workbench has a real home route and four touch navigation targets", () => {
  assert.match(router, /name: "mobile-home", component: MobileHomeView/);
  assert.match(mobileLayout, /to="\/mobile"/);
  assert.match(mobileLayout, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(mobileHome, /继续访问原页面/);
  assert.match(mobileHome, /\/mobile\/orders\?status=unbound/);
});

test("shared headers and filters keep laptop layouts horizontal until tablet width", () => {
  assert.match(pageHeader, /@media \(max-width: 1100px\), \(max-width: 1366px\) and \(any-pointer: coarse\)/);
  assert.match(filterBar, /@media \(max-width: 1100px\), \(max-width: 1366px\) and \(any-pointer: coarse\)/);
  assert.match(filterBar, /\.erp-filter-bar :deep\(\.el-date-editor\)/);
});

test("settings forms remove fixed label offsets on phones", () => {
  assert.match(settings, /@media \(max-width: 767px\)/);
  assert.match(settings, /\.el-form-item__label[\s\S]*?width: auto !important/);
  assert.match(settings, /\.el-form-item__content[\s\S]*?margin-left: 0 !important/);
});

test("mobile inventory reuses the paged product API and presents stock as cards", () => {
  assert.match(router, /name: "mobile-inventory", component: MobileInventoryView/);
  assert.match(mobileLayout, /to="\/mobile\/inventory"/);
  assert.match(mobileInventory, /\/api\/products\?\$\{buildParams\(nextPage\)\.toString\(\)\}/);
  assert.match(mobileInventory, /class="mobile-inventory-card__stocks"/);
  assert.match(mobileInventory, /pageSize = 20/);
});

test("inventory desktop table uses the shared keyboard-accessible responsive frame", () => {
  assert.match(inventoryProducts, /inventory-table-wrap erp-responsive-table/);
  assert.match(inventoryProducts, /aria-label="库存商品表格" tabindex="0"/);
  assert.match(globalStyles, /\.erp-responsive-table[\s\S]*?overflow-x: auto/);
  assert.match(globalStyles, /\.erp-responsive-table:focus-visible/);
});

test("mobile stock alerts reuse the paged alert API and expose operational metrics", () => {
  assert.match(router, /name: "mobile-stock-alerts", component: MobileStockAlertsView/);
  assert.match(mobileStockAlerts, /mode: "fbp-alerts"/);
  assert.match(mobileStockAlerts, /\/api\/stock-alerts\?\$\{params\(nextPage\)\.toString\(\)\}/);
  assert.match(mobileStockAlerts, /FBP可售/);
  assert.match(mobileStockAlerts, /建议备货/);
});

test("inventory alerts use the shared responsive table frame", () => {
  assert.match(inventoryAlerts, /inventory-table-wrap erp-responsive-table/);
  assert.match(inventoryAlerts, /aria-label="库存预警表格" tabindex="0"/);
});

test("mobile online products reuse the paged desktop API without exposing mutations", () => {
  assert.match(router, /name: "mobile-online-products", component: MobileOnlineProductsView/);
  assert.match(mobileHome, /route: "\/mobile\/online-products"/);
  assert.match(mobileOnlineProducts, /\/api\/online-products\?\$\{buildParams\(nextPage\)\.toString\(\)\}/);
  assert.match(mobileOnlineProducts, /FBS可售/);
  assert.match(mobileOnlineProducts, /绑定库存/);
  assert.doesNotMatch(mobileOnlineProducts, /apiClient\.(post|put|patch|delete)/);
});

test("online products desktop table uses the shared responsive frame", () => {
  assert.match(onlineProducts, /online-table-wrap erp-table-scroll erp-responsive-table/);
  assert.match(onlineProducts, /aria-label="在线商品表格" tabindex="0"/);
});

test("full-site responsive safety net covers generic pages, filters, tables and summaries", () => {
  assert.match(globalStyles, /\/\* Full-site responsive safety net\./);
  assert.match(globalStyles, /@media \(max-width: 1100px\), \(max-width: 1366px\) and \(any-pointer: coarse\)[\s\S]*?\.erp-workspace-panel > \*/);
  assert.match(globalStyles, /\.el-form--inline[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(globalStyles, /\.tracking-table[\s\S]*?overflow-x: auto/);
  assert.match(globalStyles, /\.order-tracking-page \.summary-strip[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(globalStyles, /\.procurement-workspace \.create-layout[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(globalStyles, /@media \(max-width: 420px\)[\s\S]*?\.el-message-box/);
});

test("second-wave inventory and procurement tables use accessible responsive frames", () => {
  assert.match(inventoryFbp, /inventory-table-wrap erp-responsive-table[\s\S]*?aria-label="FBP 库存表格"/);
  assert.match(inventoryHidden, /aria-label="已隐藏商品表格" tabindex="0"/);
  assert.match(inventorySuppliers, /aria-label="供应商表格" tabindex="0"/);
  assert.match(purchaseList, /list-wrap erp-responsive-table[\s\S]*?aria-label="待入库采购表格"/);
  assert.match(platformOrders, /platform-orders-table erp-responsive-table[\s\S]*?aria-label="平台采购订单表格"/);
  assert.match(purchaseList, /@media \(max-width: 767px\)[\s\S]*?\.purchase-inline-editor[\s\S]*?min-width: 920px/);
});

test("complex workbenches preserve full canvases with explicit phone reflow or local scrolling", () => {
  assert.match(listingAutomation, /@media \(max-width: 767px\)[\s\S]*?\.variant-image-workbench[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(listingAutomation, /\.variant-video-card,[\s\S]*?\.product-result,[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(sellerAnalytics, /@media \(max-width: 767px\)[\s\S]*?\.seller-sync-assistant__steps[\s\S]*?overflow-x: auto/);
  assert.match(sellerAnalytics, /\.seller-funnel-flow \{ min-width: 560px/);
  assert.match(selection, /@media \(max-width: 767px\)[\s\S]*?\.selection-preview-row[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
});

test("tablet headers use an overlay sidebar and reflow dense page toolbars", () => {
  assert.match(globalStyles, /@media \(max-width: 1100px\), \(max-width: 1366px\) and \(any-pointer: coarse\)[\s\S]*?\.erp-sidebar[\s\S]*?position: fixed/);
  assert.match(publishRecords, /@media \(max-width: 1280px\)[\s\S]*?\.toolbar-actions[\s\S]*?flex-wrap: wrap/);
  assert.match(selection, /@media \(max-width: 1100px\), \(max-width: 1366px\) and \(any-pointer: coarse\)[\s\S]*?\.selection-filter-panel :deep\(\.el-form\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(sellerAnalytics, /@media \(max-width: 1100px\), \(max-width: 1366px\) and \(any-pointer: coarse\)[\s\S]*?\.seller-toolbar__filters[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(dashboard, /@media \(max-width: 980px\), \(max-width: 1366px\) and \(any-pointer: coarse\)[\s\S]*?\.hero-core-grid/);
});

test("remaining analytics, advertising, material and operations pages have phone endpoints", () => {
  assert.match(orderCarHeatmap, /@media \(max-width: 420px\)[\s\S]*?\.car-heatmap-summary/);
  assert.match(advertising, /@media \(max-width: 767px\)[\s\S]*?\.health-metrics/);
  assert.match(materialCenter, /@media \(max-width: 420px\)[\s\S]*?\.material-grid/);
  assert.match(scheduledJobs, /@media \(max-width: 600px\)[\s\S]*?\.scheduled-metrics/);
  assert.match(ozonActions, /@media \(max-width: 420px\)[\s\S]*?\.cleanup-metrics/);
});

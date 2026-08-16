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

test("mobile admin navigation uses an overlay drawer without changing desktop collapse state", () => {
  assert.match(layout, /window\.matchMedia\("\(max-width: 760px\)"\)/);
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

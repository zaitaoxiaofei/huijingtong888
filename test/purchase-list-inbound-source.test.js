import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const purchaseListSource = readFileSync(new URL("../frontend/admin/views/procurement/PurchaseListView.vue", import.meta.url), "utf8");
const purchaseHistorySource = readFileSync(new URL("../frontend/admin/views/procurement/PurchaseHistoryView.vue", import.meta.url), "utf8");

test("purchase list pagination request survives same-page route query synchronization", () => {
  assert.match(purchaseListSource, /apiClient\.get\(`\/api\/inbound-records\?\$\{procurementQueryString\(\)\}`,[\s\S]*routeScoped: false/);
});
const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");

test("pending inbound list reads and updates actual inbound records", () => {
  assert.match(purchaseListSource, /status: "pending_arrival"/);
  assert.match(purchaseListSource, /api\/inbound-records\?\$\{procurementQueryString\(\)\}/);
  assert.match(purchaseListSource, /api\/inbound-records\/batch-update/);
  assert.doesNotMatch(purchaseListSource, /api\/procurement\/requests\/direct-inbound/);
});

test("pending inbound records sort by latest purchase time", () => {
  assert.match(serviceSource, /po\.purchased_at/);
  assert.match(serviceSource, /ORDER BY COALESCE\(po\.purchased_at, ir\.created_at\) DESC, ir\.id DESC/);
});

test("pending inbound and inbound history reuse precise inventory filters", () => {
  for (const pageSource of [purchaseListSource, purchaseHistorySource]) {
    assert.match(pageSource, /InventoryStructuredSearch/);
    for (const field of ["demandType", "personId", "supplierId", "sourceType", "inventoryCategory", "vehicleBrand", "vehicleModel", "accessoryName", "color", "material", "process"]) {
      assert.match(pageSource, new RegExp(field));
    }
  }
  assert.match(serviceSource, /function inboundRecordsWhereMysql/);
  assert.match(serviceSource, /inbound_direct_order/);
  assert.match(serviceSource, /inbound_direct_warning/);
  assert.match(serviceSource, /p\.inventory_category = \?/);
  assert.match(serviceSource, /p\.accessory_name = \?/);
  assert.match(serviceSource, /p\.surface_process = \?/);
});

test("procurement navigation follows the operational sequence", () => {
  const labels = ["采购工作台", "待入库清单", "入库记录", "成本预警", "采购对账", "平台订单", "供应商"];
  let previous = -1;
  for (const label of labels) {
    const index = navigationSource.indexOf(`label: "${label}"`, previous + 1);
    assert.ok(index > previous, `${label} should appear after the previous procurement menu item`);
    previous = index;
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

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

test("inbound list uses receipt time for approved and purchase time for pending and all", async () => {
  const block = serviceSource.slice(serviceSource.indexOf("export async function inboundRecordsMysql("), serviceSource.indexOf("function inboundRecordsWhereMysql("))
    .replace("export async function", "async function");
  const statements = [];
  const read = vm.runInNewContext(`${block};inboundRecordsMysql`, {
    ensureMysqlCutoverEnabled: () => {}, ensureInboundRecordTimestampSchemaMysql: async () => {},
    ensurePurchaseOrderShipmentSchemaMysql: async () => {},
    inboundRecordsWhereMysql: () => ({ whereSql: "", params: [] }),
    mysqlQueryOne: async () => ({ total: 0 }),
    mysqlQuery: async (sql) => { statements.push(sql); return []; }
  });
  for (const status of ["pending_arrival", "approved", "all"]) {
    for (const paged of ["0", "1"]) {
      await read({ status, paged });
      const sql = statements.pop();
      const expected = status === "approved"
        ? "COALESCE(ir.approved_at, ir.received_at) DESC, ir.id DESC"
        : "COALESCE(po.purchased_at, ir.created_at) DESC, ir.id DESC";
      assert.match(sql, new RegExp(`ORDER BY ${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  }
});

test("purchase list shows each record's actual status and approved time", () => {
  assert.match(purchaseListSource, /row\.status === "approved"\) return "已入库"/);
  assert.match(purchaseListSource, /label: "入库时间", value: row\.approved_at \|\| row\.received_at/);
  assert.match(purchaseListSource, /<ErpPageHeader title="待入库清单"/);
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

test("purchase list stays in inventory navigation", () => {
  assert.match(navigationSource, /key: "purchase-list", label: "待入库清单", route: "\/purchase-list"/);
  assert.ok(navigationSource.indexOf('key: "purchase-list"') < navigationSource.indexOf('key: "procurement"'));
});

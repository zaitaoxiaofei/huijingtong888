import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backend = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const inventoryPage = await readFile(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const workspace = await readFile(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");

test("warehouse procurement applications retain their own type and reason without creating an inbound purchase", () => {
  assert.match(backend, /createWarehouseProcurementRequestsMysql/);
  assert.match(backend, /'warehouse_request'/);
  assert.match(backend, /request_reason_code/);
  assert.match(backend, /amount, shipping_amount[\s\S]*0, 0/);
  assert.match(routes, /POST \/api\/procurement\/warehouse-requests/);
});

test("inventory can submit selected products and purchasing can filter warehouse applications", () => {
  assert.match(inventoryPage, /提交采购需求/);
  assert.match(inventoryPage, /WarehouseProcurementRequestDialog/);
  assert.match(workspace, /库存采购申请/);
  assert.match(workspace, /warehouse_request/);
  assert.match(workspace, /拒绝申请/);
  assert.match(workspace, /status: "cancelled"/);
});

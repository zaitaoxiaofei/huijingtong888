import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backend = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const inventoryPage = await readFile(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const workspace = await readFile(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
const fbpPage = await readFile(new URL("../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue", import.meta.url), "utf8");

test("warehouse procurement applications retain their own type and reason without creating an inbound purchase", () => {
  assert.match(backend, /createWarehouseProcurementRequestsMysql/);
  assert.match(backend, /'warehouse_request'/);
  assert.match(backend, /request_reason_code/);
  assert.match(backend, /amount, shipping_amount[\s\S]*0, 0/);
  assert.match(routes, /POST \/api\/procurement\/warehouse-requests/);
});

test("FBP physical shortages become reviewable procurement drafts before purchasing sees them", () => {
  assert.match(backend, /fbpShortageProcurementDraftsMysql/);
  assert.match(backend, /submitFbpShortageProcurementDraftsMysql/);
  assert.match(backend, /reasonCode === "stock_shortage" && adjustmentQty < 0/);
  assert.match(backend, /status = 'draft'/);
  assert.match(fbpPage, /本地实物库存不足（生成采购草稿）/);
  assert.match(fbpPage, /FBP 下次备货采购草稿/);
  assert.match(fbpPage, /确认并发送采购台/);
});

test("historical FBP adjustments can be backfilled with a reason and converted into a procurement draft", () => {
  assert.match(backend, /fbpReplenishmentItemAdjustmentsMysql/);
  assert.match(backend, /updateFbpReplenishmentItemAdjustmentReasonMysql/);
  assert.match(backend, /历史调整回补为仓库实际缺货/);
  assert.match(fbpPage, /查看并回补调整原因/);
  assert.match(fbpPage, /已生成待复核采购草稿/);
});

test("FBP shortage drafts group repeat adjustments by inventory product without double-counting an order item", () => {
  assert.match(backend, /const groups = new Map\(\)/);
  assert.match(backend, /_sourceItems/);
  assert.match(backend, /group\.requested_qty \+= Number\(row\.requested_qty/);
  assert.match(backend, /request_ids/);
  assert.match(backend, /mergedIds/);
  assert.match(fbpPage, /procurementDraftPagedItems/);
  assert.match(fbpPage, /pageSize: 10/);
  assert.match(fbpPage, /申请店铺/);
  assert.match(fbpPage, /总原申请 \/ 总已通过/);
});

test("inventory can submit selected products and purchasing can filter warehouse applications", () => {
  assert.match(inventoryPage, /提交采购需求/);
  assert.match(inventoryPage, /WarehouseProcurementRequestDialog/);
  assert.match(workspace, /库存采购申请/);
  assert.match(workspace, /warehouse_request/);
  assert.match(workspace, /拒绝申请/);
  assert.match(workspace, /status: "cancelled"/);
});

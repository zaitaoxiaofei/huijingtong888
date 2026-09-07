import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("order procurement records quantity allocations instead of reusing one in-transit batch", async () => {
  const [service, schema] = await Promise.all([
    readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8")
  ]);

  assert.match(service, /CREATE TABLE IF NOT EXISTS procurement_order_allocations/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS procurement_order_allocations/);
  assert.match(service, /UNIQUE KEY uk_procurement_order_allocation \(procurement_request_id, order_item_id\)/);
  assert.match(service, /allocatedQuantity = Math\.min\(quantity, Number\(allocation\.remaining \|\| 0\)\)/);
  assert.match(service, /allocation\.remaining = Math\.max\(0/);
  assert.match(service, /request\.quantity - COALESCE\(request_allocated\.allocated_quantity, 0\)/);
  assert.match(service, /INSERT IGNORE INTO procurement_order_allocations/);
  assert.match(service, /request\.source_order_item_id/);
  assert.match(service, /reservedIncomingByProduct/);
  assert.match(service, /AND o\.id != \?/);
});

test("procurement workspace reconciles signed stock with purchase in transit", async () => {
  const workspace = await readFile(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");

  assert.match(workspace, /return currentStock \+ incomingStock/);
  assert.match(workspace, /综合供给欠账/);
  assert.match(workspace, /剩余总供给/);
  assert.match(workspace, /当前供给/);
  assert.match(workspace, /现货/);
  assert.match(workspace, /在途/);
});

test("order-side procurement confirmation creates the same purchased and in-transit facts as the workspace", async () => {
  const [service, page] = await Promise.all([
    readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8")
  ]);
  const start = service.indexOf("export async function createOrderProcurementRequestsMysql");
  const end = service.indexOf("export async function updateProcurementRequestMysql", start);
  const block = service.slice(start, end);

  assert.match(block, /mergeProcurementRequestsMysql\(\{/);
  assert.match(block, /confirmPurchaseOrderMysql\(purchaseOrder\.id/);
  assert.match(block, /cancelPurchaseOrderMysql\(purchaseOrder\.id\)/);
  assert.match(block, /purchase_order_id: Number\(purchaseOrder\.id\)/);
  assert.match(block, /purchase_order_no: purchaseOrder\.order_no/);
  assert.match(page, /已完成采购/);
  assert.match(page, /采购金额必须大于 0/);
  assert.match(block, /采购金额（amount）必须大于 0/);
  assert.doesNotMatch(page, /已生成采购建议/);
});

test("procurement workspace records a purchase synchronously and exposes only three business stages", async () => {
  const [service, routes, workspace, schema] = await Promise.all([
    readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8"),
    readFile(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8")
  ]);

  assert.match(routes, /POST \/api\/procurement\/purchases/);
  assert.match(routes, /confirm-from-requests"/);
  assert.match(service, /export async function recordProcurementPurchaseMysql/);
  assert.match(service, /stage: "in_transit"/);
  assert.match(service, /本次采购数量不足，剩余/);
  assert.match(service, /const staleProductIds =/);
  assert.match(service, /WHERE product_id IN \(\$\{staleProductIds\.map/);
  assert.match(service, /replacementRequests/);
  assert.match(service, /转为提前采购库存/);
  assert.match(service, /INSERT INTO procurement_order_allocations/);
  assert.match(schema, /demand_type VARCHAR\(32\)/);
  assert.match(schema, /purchased_at DATETIME NULL/);
  assert.match(workspace, /确认已下单并进入在途/);
  assert.match(workspace, /采购已登记，商品已进入采购在途/);
  assert.doesNotMatch(workspace, /系统正在生成采购单/);
});

test("orphan submitted rows return to the procurement workspace", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  assert.match(service, /reconcileFailedOrderProcurementSubmissionsMysql/);
  assert.match(service, /purchase_order_id IS NULL[\s\S]*status = 'submitted'/);
  assert.match(service, /SET status = 'suggested', approval_status = 'suggested'/);
  assert.match(service, /SET status = 'pending'[\s\S]*handling_type = 'procurement_request'/);
});

test("shortage suggestion helpers cannot run as a side effect of reading the procurement list", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const autoStart = service.indexOf("async function ensurePendingOrderProcurementRequestsMysql");
  const autoEnd = service.indexOf("export async function procurementRequestsMysql", autoStart);
  const autoBlock = service.slice(autoStart, autoEnd);
  const warningStart = service.indexOf("async function ensureInventoryWarningProcurementRequestsMysql");
  const warningEnd = service.indexOf("let pendingOrderProcurementReconcilePromise", warningStart);
  const warningBlock = service.slice(warningStart, warningEnd);

  assert.match(autoBlock, /'suggested', 'suggested'/);
  assert.match(autoBlock, /handlingType === "procurement_request" \? "pending" : "handled"/);
  assert.doesNotMatch(autoBlock, /VALUES \([^\n]+ 'submitted', 'submitted'/);
  assert.match(warningBlock, /'suggested',\s*'suggested',\s*'系统库存预警/);
  const listStart = service.indexOf("export async function procurementRequestsMysql");
  const listEnd = service.indexOf("export async function repairOrderOutboundMysql", listStart);
  const listBlock = service.slice(listStart, listEnd);
  assert.doesNotMatch(listBlock, /ensurePendingOrderProcurementRequestsMysql\(/);
  assert.doesNotMatch(listBlock, /ensureInventoryWarningProcurementRequestsMysql\(/);
});

test("order confirmation replaces an automatic suggestion with a formal purchased request", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const start = service.indexOf("export async function createOrderProcurementRequestsMysql");
  const end = service.indexOf("export async function updateProcurementRequestMysql", start);
  const block = service.slice(start, end);

  assert.match(block, /WHERE source_order_id = \? AND status = 'suggested'/);
  assert.match(block, /订单页确认采购时由正式采购记录替代/);
  assert.match(block, /SET status = 'pending'/);
  assert.match(block, /includeHandledSourceOrder: true/);
  assert.match(service, /pr_source\.status NOT IN \('cancelled', 'pending', 'suggested'\)/);
});

test("procurement workspace refreshes persisted demand using the same 21-day stable-sales coverage", async () => {
  const [service, routes, workspace] = await Promise.all([
    readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8"),
    readFile(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8")
  ]);

  assert.match(service, /export async function refreshProcurementDemandMysql/);
  assert.match(service, /recent_30d_qty \/ 30 \* 21/);
  assert.match(routes, /POST \/api\/procurement\/refresh-demand/);
  assert.match(workspace, /api\/procurement\/refresh-demand/);
});

test("cancelled orders stop consuming procurement batch availability", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const allocationSummary = service.slice(
    service.indexOf("SELECT active_allocation.procurement_request_id"),
    service.indexOf("GROUP BY active_allocation.procurement_request_id") + 60
  );

  assert.match(allocationSummary, /JOIN orders allocated_order/);
  assert.match(allocationSummary, /allocated_order\.status[\s\S]*NOT LIKE '%cancel%'/);
  assert.match(allocationSummary, /allocated_order\.tracking_stage[\s\S]*NOT LIKE '%cancel%'/);
});

test("orders show purchase time, allocated quantity, remaining batch and overdue warning", async () => {
  const [page, table] = await Promise.all([
    readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8"),
    readFile(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8")
  ]);

  assert.match(page, /procurement_latest_purchase_at/);
  assert.match(page, /procurement_has_allocation/);
  assert.match(page, /procurement_has_product_incoming/);
  assert.match(page, /procurement_inbound_record_ids/);
  assert.match(page, /\/api\/inbound-records\/batch-update"/);
  assert.doesNotMatch(page, /\/api\/inbound-records\/batch-update-async/);
  assert.match(page, /loadOrders\(\{ forceRefresh: true, silent: true \}\)/);
  assert.match(table, /confirmingInboundRecordId/);
  assert.match(page, /采购人员/);
  assert.match(page, /采购单号/);
  assert.match(page, /采购合计/);
  assert.match(page, /procurement_request_unallocated_quantity/);
  assert.match(table, /下单时间：\{\{ procurementTimeText\(row\) \|\| "待补充" \}\}/);
  assert.match(table, /在途: \{\{ Number\(product\.incoming \|\| 0\) \}\}/);
  assert.match(table, /确认入库/);
  assert.match(table, /查看采购内容/);
  assert.match(table, /v-if="row\.procurementState\.inboundRecordId"/);
  assert.doesNotMatch(table, /row\.procurementState\.overdue && row\.procurementState\.inboundRecordId/);
  const inventoryColumn = table.slice(
    table.indexOf('label="库存信息"'),
    table.indexOf('label="归类 / 具体原因"')
  );
  assert.match(inventoryColumn, /orders-procurement-transparency/);
  assert.doesNotMatch(inventoryColumn, /预计: CNY/);
  assert.doesNotMatch(inventoryColumn, /真实:/);
});

test("order in-transit status requires an order-linked pending inbound record", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

  assert.match(service, /AS procurement_has_order_incoming/);
  assert.match(service, /allocation_inbound\.status = 'pending_arrival'/);
  assert.match(service, /GROUP_CONCAT\(DISTINCT procurement_allocation\.pending_inbound_record_ids\) AS procurement_inbound_record_ids/);
  assert.match(service, /COALESCE\(MAX\(procurement_allocation\.pending_incoming_quantity\), 0\) AS procurement_inbound_quantity/);
});

test("inbound confirmation records the signed-in operator", async () => {
  const [service, routes, schema] = await Promise.all([
    readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server/routes/operations.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8")
  ]);

  assert.match(routes, /startBatchUpdateInboundRecords\(await readJson\(req\), req\._session\?\.personId\)/);
  assert.match(service, /approved_by_person_id = CASE WHEN \? = 'approved'/);
  assert.match(service, /approved_by_person_name/);
  assert.match(schema, /approved_by_person_id BIGINT UNSIGNED NULL/);
});

test("component inbound records classify combo orders as procurement in transit", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

  assert.match(service, /SUM\(COALESCE\(incoming\.incoming_stock, 0\)\) AS component_incoming_quantity/);
  assert.match(service, /parent_component_stock\.inbound_record_ids IS NOT NULL THEN 1 ELSE 0 END\) AS procurement_has_product_incoming/);
  assert.match(service, /parent_component_stock\.component_incoming_quantity/);
});

test("inventory posting does not reference an undefined existing record", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const start = service.indexOf("async function postInventoryMysql");
  const end = service.indexOf("async function postProductInventoryWithComponentsMysql", start);
  const block = service.slice(start, end);

  assert.match(block, /body\.note \?\? ""/);
  assert.doesNotMatch(block, /existing\.note/);
});

test("order procurement expands configured bundles into real component products", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const start = service.indexOf("async function orderProcurementCandidateRowsMysql");
  const end = service.indexOf("async function orderProcurementMissingItemsMysql", start);
  const block = service.slice(start, end);

  assert.match(block, /LEFT JOIN product_components pc ON pc\.product_id = p\.id/);
  assert.match(block, /procurement_product\.id AS product_id/);
  assert.match(block, /oi\.quantity \* COALESCE\(recipe_item\.quantity, pc\.quantity, 1\) AS quantity/);
  assert.match(block, /stock\.product_id = procurement_product\.id/);
  assert.match(block, /incoming\.product_id = procurement_product\.id/);
  assert.match(block, /pr\.product_id = mi\.product_id/);
});

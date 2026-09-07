import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
const service = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const listService = fs.readFileSync(new URL("../src/services/mysql-procurement-list.js", import.meta.url), "utf8");

test("procurement workspace exposes image sourcing and direct link binding", () => {
  assert.match(page, /OZON_ERP_OPEN_1688_SAME_ITEM_REQUEST/);
  assert.match(page, /1688识图/);
  assert.match(page, /保存并用于以后采购/);
  assert.match(page, /remember_purchase_link:\s*true/);
  assert.match(page, /ProductImagePreview/);
});

test("confirmed purchase link is remembered on the bound inventory product", () => {
  assert.match(service, /body\.remember_purchase_link === true/);
  assert.match(service, /UPDATE products[\s\S]*SET purchase_url = \?, source_platform = \?, supplier_id = COALESCE/);
});

test("procurement workspace supports inventory demand decisions and batch purchase entry", () => {
  assert.match(service, /recent_15d_qty/);
  assert.match(listService, /suggested_purchase_qty/);
  assert.match(listService, /realOrderShortage/);
  assert.match(listService, /if \(!row\.procurement_required\) return false/);
  assert.match(listService, /hasComponents \? Number\(row\.component_local_stock \|\| 0\) : Number\(row\.stock \|\| 0\)/);
  assert.match(listService, /hasComponents \? Number\(row\.component_incoming_stock \|\| 0\) : Number\(row\.incoming_stock \|\| 0\)/);
  assert.match(service, /component_supply\.incoming_stock/);
  assert.match(listService, /demand_reason/);
  assert.match(page, /@selection-change="handleDemandSelection"/);
  assert.match(page, /批量采购确认/);
  assert.match(page, /保存并标记已采购/);
  assert.match(page, /composition_items/);
  assert.match(page, /仅采购缺口/);
  assert.match(page, /required - localStock - incomingStock/);
  assert.match(page, /子产品无需重复采购/);
  assert.match(page, /库存 \$\{localStock\} \+ 在途 \$\{incomingStock\}/);
  assert.match(page, /replaces_request_ids/);
  assert.match(page, /编辑库存商品/);
  assert.match(page, /ProductCreateEditDialog/);
  assert.match(page, /apiClient\.get\(`\/api\/products\/\$\{productId\}`/);
  assert.match(page, /:value="inventoryEditorValue"/);
  assert.match(page, /个关联订单/);
  assert.match(page, /height="calc\(100vh - 350px\)"/);
  assert.match(page, /height="calc\(100vh - 300px\)"/);
  assert.match(page, /source_order_image_url/);
  assert.match(page, /PageFooterPagination/);
  assert.match(page, /pagedRealOrderRows/);
  assert.match(page, /真实订单缺口/);
  assert.match(page, /库存不足7天/);
  assert.match(page, /调整该 SKU 的库存绑定/);
  assert.match(page, /purchaseBasis/);
  assert.match(page, /pagedBulkItems/);
  assert.match(page, /bulk-pagination/);
  assert.match(page, /width="calc\(100vw - 24px\)"/);
  assert.match(page, /class="bulk-number-input"/);
  assert.match(page, /const bulkPageSize = ref\(10\)/);
  assert.match(page, /historical_unit_cost/);
  assert.match(page, /价格对比/);
  assert.match(page, /采购均价/);
  assert.match(page, /historyUnitPrice/);
  assert.match(page, /savePurchaseHistoryRow/);
  assert.match(page, /deletePurchaseHistoryRow/);
  assert.match(page, /inboundPurchaseHistoryRow/);
  assert.match(page, /打开货源/);
  assert.match(page, /normalizeBulkMoney/);
  assert.match(service, /historical_avg_unit_cost/);
  assert.match(page, />打开采购链接</);
  assert.match(page, /添加采购链接/);
  assert.doesNotMatch(page, /待补链接/);
  assert.match(page, /30天 \{\{ Number\(row\.recent_30d_qty/);
  assert.doesNotMatch(page, /v-model="row\.purchase_url"/);
  assert.doesNotMatch(page, /class="procurement-mode-grid"/);
  assert.doesNotMatch(page, />更换绑定</);
  assert.match(service, /demandType === "real_order"/);
  assert.match(page, /api\/online-products\/bind/);
  assert.match(page, /采购需求已按新库存重新归组/);
  assert.match(page, /row\.priority_level/);
  assert.match(listService, /"P0"/);
  assert.match(listService, /"订单履约优先"/);
  assert.match(page, /负库存待补/);
  assert.match(page, /订单待补/);
  assert.match(page, /安全库存待补/);
  assert.match(service, /UPDATE procurement_requests[\s\S]*source_order_item_id = \?/);
  assert.match(page, /v-model="state\.filters\.demandType"[\s\S]*@change="handleSearch"/);
  assert.match(service, /ensureInventoryWarningProcurementRequestsMysql/);
  assert.match(service, /现货和在途不足21天/);
  assert.match(service, /warning_sales\.recent_30d_qty \/ 30 \* 21/);
});

test("batch purchase can append inventory products and remember a reusable purchase group", () => {
  assert.match(page, /添加库存商品到本次采购单/);
  assert.match(page, /InventoryStructuredSearch v-model="bulkAddFilters" compact/);
  assert.match(page, /api\/products\?\$\{params\.toString\(\)\}/);
  assert.match(page, /完整库存商品库/);
  assert.match(page, /isProductInBulk/);
  assert.doesNotMatch(page, /procurement\/binding-suggestions\?query=.*bulkAdd/);
  assert.match(page, /purchase-group-recommendations/);
  assert.match(page, /保存为常购组合/);
  assert.match(page, /上传微信凭证/);
  assert.match(page, /manually_added/);
  assert.match(service, /procurement_purchase_group_items/);
  assert.match(service, /remember_group/);
});

test("negative inventory exposes linked order details and stock warnings require sustained demand", () => {
  assert.match(page, /负库存.*订单明细/);
  assert.match(page, /stockGapOrderRows/);
  assert.match(page, /查看记录/);
  assert.match(page, /purchaseHistoryRows/);
  assert.match(page, /actualPurchaseStatuses/);
  assert.match(page, /有效订单/);
  assert.match(page, /综合供给欠账/);
  assert.match(page, /剩余总供给/);
  assert.match(page, /查看.*笔采购明细/);
  assert.match(page, /暂无已完成采购记录；当前仅有待采购需求/);
  assert.match(page, /本订单占缺口/);
  assert.match(page, /下单时间/);
  assert.match(page, /orderStatusLabel/);
  assert.match(page, /source_order_ordered_at/);
  assert.match(page, /检查并调整 SKU 库存绑定/);
  assert.match(service, /stock_gap_orders/);
  assert.match(service, /related_order_item_id/);
  assert.match(service, /source_order_ordered_at/);
  assert.match(service, /source_order_tracking_stage/);
  assert.match(service, /historical_purchased_quantity/);
  assert.match(service, /historical_order_count/);
  assert.match(service, /historical_outbound_quantity/);
  assert.match(service, /historical_fbp_transfer_outbound_quantity/);
  assert.match(page, /本地流水/);
  assert.match(page, /转FBP/);
  assert.match(page, /本次采购录入/);
  assert.match(page, /purchase-entry-fields/);
  assert.doesNotMatch(page, /label="实际数量"/);
  assert.match(service, /COALESCE\(incoming\.incoming_stock, 0\) AS incoming_stock/);
  assert.match(page, /inventory_warning_qualified/);
  assert.match(service, /warning_sales\.recent_7d_qty >= 5/);
  assert.match(service, /warning_sales\.week1_qty > warning_sales\.week2_qty/);
  assert.match(service, /warning_fbp\.fbp_snapshot_count/);
  assert.match(service, /预警规则复核后不再满足持续销量条件/);
});

test("inventory warnings use buildable component supply after a bundle composition is added", () => {
  assert.match(service, /warning_component_supply/);
  assert.match(service, /MIN\(FLOOR\(GREATEST\(COALESCE\(component_stock\.stock, 0\), 0\) \/ NULLIF\(pc\.quantity, 0\)\)\)/);
  assert.match(service, /function procurementInventoryWarningStockMysql/);
  assert.match(service, /function procurementInventoryWarningIncomingMysql/);
  assert.match(service, /CASE WHEN COALESCE\(warning_component_supply\.component_count, 0\) > 0/);
});

test("1688 image search fails fast when the procurement plugin does not respond", () => {
  assert.match(page, /}, 6000\);/);
  assert.match(page, /1688识图未收到插件响应/);
});

test("product composition exposes child local, FBP and purchase-in-transit inventory", () => {
  const compositionDialog = fs.readFileSync(new URL("../frontend/admin/components/inventory/ProductCompositionDialog.vue", import.meta.url), "utf8");
  assert.match(service, /COALESCE\(fbp\.fbp_stock, 0\) AS fbp_stock/);
  assert.match(service, /WHERE stock_type = 'fbp_real'/);
  assert.match(compositionDialog, /fbp_stock: Number\(item\.fbp_stock/);
  assert.match(compositionDialog, /incoming_stock: Number\(item\.incoming_stock/);
  assert.match(compositionDialog, /<em>本地<\/em>/);
  assert.match(compositionDialog, /<em>FBP<\/em>/);
  assert.match(compositionDialog, /<em>采购在途<\/em>/);
  assert.match(compositionDialog, /<em>本地可组<\/em>/);
});

test("procurement workspace reuses structured inventory filters", () => {
  assert.match(page, /InventoryStructuredSearch/);
  assert.match(page, /compact/);
  assert.match(page, /供应商/);
  assert.match(page, /采购平台/);
  assert.match(page, /filterable/);
  for (const field of ["inventoryCategory", "vehicleBrand", "vehicleModel", "accessoryName", "color", "material", "process", "supplierId", "sourceType"]) {
    assert.match(page, new RegExp(field));
  }
  assert.match(service, /p\.inventory_category = \?/);
  assert.match(service, /p\.vehicle_brand/);
  assert.match(service, /brandTokens/);
  assert.match(service, /brandTokens\.map\(\(\) => "p\.name LIKE \?"\)/);
  assert.match(service, /p\.vehicle_model/);
  assert.match(service, /p\.accessory_name = \?/);
  assert.match(service, /p\.surface_process = \?/);
});

test("transported procurement is reconciled and price increases require a reason", () => {
  assert.match(service, /reconcileTransportedOrderProcurementMysql/);
  assert.match(service, /transported_purchase_amount_missing/);
  assert.match(service, /purchase_price_increase_unconfirmed/);
  assert.match(service, /goodsUnitCost > historicalUnitCost \* 1\.1/);
  assert.match(service, /本次采购单价较历史均价上涨超过10%/);
  assert.match(service, /FROM inbound_records\s+WHERE status = 'pending_arrival'\s+GROUP BY product_id/);
  assert.match(page, /priceAnomalyReasons/);
  assert.match(page, /bulkPriceChange\(item\) > 0\.1/);
  assert.match(page, /请选择价格异常原因/);
});

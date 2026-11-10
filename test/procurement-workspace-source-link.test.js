import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const listService = fs.readFileSync(new URL("../src/services/mysql-procurement-list.js", import.meta.url), "utf8");

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

  assert.match(listService, /suggestion_reasons/);
  assert.match(listService, /FBP备货联动/);
  assert.match(service, /COALESCE\(NULLIF\(p\.inventory_number, ''\)/);

  assert.match(service, /historical_avg_unit_cost/);

  assert.match(service, /demandType === "real_order"/);

  assert.match(listService, /"P0"/);
  assert.match(listService, /"订单履约优先"/);

  assert.match(service, /UPDATE procurement_requests[\s\S]*source_order_item_id = \?/);

  assert.match(service, /ensureInventoryWarningProcurementRequestsMysql/);
  assert.match(service, /现货和在途不足21天/);
  assert.match(service, /warning_sales\.recent_30d_qty \/ 30 \* 21/);
});

test("batch purchase can append inventory products and remember a reusable purchase group", () => {

  assert.match(service, /procurement_purchase_group_items/);
  assert.match(service, /remember_group/);
});

test("negative inventory exposes linked order details and stock warnings require sustained demand", () => {

  assert.match(service, /stock_gap_orders/);
  assert.match(service, /related_order_item_id/);
  assert.match(service, /source_order_ordered_at/);
  assert.match(service, /source_order_tracking_stage/);
  assert.match(service, /historical_purchased_quantity/);
  assert.match(service, /historical_order_count/);
  assert.match(service, /historical_outbound_quantity/);
  assert.match(service, /historical_fbp_transfer_outbound_quantity/);

  assert.match(service, /COALESCE\(incoming\.incoming_stock, 0\) AS incoming_stock/);

  assert.match(service, /warning_sales\.recent_7d_qty >= 5/);
  assert.match(service, /warning_sales\.week1_qty > warning_sales\.week2_qty/);
  assert.match(service, /warning_fbp\.fbp_snapshot_count/);
  assert.match(service, /SET episode\.warning_episode_closed_at = CURRENT_TIMESTAMP/);
});

test("inventory warnings use buildable component supply after a bundle composition is added", () => {
  assert.match(service, /warning_component_supply/);
  assert.match(service, /MIN\(FLOOR\(GREATEST\(COALESCE\(component_stock\.stock, 0\), 0\) \/ NULLIF\(pc\.quantity, 0\)\)\)/);
  assert.match(service, /function procurementInventoryWarningStockMysql/);
  assert.match(service, /function procurementInventoryWarningIncomingMysql/);
  assert.match(service, /CASE WHEN COALESCE\(warning_component_supply\.component_count, 0\) > 0/);
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

});

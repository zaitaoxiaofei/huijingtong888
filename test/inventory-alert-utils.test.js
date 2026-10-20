import assert from "node:assert/strict";
import test from "node:test";

import { applyStockAlertQuery } from "../src/services/inventory-alert-utils.js";

function productWithSku(sku) {
  return {
    product_id: sku.product_id || 1,
    product_name: sku.product_name || "FBP test product",
    image_url: "",
    inventory_id: sku.inventory_id || "P-TEST",
    alert_stock: 0,
    local_stock: 0,
    created_at: "2026-07-06T00:00:00.000Z",
    skus: [{
      shop_id: sku.shop_id || 1,
      shop_name: sku.shop_name || "Demo shop",
      ozon_sku: sku.ozon_sku || `sku-${sku.product_id || 1}`,
      offer_id: sku.offer_id || "",
      name: sku.name || "FBP SKU",
      fbp_snapshot_count: 1,
      fbp_present: sku.fbp_present ?? sku.fbp_available ?? 0,
      fbp_available: sku.fbp_available ?? 0,
      recent_7d_qty: sku.recent_7d_qty ?? 0,
      recent_30d_qty: sku.recent_30d_qty ?? 0,
      prev_7d_qty: sku.prev_7d_qty ?? 0,
      older_7d_qty: sku.older_7d_qty ?? 0,
      all_time_qty: sku.all_time_qty ?? 0
    }]
  };
}

test("FBP alert mode only returns out-of-stock or under-15-day coverage rows", () => {
  const result = applyStockAlertQuery([
    productWithSku({ product_id: 1, ozon_sku: "out", fbp_available: 0 }),
    productWithSku({ product_id: 2, ozon_sku: "risk15", fbp_available: 20, recent_7d_qty: 14, prev_7d_qty: 7 }),
    productWithSku({ product_id: 3, ozon_sku: "safe", fbp_available: 40, recent_7d_qty: 14, prev_7d_qty: 7 })
  ], { mode: "fbp-alerts", paged: "1", page: 1, pageSize: 10 });

  assert.equal(result.mode, "fbp-alerts");
  assert.deepEqual(result.rows.map((row) => row.ozon_sku), ["out", "risk15"]);
  assert.equal(result.rows[0].alert_type, "out_of_stock");
  assert.equal(result.rows[1].alert_type, "within_15_days");
  assert.equal(result.rows[1].dynamic_daily_sales, 2);
  assert.equal(result.rows[1].coverage_days, 10);
});

test("FBP alert mode uses the previous week when recent week slows down", () => {
  const result = applyStockAlertQuery([
    productWithSku({ product_id: 4, ozon_sku: "slowdown", fbp_available: 8, recent_7d_qty: 0, prev_7d_qty: 14 })
  ], { mode: "fbp-alerts", paged: "1", page: 1, pageSize: 10 });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].alert_type, "within_15_days");
  assert.ok(result.rows[0].dynamic_daily_sales > 0);
  assert.ok(result.rows[0].coverage_days < 15);
});

test("FBP 运营视角包含健康 SKU，按关联库存累计再按 SKU 累计排序", () => {
  const productOne = productWithSku({ product_id: 1, ozon_sku: "A", fbp_available: 100, all_time_qty: 60 });
  productOne.all_time_qty = 100;
  productOne.skus.push({ ...productOne.skus[0], ozon_sku: "B", all_time_qty: 40 });
  const productTwo = productWithSku({ product_id: 2, ozon_sku: "C", fbp_available: 100, all_time_qty: 80,
    older_7d_qty: 15, prev_7d_qty: 8, recent_7d_qty: 3 });
  productTwo.all_time_qty = 80;
  const query = { mode: "fbp-operations", fbpFocus: "all", paged: "1", pageSize: 2 };

  assert.deepEqual(applyStockAlertQuery([productTwo, productOne], query).rows.map((row) => row.ozon_sku), ["A", "B"]);
  const nextPage = applyStockAlertQuery([productTwo, productOne], { ...query, page: 2 });
  assert.deepEqual(nextPage.rows.map((row) => row.ozon_sku), ["C"]);
  assert.equal(nextPage.rows[0].trend_type, "continuous_decline");
  assert.deepEqual(applyStockAlertQuery([productTwo, productOne], { ...query, fbpFocus: "declining" }).rows.map((row) => row.ozon_sku), ["C"]);
});

test("FBP 运营视角默认只列需要为 SKU 备货的记录，关联库存销量只用于排序", () => {
  const urgent = productWithSku({ product_id: 1, ozon_sku: "urgent", fbp_available: 2, recent_7d_qty: 14, prev_7d_qty: 14 });
  urgent.all_time_qty = 50;
  const healthy = productWithSku({ product_id: 2, ozon_sku: "healthy", fbp_available: 100, recent_7d_qty: 7, prev_7d_qty: 7 });
  healthy.all_time_qty = 500;
  const ignored = productWithSku({ product_id: 3, ozon_sku: "ignored", fbp_available: 2, recent_7d_qty: 14, prev_7d_qty: 14 });
  ignored.skus[0].replenishment_ignored = true;
  ignored.all_time_qty = 1000;

  const result = applyStockAlertQuery([healthy, ignored, urgent], { mode: "fbp-operations" });
  assert.deepEqual(result.rows.map((row) => row.ozon_sku), ["urgent"]);
  assert.ok(result.rows[0].suggested_qty > 0);
  assert.equal(applyStockAlertQuery([healthy, ignored, urgent], { mode: "fbp-operations", fbpFocus: "all" }).total, 3);
  assert.equal(applyStockAlertQuery([healthy, ignored, urgent], { mode: "fbp-operations", fbpFocus: "unknown" }).total, 1);
});

test("同一个店铺 SKU 已发仓在途的数量抵扣建议备货，不占用其他 SKU 的本地共享库存", () => {
  const stocked = productWithSku({ product_id: 1, ozon_sku: "S1", fbp_available: 2, recent_7d_qty: 14, prev_7d_qty: 14 });
  stocked.skus[0].fbp_transfer_in_transit_qty = 60;
  assert.equal(applyStockAlertQuery([stocked], { mode: "fbp-operations" }).total, 0);
  const [row] = applyStockAlertQuery([stocked], { mode: "fbp-operations", fbpFocus: "all" }).rows;
  assert.equal(row.alert_type, "within_7_days");
  assert.equal(row.fbp_effective_available, 62);
  assert.equal(row.suggested_qty, 0);
});

test("已发仓在途但尚无 FBP 库存快照的 SKU 可在全部视角查看", () => {
  const product = productWithSku({ product_id: 9, ozon_sku: "IN-TRANSIT", fbp_available: 0 });
  product.skus[0].fbp_snapshot_count = 0;
  product.skus[0].fbp_transfer_in_transit_qty = 8;
  const rows = applyStockAlertQuery([product], { mode: "fbp-operations", fbpFocus: "all" }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fbp_transfer_in_transit_qty, 8);
});

test("FBP 趋势在断货和低样本时不判定销量下滑", () => {
  const stockout = productWithSku({ product_id: 3, fbp_available: 0, older_7d_qty: 30, prev_7d_qty: 20, recent_7d_qty: 5 });
  const smallSample = productWithSku({ product_id: 4, fbp_available: 20, older_7d_qty: 2, prev_7d_qty: 1, recent_7d_qty: 0 });
  const rows = applyStockAlertQuery([stockout, smallSample], { mode: "fbp-operations", fbpFocus: "all" }).rows;
  assert.equal(rows.find((row) => row.product_id === 3).trend_type, "stockout");
  assert.equal(rows.find((row) => row.product_id === 4).trend_type, "low_sample");
});

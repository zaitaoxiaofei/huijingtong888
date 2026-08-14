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
      prev_7d_qty: sku.prev_7d_qty ?? 0
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

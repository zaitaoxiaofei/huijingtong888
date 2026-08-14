import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  aggregateOrderCarHeatmapRows,
  parseOrderVehicleTitle
} from "../src/services/order-car-heatmap.js";

function testTitleHash(value = "") {
  return crypto.createHash("sha256").update(String(value || "").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

test("order car heatmap parses vehicle and product keywords from Ozon titles", () => {
  const parsed = parseOrderVehicleTitle("EVA коврики floor mats для Toyota Camry 2018-2024");
  assert.equal(parsed.brand, "Toyota");
  assert.equal(parsed.model, "Camry");
  assert.equal(parsed.product_key, "floor_mat");
  assert.equal(parsed.product_label, "脚垫");
  assert.deepEqual(parsed.years, ["2018", "2024"]);
  assert.equal(parsed.matched, true);
});

test("order car heatmap model layer weights distinct SKUs and product layer weights orders", () => {
  const rows = [
    {
      order_item_id: 1,
      order_id: 101,
      shop_id: 1,
      shop_name: "Shop A",
      ozon_sku: "SKU-A",
      ozon_name: "Floor mats for Toyota Camry 2018",
      quantity: 1,
      sale_price: 100,
      ordered_at: "2026-07-01 00:00:00"
    },
    {
      order_item_id: 2,
      order_id: 102,
      shop_id: 1,
      shop_name: "Shop A",
      ozon_sku: "SKU-A",
      ozon_name: "Floor mats for Toyota Camry 2018",
      quantity: 1,
      sale_price: 100,
      ordered_at: "2026-07-02 00:00:00"
    },
    {
      order_item_id: 3,
      order_id: 103,
      shop_id: 1,
      shop_name: "Shop A",
      ozon_sku: "SKU-B",
      ozon_name: "Коврики Toyota Camry 2020",
      quantity: 2,
      sale_price: 80,
      ordered_at: "2026-07-03 00:00:00"
    },
    {
      order_item_id: 4,
      order_id: 104,
      shop_id: 1,
      shop_name: "Shop A",
      ozon_sku: "SKU-C",
      ozon_name: "Trunk mat Toyota Camry",
      quantity: 1,
      sale_price: 120,
      ordered_at: "2026-07-04 00:00:00"
    }
  ];

  const all = aggregateOrderCarHeatmapRows(rows);
  const camry = all.models.find((row) => row.brand === "Toyota" && row.model === "Camry");
  assert.equal(camry.sku_count, 3);
  assert.equal(camry.order_count, 4);
  assert.equal(camry.item_quantity, 5);
  assert.equal(camry.product_count, 2);
  assert.equal(camry.orders_per_sku, 1.33);
  assert.equal(camry.top_sku_order_share, 0.5);
  assert.ok(camry.opportunity_score > 0);
  assert.ok(["S", "A", "B", "观察"].includes(camry.opportunity_grade));
  assert.match(camry.recommendation, /补|扩|优化|复制/);

  const selected = aggregateOrderCarHeatmapRows(rows, {
    brand: "Toyota",
    model: "Camry",
    productKey: "floor_mat"
  });
  const floorMats = selected.products.find((row) => row.product_key === "floor_mat");
  assert.equal(floorMats.order_count, 3);
  assert.equal(floorMats.sku_count, 2);

  assert.equal(selected.skus.length, 2);
  assert.deepEqual(selected.skus.map((row) => [row.ozon_sku, row.order_count]), [
    ["SKU-A", 2],
    ["SKU-B", 1]
  ]);
});

test("order car heatmap cached AI or manual tags override rule parsing", () => {
  const title = "Коврики Камри";
  const rows = [{
    order_item_id: 1,
    order_id: 201,
    shop_id: 1,
    shop_name: "Shop A",
    ozon_sku: "SKU-CACHED",
    ozon_name: title,
    quantity: 1,
    sale_price: 99,
    ordered_at: "2026-07-04 00:00:00"
  }];
  const cache = new Map([[
    testTitleHash(title),
    {
      brand: "Toyota",
      model: "Camry",
      product_key: "floor_mat",
      product_label: "脚垫",
      confidence: 0.97,
      source: "manual",
      status: "accepted"
    }
  ]]);

  const result = aggregateOrderCarHeatmapRows(rows, {}, { cache });
  assert.equal(result.models[0].brand, "Toyota");
  assert.equal(result.models[0].model, "Camry");
  assert.equal(result.models[0].sku_count, 1);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildProductDisplayRows } from "../frontend/orders/utils/order-display.js";

test("order display rows retain pending inbound quantity per SKU", () => {
  const [row] = buildProductDisplayRows({
    skus: "10001",
    sku_quantities: "10001:3",
    sku_stock_summaries: "10001:0:0:0",
    sku_incoming_summaries: "10001:30",
    sku_product_ids: "10001:42"
  });

  assert.equal(row.quantity, 3);
  assert.equal(row.stock.local, 0);
  assert.equal(row.incoming, 30);
});

test("order list projects component purchase transit into the parent SKU", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  assert.match(service, /parent_component_stock\.incoming_stock/);
  assert.match(service, /WHERE status = 'pending_arrival'[\s\S]*\) incoming ON incoming\.product_id = pc\.component_product_id/);
});

test("order display rows retain the bound product component count", () => {
  const [row] = buildProductDisplayRows({
    skus: "10001",
    sku_stock_summaries: "10001:0:0:8",
    sku_component_counts: "10001:2",
    sku_product_ids: "10001:42"
  });

  assert.equal(row.stock.local, 8);
  assert.equal(row.componentCount, 2);
});

test("order display rows keep inventory names containing commas paired to their SKU", () => {
  const [row] = buildProductDisplayRows({
    skus: "4280837874",
    sku_product_ids: "4280837874:248",
    sku_inventory_names: "4280837874:TENET T4,中柱亮黑 8件套",
    product_names: "TENET T4,中柱亮黑 8件套"
  });

  assert.equal(row.productId, 248);
  assert.equal(row.inventoryName, "TENET T4,中柱亮黑 8件套");
});

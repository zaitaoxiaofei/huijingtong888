import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSplitShippingPackagesMysql as legacyBuildSplitShippingPackagesMysql } from "../src/services/mysql-cutover.js";
import { buildSplitShippingPackagesMysql } from "../src/services/mysql-order-shipping-packages.js";

const items = [
  { id: 11, ozon_sku: "SKU-A", product_id: 101, quantity: 3 },
  { id: 12, ozon_sku: "SKU-B", product_id: 202, quantity: 1 }
];

test("mysql cutover keeps the split shipping compatibility export", () => {
  assert.equal(legacyBuildSplitShippingPackagesMysql, buildSplitShippingPackagesMysql);
});

test("split shipping maps order items to Ozon package products", () => {
  assert.deepEqual(buildSplitShippingPackagesMysql(items, [
    { products: [{ order_item_id: 11, quantity: 2 }] },
    { products: [{ order_item_id: 11, quantity: 1 }, { order_item_id: 12, quantity: 1 }] }
  ]), [
    { products: [{ product_id: 101, quantity: 2 }] },
    { products: [{ product_id: 101, quantity: 1 }, { product_id: 202, quantity: 1 }] }
  ]);
});

test("split shipping rejects incomplete, empty and foreign allocations", () => {
  assert.throws(() => buildSplitShippingPackagesMysql(items, [
    { products: [{ order_item_id: 11, quantity: 1 }] },
    { products: [{ order_item_id: 12, quantity: 1 }] }
  ]), /SKU-A.*1.*3/);
  assert.throws(() => buildSplitShippingPackagesMysql(items, [
    { products: [{ order_item_id: 11, quantity: 3 }, { order_item_id: 12, quantity: 1 }] },
    { products: [] }
  ]), /包裹 2 不能为空/);
  assert.throws(() => buildSplitShippingPackagesMysql(items, [
    { products: [{ order_item_id: 99, quantity: 1 }] },
    { products: [{ order_item_id: 11, quantity: 3 }, { order_item_id: 12, quantity: 1 }] }
  ]), /不属于当前订单/);
});

test("orders page exposes split-package preparation without replacing normal preparation", async () => {
  const page = await readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
  const table = await readFile(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");
  const client = await readFile(new URL("../frontend/orders/services/orders-service.js", import.meta.url), "utf8");
  assert.match(table, />\s*备货\s*</);
  assert.match(table, /拆分备货/);
  assert.match(table, /已备货，不能拆分/);
  assert.match(page, /拆分包裹并备货/);
  assert.match(page, /splitOrderValidation/);
  assert.match(client, /order_ids: \[id\], packages/);
});

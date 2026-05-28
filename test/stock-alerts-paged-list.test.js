import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { stockAlertsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

test("stock alerts support paged product list contract", async () => {
  const result = await stockAlertsMysql({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "alerts");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);
  assert.ok(result.meta);

  for (const row of result.rows) {
    assert.ok(row.product_id);
    assert.notEqual(row.product_name, undefined);
    assert.ok(Array.isArray(row.skus));
  }
});

test("stock alerts support FBP flattened paged list contract", async () => {
  const result = await stockAlertsMysql({ mode: "fbp", paged: "1", page: 1, pageSize: 5, sortKey: "fbp_available", sortDir: "asc" });

  assert.equal(result.mode, "fbp");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);

  for (const row of result.rows) {
    assert.ok(row.product_id);
    assert.notEqual(row.ozon_sku, undefined);
    assert.notEqual(row.ozon_product_id, undefined);
    assert.notEqual(row.fbp_available, undefined);
  }
});

test("stock alerts support search and shop filters", async () => {
  const first = await stockAlertsMysql({ mode: "fbp", paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const sample = first.rows[0];
  const searched = await stockAlertsMysql({ mode: "fbp", paged: "1", page: 1, pageSize: 10, query: sample.ozon_sku || sample.product_name });
  assert.ok(searched.total > 0);

  if (!sample.shop_id) return;
  const byShop = await stockAlertsMysql({ mode: "fbp", paged: "1", page: 1, pageSize: 20, shopId: sample.shop_id });
  assert.ok(byShop.rows.every((row) => Number(row.shop_id) === Number(sample.shop_id)));
});

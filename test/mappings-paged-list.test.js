import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { mappingsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const mappingList = mappingsMysql;

test("sku mappings support paged list contract", async () => {
  const result = await mappingList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.ok(row.product_id);
    assert.notEqual(row.product_name, undefined);
    assert.notEqual(row.shop_name, undefined);
    assert.notEqual(row.inventory_id, undefined);
  }
});

test("sku mappings paged list supports search, shop, and product filters", async () => {
  const first = await mappingList({ paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const sample = first.rows[0];
  const keyword = sample.ozon_sku || sample.product_name || sample.inventory_id;
  const searched = await mappingList({ paged: "1", page: 1, pageSize: 10, query: keyword });
  assert.ok(searched.total > 0);

  const byShop = await mappingList({ paged: "1", page: 1, pageSize: 20, shopId: sample.shop_id });
  assert.ok(byShop.rows.every((row) => Number(row.shop_id) === Number(sample.shop_id)));

  const byProduct = await mappingList({ paged: "1", page: 1, pageSize: 20, productId: sample.product_id });
  assert.ok(byProduct.rows.every((row) => Number(row.product_id) === Number(sample.product_id)));
});

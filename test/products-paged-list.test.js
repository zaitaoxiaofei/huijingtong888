import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { productsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const productList = productsMysql;

test("products support paged list contract", async () => {
  const result = await productList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.name, undefined);
    assert.ok(Array.isArray(row.shop_ids));
    assert.ok(Array.isArray(row.shop_names));
    assert.ok(Array.isArray(row.bound_mappings));
    assert.ok(Array.isArray(row.sku_preview));
    assert.equal(row.sku_preview.length <= 2, true);
  }
});

test("products paged list supports search and shop filters", async () => {
  const first = await productList({ paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const keyword = first.rows[0].name || first.rows[0].inventory_id;
  const searched = await productList({ paged: "1", page: 1, pageSize: 10, query: keyword });
  assert.ok(searched.total > 0);
  assert.ok(searched.rows.length <= 10);

  const withShop = first.rows.find((row) => row.shop_ids.length);
  if (!withShop) return;
  const shopId = withShop.shop_ids[0];
  const filtered = await productList({ paged: "1", page: 1, pageSize: 20, shopId });
  assert.ok(filtered.rows.every((row) => row.shop_ids.includes(shopId)));
});

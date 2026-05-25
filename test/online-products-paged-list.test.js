import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { onlineProductsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const onlineProductList = onlineProductsMysql;

test("online products support paged list contract", async () => {
  const result = await onlineProductList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);
  assert.ok(result.statusCounts);
  assert.ok(Number(result.statusCounts.all || 0) >= result.total);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.shop_name, undefined);
    assert.notEqual(row.name, undefined);
  }
});

test("online products support search, shop, and status filters", async () => {
  const first = await onlineProductList({ paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const sample = first.rows[0];
  const keyword = sample.ozon_sku || sample.offer_id || sample.name;
  const searched = await onlineProductList({ paged: "1", page: 1, pageSize: 10, offer: keyword });
  assert.ok(searched.total > 0);

  const byShop = await onlineProductList({ paged: "1", page: 1, pageSize: 20, shopId: sample.shop_id });
  assert.ok(byShop.rows.every((row) => Number(row.shop_id) === Number(sample.shop_id)));

  const selling = await onlineProductList({ paged: "1", page: 1, pageSize: 20, status: "selling" });
  assert.ok(selling.rows.length <= 20);
});

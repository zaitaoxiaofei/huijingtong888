import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import {
  outboundRecordsMysql,
  procurementRequestsMysql,
  productsMysql,
  productOrderProfitDetailsMysql
} from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

test("inventory product sales detail filters support impossible keyword", async () => {
  const result = await outboundRecordsMysql({
    paged: "1",
    page: 1,
    pageSize: 10,
    status: "deducted",
    query: "__impossible_inventory_sales_keyword__"
  });

  assert.equal(result.total, 0);
  assert.equal(result.rows.length, 0);
});

test("inventory product procurement detail filters support impossible keyword", async () => {
  const result = await procurementRequestsMysql({
    paged: "1",
    page: 1,
    pageSize: 10,
    status: "all",
    grouped: "0",
    query: "__impossible_inventory_procurement_keyword__"
  });

  assert.equal(result.total, 0);
  assert.equal(result.rows.length, 0);
});

test("inventory product profit detail filters support shop filter", async () => {
  const products = await productsMysql({ paged: "1", page: 1, pageSize: 1 });
  const productId = Number(products?.rows?.[0]?.id || 0);
  if (!productId) return;

  const all = await productOrderProfitDetailsMysql(productId, {
    paged: "1",
    page: 1,
    pageSize: 10
  });
  const filtered = await productOrderProfitDetailsMysql(productId, {
    paged: "1",
    page: 1,
    pageSize: 10,
    shopId: "999999"
  });

  assert.ok(Number(all.total || 0) >= 0);
  assert.equal(filtered.total, 0);
  assert.equal(filtered.rows.length, 0);
});

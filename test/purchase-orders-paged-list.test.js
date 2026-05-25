import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { purchaseOrdersMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const purchaseOrderList = purchaseOrdersMysql;

test("purchase orders support paged list contract", async () => {
  const result = await purchaseOrderList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.ok(row.order_no);
    assert.notEqual(row.creator_name, undefined);
    assert.notEqual(row.item_count, undefined);
    assert.notEqual(row.total_quantity, undefined);
    assert.notEqual(row.total_amount, undefined);
    assert.notEqual(row.product_names, undefined);
    assert.notEqual(row.product_codes, undefined);
    assert.notEqual(row.product_image_urls, undefined);
    assert.notEqual(row.mapped_skus, undefined);
  }
});

test("purchase orders support search", async () => {
  const first = await purchaseOrderList({ paged: "1", page: 1, pageSize: 1 });
  if (!first.rows.length) return;

  const keyword = first.rows[0].order_no || first.rows[0].product_names;
  const result = await purchaseOrderList({ paged: "1", page: 1, pageSize: 10, query: keyword });

  assert.ok(result.total > 0);
  assert.ok(result.rows.length <= 10);
});

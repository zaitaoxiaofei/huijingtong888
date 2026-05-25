import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { hiddenProductsMysql, suppliersMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const supplierList = suppliersMysql;

test("suppliers support paged list contract", async () => {
  const result = await supplierList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.name, undefined);
    assert.notEqual(row.product_count, undefined);
  }
});

test("hidden products support paged list contract", async () => {
  const result = await hiddenProductsMysql({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.name, undefined);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { procurementRequestsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const requestList = procurementRequestsMysql;

test("procurement requests support paged request list contract", async () => {
  const result = await requestList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.product_name, undefined);
    assert.notEqual(row.status, undefined);
  }
});

test("procurement requests support request list filters", async () => {
  const first = await requestList({ paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const sample = first.rows[0];
  const searched = await requestList({ paged: "1", page: 1, pageSize: 10, query: sample.product_name || sample.product_code });
  assert.ok(searched.total > 0);

  const byStatus = await requestList({ paged: "1", page: 1, pageSize: 20, status: sample.status });
  assert.ok(byStatus.rows.every((row) => String(row.status) === String(sample.status)));
});

import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { selectionProductsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const selectionProductList = selectionProductsMysql;

test("selection products support paged list contract", async () => {
  const result = await selectionProductList({ paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);
  assert.equal(typeof result.summary, "object");
  assert.equal(result.summary.products, result.total);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.notEqual(row.name, undefined);
    assert.notEqual(row.inventory_id, undefined);
    assert.equal(row.selection_status, "draft");
    assert.equal(typeof row.pricing, "object");
  }

  const ids = result.rows.map((row) => Number(row.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("selection products support search and quote status filters", async () => {
  const first = await selectionProductList({ paged: "1", page: 1, pageSize: 20 });
  if (!first.rows.length) return;

  const sample = first.rows[0];
  const keyword = sample.name || sample.inventory_id || sample.code;
  const searched = await selectionProductList({ paged: "1", page: 1, pageSize: 10, query: keyword });
  assert.ok(searched.total > 0);
  assert.ok(searched.rows.length <= 10);

  const quoted = await selectionProductList({ paged: "1", page: 1, pageSize: 20, quoteStatus: "quoted" });
  assert.ok(quoted.rows.every((row) => row.pricing?.air || row.pricing?.land));

  const missing = await selectionProductList({ paged: "1", page: 1, pageSize: 20, quoteStatus: "missing" });
  assert.ok(missing.rows.every((row) => !row.pricing?.air && !row.pricing?.land));
});

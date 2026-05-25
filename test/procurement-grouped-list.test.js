import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { procurementRequestsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const procurementList = procurementRequestsMysql;

test("procurement requests support grouped paged list contract", async () => {
  const result = await procurementList({ grouped: "1", paged: "1", page: 1, pageSize: 5 });

  assert.equal(result.mode, "grouped");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.product_id);
    assert.notEqual(row.product_name, undefined);
    assert.ok(Array.isArray(row.requests));
    assert.ok(Array.isArray(row.requester_names));
    assert.ok(Array.isArray(row.supplier_names));
    assert.ok(Array.isArray(row.purchase_links));
    assert.equal(row.requests.every((item) => item.status === "submitted"), true);
  }
});

test("procurement grouped list supports search", async () => {
  const first = await procurementList({ grouped: "1", paged: "1", page: 1, pageSize: 1 });
  if (!first.rows.length) return;

  const keyword = first.rows[0].product_name || first.rows[0].product_code;
  const result = await procurementList({ grouped: "1", paged: "1", page: 1, pageSize: 10, query: keyword });

  assert.ok(result.total > 0);
  assert.ok(result.rows.length <= 10);
});

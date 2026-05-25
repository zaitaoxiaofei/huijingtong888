import assert from "node:assert/strict";
import test from "node:test";

import { closeMysqlPool } from "../src/mysql-pool.js";
import { inboundRecordsMysql } from "../src/services/mysql-cutover.js";

test.after(async () => {
  await closeMysqlPool();
});

const inboundList = inboundRecordsMysql;

test("inbound records support paged list contract", async () => {
  const result = await inboundList({ paged: "1", page: 1, pageSize: 5, status: "all" });

  assert.equal(result.mode, "paged");
  assert.ok(result.total >= result.rows.length);
  assert.ok(result.rows.length <= 5);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 5);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.ok(row.product_id);
    assert.notEqual(row.product_code, undefined);
    assert.notEqual(row.product_name, undefined);
    assert.notEqual(row.person_name, undefined);
    assert.notEqual(row.purchase_order_no, undefined);
  }
});

test("inbound records support status and search filters", async () => {
  const pending = await inboundList({ paged: "1", page: 1, pageSize: 10, status: "pending_arrival" });
  assert.ok(pending.rows.every((row) => row.status === "pending_arrival"));

  const sample = await inboundList({ paged: "1", page: 1, pageSize: 1, status: "all" });
  if (!sample.rows.length) return;

  const keyword = sample.rows[0].product_name || sample.rows[0].product_code || sample.rows[0].purchase_order_no;
  const searched = await inboundList({ paged: "1", page: 1, pageSize: 10, query: keyword });
  assert.ok(searched.total > 0);
  assert.ok(searched.rows.length <= 10);
});

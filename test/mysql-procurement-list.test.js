import assert from "node:assert/strict";
import test from "node:test";

import {
  filterProcurementRequestsMysql,
  groupProcurementRequestsMysql
} from "../src/services/mysql-procurement-list.js";

const rows = [
  { id: 1, product_id: 8, product_name: "Mat", status: "pending", quantity: 2, amount: 10, person_name: "A", supplier_name: "S", created_at: "2026-07-01" },
  { id: 2, product_id: 8, product_name: "Mat", status: "submitted", quantity: 3, amount: 15, person_name: "B", supplier_name: "S", created_at: "2026-07-02" },
  { id: 3, product_id: 9, product_name: "Done", status: "done", purchase_order_status: "inbound_done", quantity: 1, created_at: "2026-07-03" }
];

test("procurement request filter preserves paging and business statuses", () => {
  const waiting = filterProcurementRequestsMysql(rows, { paged: "1", page: 1, pageSize: 10 });
  assert.deepEqual(waiting.rows.map((row) => row.id), [1, 2]);
  assert.equal(waiting.total, 2);

  const completed = filterProcurementRequestsMysql(rows, { status: "completed_purchase" });
  assert.deepEqual(completed.map((row) => row.id), [3]);
});

test("procurement grouping aggregates quantities and unique people", () => {
  const grouped = groupProcurementRequestsMysql(rows, { page: 1, pageSize: 10 });
  assert.equal(grouped.total, 1);
  assert.equal(grouped.rows[0].total_quantity, 5);
  assert.equal(grouped.rows[0].total_amount, 25);
  assert.deepEqual(grouped.rows[0].requester_names, ["A", "B"]);
  assert.deepEqual(grouped.rows[0].supplier_names, ["S"]);
});

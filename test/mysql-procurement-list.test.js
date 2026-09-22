import assert from "node:assert/strict";
import test from "node:test";

import {
  filterProcurementRequestsMysql,
  groupProcurementRequestsMysql
} from "../src/services/mysql-procurement-list.js";

const rows = [
  { id: 1, product_id: 8, product_name: "Mat", status: "pending", quantity: 2, amount: 10, person_name: "A", supplier_name: "S", created_at: "2026-07-01" },
  { id: 2, product_id: 8, product_name: "Mat", status: "suggested", quantity: 3, amount: 15, person_name: "B", supplier_name: "S", created_at: "2026-07-02" },
  { id: 3, product_id: 9, product_name: "Done", status: "done", purchase_order_status: "inbound_done", quantity: 1, created_at: "2026-07-03" },
  { id: 4, product_id: 8, product_name: "Purchased", status: "submitted", quantity: 7, amount: 35, person_name: "C", supplier_name: "S", created_at: "2026-07-04" }
];

test("procurement request filter preserves paging and business statuses", () => {
  const waiting = filterProcurementRequestsMysql(rows, { paged: "1", page: 1, pageSize: 10 });
  assert.deepEqual(waiting.rows.map((row) => row.id), [1, 2, 4]);
  assert.equal(waiting.total, 3);

  const completed = filterProcurementRequestsMysql(rows, { status: "completed_purchase" });
  assert.deepEqual(completed.map((row) => row.id), [3]);
});

test("procurement grouping aggregates quantities and unique people", () => {
  const grouped = groupProcurementRequestsMysql(rows, { page: 1, pageSize: 10 });
  assert.equal(grouped.total, 1);
  assert.equal(grouped.rows[0].total_quantity, 12);
  assert.equal(grouped.rows[0].total_amount, 60);
  assert.deepEqual(grouped.rows[0].requester_names, ["A", "B", "C"]);
  assert.deepEqual(grouped.rows[0].supplier_names, ["S"]);
});

test("FBP transit is shown once per product and never covers local procurement demand", () => {
  const requests = rows.map((row) => ({ ...row, incoming_stock: 3, fbp_transfer_in_transit_qty: "200" }));
  const result = groupProcurementRequestsMysql(requests).rows[0];
  const withoutTransit = groupProcurementRequestsMysql(requests.map((row) => ({ ...row, fbp_transfer_in_transit_qty: 0 }))).rows[0];
  assert.equal(result.fbp_transfer_in_transit_qty, 200);
  assert.equal(result.incoming_stock, 3);
  assert.deepEqual({ ...result, fbp_transfer_in_transit_qty: 0, requests: [] }, { ...withoutTransit, requests: [] });
});

test("historical procurement totals belong to a product and are not multiplied by its demand rows", () => {
  const input = rows.map(row => ({ ...row, historical_purchase_amount: "219.00", historical_purchased_quantity: 90, historical_purchase_count: 2 }));
  const grouped = groupProcurementRequestsMysql(input).rows[0];
  assert.equal(grouped.historical_purchase_amount, 219);
  assert.equal(grouped.historical_purchased_quantity, 90);
  assert.equal(grouped.historical_purchase_count, 2);
  assert.equal(groupProcurementRequestsMysql(rows).rows[0].historical_purchase_amount, 0);
});

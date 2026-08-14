import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeFbpReplenishmentItem,
  normalizeFbpReplenishmentOrder,
  normalizeFbpTransferRecord
} from "../src/services/mysql-fbp-normalizers.js";

test("FBP replenishment normalizers preserve applicants and numeric totals", () => {
  const item = normalizeFbpReplenishmentItem({
    id: "2",
    requested_by: "8",
    requested_by_name: "Alice",
    requested_qty: "12",
    approved_qty: "10",
    fbp_available: "3"
  });
  const order = normalizeFbpReplenishmentOrder({ id: "1", status: "approved" }, [item]);

  assert.equal(item.id, 2);
  assert.equal(item.fbp_effective_available, 3);
  assert.deepEqual(order.applicant_ids, [8]);
  assert.deepEqual(order.applicant_names, ["Alice"]);
  assert.equal(order.total_requested_qty, 12);
  assert.equal(order.total_approved_qty, 10);
});

test("FBP transfer normalizer calculates in-transit quantity", () => {
  const row = normalizeFbpTransferRecord({
    id: "9",
    product_id: "3",
    quantity: "20",
    listed_quantity: "7"
  });

  assert.equal(row.id, 9);
  assert.equal(row.product_id, 3);
  assert.equal(row.in_transit_quantity, 13);
});

import assert from "node:assert/strict";
import test from "node:test";
import { orderStatusHistoryBusinessFingerprint } from "../src/services/order-history-fingerprint.js";

test("order history fingerprint treats MySQL Date values as the equivalent SQL datetime string", () => {
  const fromMysql = {
    status: "delivering",
    customer_id: 12345,
    ordered_at: new Date("2026-10-10T10:00:00.000Z"),
    delivery_date_begin: null
  };
  const fromOzon = {
    status: "delivering",
    customer_id: "12345",
    ordered_at: "2026-10-10 10:00:00",
    delivery_date_begin: ""
  };

  assert.equal(
    orderStatusHistoryBusinessFingerprint(fromMysql),
    orderStatusHistoryBusinessFingerprint(fromOzon)
  );
});

test("order history fingerprint still detects business changes", () => {
  const baseline = { status: "delivering", tracking_stage: "in_transit", buyer_city: "Moscow" };
  assert.notEqual(
    orderStatusHistoryBusinessFingerprint(baseline),
    orderStatusHistoryBusinessFingerprint({ ...baseline, status: "delivered" })
  );
  assert.notEqual(
    orderStatusHistoryBusinessFingerprint(baseline),
    orderStatusHistoryBusinessFingerprint({ ...baseline, buyer_city: "Kazan" })
  );
});

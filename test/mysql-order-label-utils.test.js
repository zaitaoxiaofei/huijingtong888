import assert from "node:assert/strict";
import test from "node:test";

import {
  isDemoPackageLabelBufferMysql,
  normalizePackageLabelBufferMysql,
  orderPackageLabelChunksMysql,
  orderPackageLabelFailureMysql
} from "../src/services/mysql-order-label-utils.js";

test("order label rows are grouped by shop credentials and chunked at twenty", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    shop_id: 2,
    shop_name: "Shop",
    ozon_client_id: "client",
    api_key_hint: "key"
  }));
  const chunks = orderPackageLabelChunksMysql(rows);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].rows.length, 20);
  assert.equal(chunks[1].rows.length, 1);
  assert.deepEqual(chunks[0].shop, {
    id: 2,
    name: "Shop",
    ozon_client_id: "client",
    api_key_hint: "key"
  });
});

test("demo package labels are recognized so they cannot be reused as real labels", () => {
  assert.equal(isDemoPackageLabelBufferMysql(Buffer.from("Demo Ozon labels\\nP1")), true);
  assert.equal(isDemoPackageLabelBufferMysql(Buffer.from("%PDF real label")), false);
});

test("order label helpers normalize buffers and failures", () => {
  assert.deepEqual(normalizePackageLabelBufferMysql(new Uint8Array([1, 2])), Buffer.from([1, 2]));
  assert.deepEqual(orderPackageLabelFailureMysql({ id: 3, posting_number: "P3" }, new Error("boom")), {
    id: 3,
    posting_number: "P3",
    shop_name: undefined,
    error: "boom"
  });
});

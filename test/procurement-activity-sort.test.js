import assert from "node:assert/strict";
import test from "node:test";

import { groupProcurementRequestsMysql } from "../src/services/mysql-procurement-list.js";

test("grouped procurement rows put the most recently created product first", () => {
  const rows = [
    {
      id: 1,
      product_id: 101,
      product_name: "较早创建但刚修改",
      status: "pending",
      created_at: "2026-07-01 09:00:00",
      updated_at: "2026-07-30 10:00:00"
    },
    {
      id: 2,
      product_id: 102,
      product_name: "较晚创建但未修改",
      status: "pending",
      created_at: "2026-07-29 09:00:00",
      updated_at: "2026-07-29 09:00:00"
    }
  ];

  const result = groupProcurementRequestsMysql(rows, { page: 1, pageSize: 20 });

  assert.deepEqual(result.rows.map((row) => row.product_id), [102, 101]);
  assert.equal(result.rows[0].latest_created_at, "2026-07-29 09:00:00");
});

test("grouped procurement rows sort MySQL Date objects by timestamp", () => {
  const rows = [
    { id: 1, product_id: 101, status: "pending", created_at: new Date("2026-08-26T10:00:00Z") },
    { id: 2, product_id: 102, status: "pending", created_at: new Date("2026-08-27T09:00:00Z") }
  ];

  const result = groupProcurementRequestsMysql(rows, { page: 1, pageSize: 20 });

  assert.deepEqual(result.rows.map((row) => row.product_id), [102, 101]);
  assert.equal(result.rows[0].latest_created_at.getTime(), new Date("2026-08-27T09:00:00Z").getTime());
});

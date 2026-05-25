import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { outboundRecordsMysql } from "../src/services/mysql-cutover.js";

const mysqlTest = config.dbClient === "mysql" ? test : test.skip;

test.after(async () => {
  await closeMysqlPool();
});

function localDateText(value) {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0")
    ].join("-");
  }
  return String(value || "").slice(0, 10);
}

mysqlTest("MySQL outbound list supports server-side paging, status, and summary", async () => {
  const result = await outboundRecordsMysql({ paged: "1", page: 1, pageSize: 5, status: "all" });

  assert.equal(result.mode, "paged");
  assert.ok(result.total > 0);
  assert.equal(result.rows.length, Math.min(5, result.total));
  assert.equal(result.summary.totalRows, result.total);
  assert.equal(result.rows.length, new Set(result.rows.map((row) => row.id)).size);

  for (const status of ["deducted", "cancelled"]) {
    const filtered = await outboundRecordsMysql({ paged: "1", page: 1, pageSize: 10, status });
    assert.ok(filtered.rows.length <= 10);
    assert.ok(filtered.rows.every((row) => row.status === status));
  }
});

mysqlTest("MySQL outbound list supports page filters used by OutboundView", async () => {
  const sample = await mysqlQuery(`
    SELECT obr.order_ref, obr.shop_id, COALESCE(obr.ozon_sku, p.code, p.name) AS keyword,
      DATE(COALESCE(o.ordered_at, obr.created_at)) AS outbound_date
    FROM outbound_records obr
    JOIN products p ON p.id = obr.product_id
    LEFT JOIN orders o ON o.posting_number = obr.order_ref
    WHERE obr.order_ref IS NOT NULL AND obr.order_ref <> ''
    ORDER BY COALESCE(o.ordered_at, obr.created_at) DESC, obr.id DESC
    LIMIT 1
  `);
  assert.ok(sample.length > 0);

  const row = sample[0];
  const outboundDate = localDateText(row.outbound_date);
  const result = await outboundRecordsMysql({
    paged: "1",
    page: 1,
    pageSize: 20,
    dateFrom: outboundDate,
    dateTo: outboundDate,
    shopId: row.shop_id,
    query: row.order_ref
  });

  assert.ok(result.total > 0);
  assert.ok(result.rows.every((item) => String(item.shop_id) === String(row.shop_id)));
  assert.ok(result.rows.every((item) => localDateText(item.outbound_time || item.created_at) === outboundDate));
  assert.ok(result.rows.some((item) => item.order_ref === row.order_ref));
});

mysqlTest("MySQL outbound rows expose fields required by the frontend table", async () => {
  const result = await outboundRecordsMysql({ paged: "1", page: 1, pageSize: 10 });
  assert.ok(result.rows.length > 0);

  for (const row of result.rows) {
    assert.ok(row.id);
    assert.ok(row.order_ref);
    assert.ok(row.product_code);
    assert.ok(row.product_name);
    assert.notEqual(row.product_image_url, undefined);
    assert.notEqual(row.shop_name, undefined);
    assert.notEqual(row.ozon_sku, undefined);
    assert.notEqual(row.person_name, undefined);
    assert.notEqual(row.image_urls, undefined);
    assert.notEqual(row.order_item_id, undefined);
    assert.notEqual(row.order_amount, undefined);
    assert.notEqual(row.outbound_time, undefined);
  }
});

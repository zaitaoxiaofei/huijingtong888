import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ordersPage = fs.readFileSync(path.resolve("frontend/orders/OrdersPage.vue"), "utf8");
const ordersTable = fs.readFileSync(path.resolve("frontend/orders/components/OrdersTable.vue"), "utf8");
const mysqlService = fs.readFileSync(path.resolve("src/services/mysql-cutover.js"), "utf8");

test("quality-check rules use only the three built-in posting prefixes", () => {
  for (const prefix of ["02090", "02131", "02478"]) {
    assert.match(ordersPage, new RegExp(`"${prefix}"`));
    assert.match(mysqlService, new RegExp(`"${prefix}"`));
  }
  assert.doesNotMatch(ordersPage, /"0213"|"0247"|"0249"/);
  assert.doesNotMatch(mysqlService, /"0213"|"0247"|"0249"/);
  assert.match(mysqlService, /qualityParts\.push\("o\.posting_number LIKE \?"\)/);
});

test("order list exposes and renders the automatic quality-check classification", () => {
  assert.match(mysqlService, /is_quality_order: accounting\.is_quality_order \? 1 : 0/);
  assert.match(mysqlService, /order_nature: accounting\.order_nature/);
  assert.match(ordersPage, /qualityCheckOrder: isQualityCheckOrderRow\(row\)/);
  assert.match(ordersTable, /v-if="row\.qualityCheckOrder"[^>]*>质检单<\/el-tag>/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/server/routes/operations.js", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../frontend/admin/views/procurement/ProcurementPlatformOrdersView.vue", import.meta.url), "utf8");

test("platform-order import recognizes the Pinduoduo collector export", () => {
  for (const header of ["订单号", "下单时间（北京时间）", "订单实付金额", "商品总数量", "支付方式", "采购链接"]) {
    assert.match(service, new RegExp(header));
  }
  assert.match(service, /ON DUPLICATE KEY UPDATE/);
  assert.match(service, /INSERT IGNORE INTO procurement_platform_order_links/);
  assert.match(service, /Number\(match\[4\]\) - 8/);
});

test("platform orders expose import, candidate and multi-link endpoints", () => {
  assert.match(routes, /GET \/api\/procurement\/platform-orders/);
  assert.match(routes, /POST \/api\/procurement\/platform-orders\/import/);
  assert.match(routes, /platform-orders.*candidates/s);
  assert.match(routes, /platform-orders.*link/s);
  assert.match(page, /parsePddFile/);
  assert.match(page, /parse1688File/);
  assert.match(page, /multiple procurement records|一条或多条采购记录/);
});

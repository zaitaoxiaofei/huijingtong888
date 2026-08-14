import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const backendSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../frontend/admin/views/exceptions/ExceptionWorkbenchView.vue", import.meta.url), "utf8");

test("profit exceptions expose unified business order and profit model labels", () => {
  assert.match(backendSource, /function exceptionOrderBusinessStatusMysql/);
  assert.match(backendSource, /label: "已签收"/);
  assert.match(backendSource, /label: "已取消"/);
  assert.match(backendSource, /label: "已退货"/);
  assert.match(backendSource, /label: "拒收\/未领取"/);
  assert.match(backendSource, /label: modelKey === "actual" \? "真实利润模型"/);
  assert.match(backendSource, /modelKey === "mixed" \? "部分结算模型" : "预估利润模型"/);
  assert.match(backendSource, /o\.cancel_reason,/);
  assert.match(backendSource, /cancel_reason_label: hasCancellationContext \? cancellation\.reason_label : ""/);
});

test("profit exceptions do not present a zero margin when revenue cannot be used", () => {
  assert.match(backendSource, /const margin = sale \? \(profitValue \/ sale\) \* 100 : null/);
  assert.match(backendSource, /margin_label: margin === null \? "无法计算"/);
});

test("profit exception page opens inventory editing and provides formula details", () => {
  assert.match(pageSource, /query: \{ productId: String\(row\.productId\), openEdit: "1" \}/);
  assert.match(pageSource, /label="归类与具体原因"/);
  assert.match(pageSource, /'利润模型'/);
  assert.match(pageSource, /title="利润计算明细"/);
  assert.match(pageSource, /profit_detail_rows/);
  assert.match(pageSource, /一级归类/);
  assert.match(pageSource, /具体原因/);
  assert.match(pageSource, />编辑库存信息</);
  assert.doesNotMatch(pageSource, />查看库存</);
});

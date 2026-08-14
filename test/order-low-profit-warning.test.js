import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const tableSource = await readFile(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");
const styleSource = await readFile(new URL("../frontend/orders/orders-view.css", import.meta.url), "utf8");

test("order list warns when effective profit is below one yuan", () => {
  assert.match(pageSource, /const effective = fullyAccrued \? actual : estimated/);
  assert.match(pageSource, /settlementStates\.length > 0[\s\S]*profitStatuses\.length > 0[\s\S]*settlementStates\.every[\s\S]*profitStatuses\.every/);
  assert.match(pageSource, /effective < 0 \? "loss" : effective < 1 \? "low" : ""/);
  assert.match(tableSource, /row-class-name="orderRowClassName"/);
  assert.match(tableSource, /"亏损" : "低利润"/);
  assert.match(styleSource, /\.is-low-profit-order/);
  assert.match(styleSource, /\.orders-low-profit-value/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
const orders = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");

test("purchase mode is stored per request and purchase item without rewriting history", () => {
  assert.match(schema, /procurement_requests[\s\S]*purchase_mode VARCHAR\(32\) NOT NULL DEFAULT 'shortage_purchase'/);
  assert.match(schema, /purchase_order_items[\s\S]*purchase_mode VARCHAR\(32\) NOT NULL DEFAULT 'shortage_purchase'/);
  assert.match(service, /stock_record_backfill/);
});

test("stock record backfill is immediately received and never creates pending arrival", () => {
  assert.match(service, /确认有货补采购记录，不重复增加库存/);
  assert.match(service, /purchaseMode === "stock_record_backfill" \? "inbound_done" : "purchased"/);
  assert.match(service, /request\.purchase_mode = 'shortage_purchase'/);
});

test("workspace and order purchase entry expose both business modes", () => {
  for (const source of [workspace, orders]) {
    assert.match(source, />缺货采购</);
    assert.match(source, />确认有货补采购记录</);
  }
  assert.match(orders, /补采购记录 · 已到货/);
});

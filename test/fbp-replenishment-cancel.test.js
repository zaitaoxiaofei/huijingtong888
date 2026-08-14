import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const pageSource = fs.readFileSync(path.join(root, "frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue"), "utf8");
const serviceSource = fs.readFileSync(path.join(root, "src/services/mysql-cutover.js"), "utf8");

test("approved FBP replenishment orders expose a cancel action", () => {
  assert.match(pageSource, /function canCancelOrder[\s\S]{0,160}status \|\| ""\) === "approved"/);
  assert.match(pageSource, /@click="cancelOrder\(row\.order\)"/);
  assert.match(pageSource, /status: "cancelled"/);
  assert.match(pageSource, /label: "已取消", value: "cancelled"/);
});

test("cancelling an approved FBP order reverses its generated transfer", () => {
  assert.match(serviceSource, /cancelFbpReplenishmentApprovedTransfersMysql/);
  assert.match(serviceSource, /FBP备货单取消，本地库存退回/);
  assert.match(serviceSource, /SET status = 'cancelled'/);
  assert.match(serviceSource, /\["sent", "ozon_created", "completed"\]/);
});

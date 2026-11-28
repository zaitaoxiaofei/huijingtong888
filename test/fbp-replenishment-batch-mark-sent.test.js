import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue", import.meta.url), "utf8");

test("FBP batch summary can mark all approved source orders as sent", () => {
  assert.match(source, /function canMarkBatchSent\(row\)/);
  assert.match(source, /row\._sourceOrders\.some\(\(order\) => canMarkSent\(order\)\)/);
  assert.match(source, /function markBatchSent\(row\)/);
  assert.match(source, /confirmShipment\(row, approvedOrders,/);
  assert.match(source, /Promise\.allSettled\(orders\.map/);
  assert.match(source, /未填写快递单号，是否确认发货？/);
  assert.match(source, /confirm_without_tracking: !order.express_tracking_number/);
  assert.match(source, /status: "sent"/);
  assert.match(source, /action: "save_tracking"/);
  assert.match(source, /@click="openTrackingDialog\(row.order\)"/);
  assert.match(source, /v-if="canMarkBatchSent\(row\.order\)"/);
  assert.match(source, /@click="markBatchSent\(row\.order\)"/);
});

test("FBP batch summary opens the quantity receipt dialog instead of completing without receipt", () => {
  assert.match(source, /async function markBatchCompleted\(row\) \{\s+return openReceiptDialog\(row\);/);
  assert.match(source, /order\._sourceOrders\.filter\(canMarkCompleted\)/);
  assert.match(source, /@click="markBatchCompleted\(row\.order\)"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { planRepair } from "../scripts/repair-fbp-auto-receipts.mjs";

const transfer = { id: 191, product_id: 48, shop_id: 4, ozon_sku: "4069090137", source_ref: "fbp_replenishment:43:225", quantity: 200, listed_quantity: 200, status: "listed", note: "确认入仓 172 件：库存同步自动确认\n确认入仓 28 件：库存同步自动确认" };
const movements = [172, 28].map((quantity, index) => ({ id: index + 1, product_id: 48, shop_id: 4, quantity_delta: quantity, source_type: "fbp_transfer_received", source_ref: `fbp_transfer:191:received:${index}`, status: "posted", stock_location: "FBP", movement_type: "MANUAL_ADJUST" }));
const orders = [{ id: 43, status: "sent" }];

test("restore all traceable automatic receipts on pending shipments", () => {
  const plan = planRepair([transfer], movements, orders);
  assert.equal(plan.restored_quantity, 200);
  assert.deepEqual(plan.repairs[0].movement_ids, [1, 2]);
});
test("completed and unlinked shipments require physical receipt review", () => {
  assert.equal(planRepair([transfer], movements, [{ id: 43, status: "completed" }]).review.length, 1);
  assert.equal(planRepair([{ ...transfer, source_ref: "legacy" }], movements, orders).repairs.length, 0);
});
test("manual or missing receipt evidence blocks automatic repair", () => {
  assert.throws(() => planRepair([transfer], movements.slice(1), orders), /receipt evidence/);
  assert.throws(() => planRepair([{ ...transfer, listed_quantity: 199 }], movements, orders), /mixed or altered/);
  assert.throws(() => planRepair([transfer], movements.map((row) => ({ ...row, stock_location: "LOCAL" })), orders));
});
test("a completed repair is repeat-safe", () => {
  assert.equal(planRepair([{ ...transfer, note: transfer.note + "\n[fbp-auto-receipt-repair-20260916]", listed_quantity: 0 }], movements, orders).restored_quantity, 0);
});

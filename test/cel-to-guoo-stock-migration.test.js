import test from "node:test";
import assert from "node:assert/strict";

import { buildCelClearPlan, buildCopyPlan } from "../scripts/migrate-cel-stock-to-guoo.mjs";

test("CEL to GUOO copy plan sums two source warehouses into one target", () => {
  const mappings = [
    { shopId: 4, shopName: "M", sourceId: "cel-land", targetId: "guoo-small" },
    { shopId: 4, shopName: "M", sourceId: "cel-air", targetId: "guoo-small" }
  ];
  const rows = [
    { shop_id: 4, offer_id: "SKU-1", warehouse_id: "cel-land", present: 8, reserved: 1, available: 7 },
    { shop_id: 4, offer_id: "SKU-1", warehouse_id: "cel-air", present: 5, reserved: 2, available: 3 },
    { shop_id: 4, offer_id: "SKU-1", warehouse_id: "guoo-small", present: 2, reserved: 0, available: 2 }
  ];
  const plan = buildCopyPlan(rows, mappings);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].source_present, 13);
  assert.equal(plan[0].source_reserved, 3);
  assert.equal(plan[0].source_available, 10);
  assert.equal(plan[0].current_target_present, 2);
  assert.equal(plan[0].current_target_available, 2);
});

test("CEL to GUOO copy plan clears a target-only stale stock row", () => {
  const mappings = [{ shopId: 5, shopName: "S", sourceId: "cel", targetId: "guoo" }];
  const plan = buildCopyPlan([
    { shop_id: 5, offer_id: "STALE", warehouse_id: "guoo", present: 888, available: 888 }
  ], mappings);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].source_present, 0);
  assert.equal(plan[0].source_available, 0);
  assert.equal(plan[0].current_target_present, 888);
  assert.equal(plan[0].current_target_available, 888);
});

test("CEL to GUOO copy plan ignores excluded warehouses and shops", () => {
  const mappings = [{ shopId: 6, shopName: "X", sourceId: "cel", targetId: "guoo" }];
  const plan = buildCopyPlan([
    { shop_id: 6, offer_id: "HUNCHUN", warehouse_id: "hunchun", present: 20 },
    { shop_id: 8, offer_id: "VELO", warehouse_id: "cel", present: 30 }
  ], mappings);
  assert.deepEqual(plan, []);
});

test("CEL clear plan includes active and archived positive source rows but excludes Hunchun and GUOO", () => {
  const mappings = [{ shopId: 4, shopName: "M", sourceId: "cel", targetId: "guoo" }];
  const plan = buildCelClearPlan([
    { shop_id: 4, shop_name: "M", product_state: "active", offer_id: "ACTIVE", warehouse_id: "cel", available: 8 },
    { shop_id: 4, shop_name: "M", product_state: "archived", offer_id: "ARCHIVED", warehouse_id: "cel", available: 5 },
    { shop_id: 4, shop_name: "M", offer_id: "ZERO", warehouse_id: "cel", available: 0 },
    { shop_id: 4, shop_name: "M", offer_id: "HUNCHUN", warehouse_id: "hunchun", available: 9 },
    { shop_id: 4, shop_name: "M", offer_id: "TARGET", warehouse_id: "guoo", available: 10 }
  ], mappings);
  assert.deepEqual(plan.map((item) => [item.offer_id, item.stock]), [["ACTIVE", 0], ["ARCHIVED", 0]]);
});

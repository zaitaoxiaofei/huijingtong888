import assert from "node:assert/strict";
import test from "node:test";

import { normalizePurchasePlanMysql } from "../src/services/mysql-cutover.js";

test("normalizePurchasePlanMysql prefers procurement quantity over product default purchase quantity", () => {
  const plan = normalizePurchasePlanMysql({
    purchase_quantity: 1,
    procurement_quantity: 8,
    purchase_total_amount: 80,
    domestic_shipping_total: 16
  });

  assert.equal(plan.quantity, 8);
  assert.equal(plan.amount, 80);
  assert.equal(plan.shippingAmount, 16);
  assert.equal(plan.unitPurchaseCost, 10);
  assert.equal(plan.unitDomesticShipping, 2);
});

test("normalizePurchasePlanMysql falls back to product purchase quantity when no procurement quantity is provided", () => {
  const plan = normalizePurchasePlanMysql({
    purchase_quantity: 5,
    purchase_total_amount: 50,
    domestic_shipping_total: 15
  });

  assert.equal(plan.quantity, 5);
  assert.equal(plan.unitPurchaseCost, 10);
  assert.equal(plan.unitDomesticShipping, 3);
});

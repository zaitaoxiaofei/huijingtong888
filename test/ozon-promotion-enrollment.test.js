import assert from "node:assert/strict";
import test from "node:test";
import { normalizePromotionEnrollment, promotionEnrollmentOutcome } from "../src/services/ozon-promotion-enrollment.js";

const product = (id = 1, currency = "RUB") => ({ product_id: id, action_price: { amount: "88.00", currency }, stock: "8" });

test("official enrollment preserves explicit Money and stock without truncating a batch", () => {
  assert.deepEqual(normalizePromotionEnrollment(123, [product(), product(2, "CNY")]), { action_id: 123, products: [product(), product(2, "CNY")] });
  assert.deepEqual(normalizePromotionEnrollment(123, [{ id: 1, action_price: 88, currency: "CNY", stock: 0 }]).products[0], { product_id: 1, action_price: { amount: "88", currency: "CNY" }, stock: "0" });
});

test("invalid, missing and duplicate product facts reject the entire enrollment", () => {
  for (const row of [ { ...product(), product_id: 1.5 }, { ...product(), action_price: 88 }, { ...product(), stock: -1 }, { ...product(), stock: 1.2 }, { ...product(), action_price: { amount: "1.001", currency: "CNY" } }, { ...product(), action_price: { amount: "0", currency: "RUB" } }, { ...product(), action_price: { amount: "88", currency: "USD" } } ]) assert.throws(() => normalizePromotionEnrollment(123, [row]));
  assert.throws(() => normalizePromotionEnrollment(123, [product(), product()]));
  assert.throws(() => normalizePromotionEnrollment(123, Array.from({ length: 1001 }, (_, i) => product(i + 1))));
  assert.throws(() => normalizePromotionEnrollment("not-an-id", [product()]));
});

test("only an explicit active receipt plus matching current membership and Money confirms success", () => {
  const result = promotionEnrollmentOutcome([product(), product(2)], { active_product_ids: ["1", "2"], rejected: [{ product_id: "2", reason: "price too high" }], warnings: [{ product_id: "1", reason: "shared price" }] }, [product(), product(2)]);
  assert.equal(result.success, false);
  assert.deepEqual(result.confirmedProductIds, [1]);
  assert.equal(result.failures[0].reason, "price too high");
  assert.match(result.warnings[0], /shared price/);
  assert.equal(promotionEnrollmentOutcome([product()], { active_product_ids: [1] }, [product()]).success, true);
});

test("empty receipts, contradictions, read failures and changed prices cannot become success", () => {
  for (const [receipt, rows, error] of [ [{}, [product()], ""], [{ active_product_ids: [1], deactivated_product_ids: [1] }, [product()], ""], [{ active_product_ids: [1] }, [], ""], [{ active_product_ids: [1] }, [product(1, "CNY")], ""], [{ active_product_ids: [1] }, [product()], "permission revoked"] ]) {
    const result = promotionEnrollmentOutcome([product()], receipt, rows, error);
    assert.equal(result.success, false);
    assert.equal(result.count, 0);
    assert.equal(result.failures.length, 1);
  }
});

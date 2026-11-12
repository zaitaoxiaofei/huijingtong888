import assert from "node:assert/strict";
import test from "node:test";
import { normalizePromotionEnrollment, normalizePromotionProductPage, validatePromotionEnrollmentFacts, promotionEnrollmentOutcome } from "../src/services/ozon-promotion-enrollment.js";

const product = (id = 1, currency = "RUB") => ({ product_id: id, action_price: { amount: "88.00", currency }, stock: "8" });
const money = amount => ({ amount, currency: "CNY" });

test("v2 activity price normalization keeps a stable product-price base and blocks ambiguous currency", () => {
  const row = { id: 1, price: money("200"), action_price: money("100"), max_action_price: money("120"), marketplace_seller_price: money("90") };
  const normalized = normalizePromotionProductPage([row])[0];
  assert.equal(normalized.enrollment_base_price, 200);
  assert.equal(normalized.action_price, 100);
  assert.equal(normalized.price_money_verified, true);
  assert.equal(normalized.currency, "CNY");
  assert.equal(normalizePromotionProductPage([{ ...row, action_price: money("50") }])[0].enrollment_base_price, 200);
  for (const patch of [{ action_price: { amount: "100", currency: "RUB" } }, { price: 200 }, { price: { amount: "200" } }, { price: { amount: "200.001", currency: "CNY" } }]) {
    const invalid = normalizePromotionProductPage([{ ...row, ...patch }])[0];
    assert.equal(invalid.enrollment_base_price, null);
    assert.equal(invalid.currency, "");
    assert.equal(invalid.price_money_verified, false);
  }
});

test("fresh enrollment preflight uses current shop Money and threshold, without silently decreasing the submitted price", () => {
  const request = normalizePromotionEnrollment(123, [{ id: 1, action_price: 100, currency: "CNY" }]).products;
  const row = { id: 1, price: money("200"), action_price: money("80"), max_action_price: money("120") };
  assert.deepEqual(validatePromotionEnrollmentFacts(request, [row], {}).products, request);
  for (const rows of [[], [{ ...row, max_action_price: money("90") }], [{ ...row, action_price: { amount: "80", currency: "RUB" } }], [{ ...row, min_seller_price: money("110") }]]) {
    const result = validatePromotionEnrollmentFacts(request, rows, {});
    assert.equal(result.products.length, 0);
    assert.equal(result.failures.length, 1);
  }
});

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


test("22 accepted enrollment receipts remain pending, not rejected, after readback rate limiting", () => {
  const products = Array.from({ length: 22 }, (_, i) => product(i + 1));
  const outcome = promotionEnrollmentOutcome(products, { active_product_ids: products.map(p => p.product_id) }, [],
    Object.assign(Error("You have reached request rate limit per second"), { status: 429 }));
  assert.equal(outcome.count, 0); assert.equal(outcome.pendingProductIds.length, 22);
  assert.equal(outcome.rejectedProductIds.length, 0);
  assert.ok(outcome.failures.every(row => row.status === "pending" && row.code === "READBACK_RATE_LIMITED"));
  assert.doesNotMatch(outcome.failures[0].reason, /\[object Object\]/);
});
test("explicit rejection and preflight failure stay distinct from pending verification", () => {
  const outcome = promotionEnrollmentOutcome([product(1), product(2), product(3)], {
    active_product_ids: [1], rejected: [{ product_id: 2, reason: "above maximum" }]
  }, [], "rate limit", [{ product_id: 3, reason: "currency changed" }]);
  assert.deepEqual(outcome.pendingProductIds, [1]); assert.deepEqual(outcome.rejectedProductIds, [2, 3]);
  assert.equal(outcome.failures[1].reason, "above maximum");
  assert.equal(outcome.failures[1].code, undefined);
});

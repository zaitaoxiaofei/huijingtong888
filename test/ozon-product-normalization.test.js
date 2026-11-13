import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOzonFbpPostingForTest, normalizeOzonPostingForTest, normalizeOzonProductForTest } from "../src/ozonClient.js";

test("normalizeOzonProduct does not fallback ozon_sku to offer_id or product_id", () => {
  const fromOfferOnly = normalizeOzonProductForTest({
    id: 4779399576,
    product_id: 4779399576,
    offer_id: "AV-140-mpobj9g5",
    name: "Offer fallback candidate"
  });
  assert.equal(fromOfferOnly.ozon_sku, "");
  assert.equal(fromOfferOnly.offer_id, "AV-140-mpobj9g5");
  assert.equal(fromOfferOnly.ozon_product_id, "4779399576");

  const fromRealSku = normalizeOzonProductForTest({
    id: 4704717357,
    product_id: 4704717357,
    sku: 4405886447,
    offer_id: "mz-20260522-2V0N-001",
    name: "Real SKU candidate"
  });
  assert.equal(fromRealSku.ozon_sku, "4405886447");
  assert.equal(fromRealSku.offer_id, "mz-20260522-2V0N-001");
  assert.equal(fromRealSku.ozon_product_id, "4704717357");
});

test("normalizeOzonPosting does not fallback item ozon_sku to offer_id", () => {
  const posting = normalizeOzonPostingForTest({
    posting_number: "POST-1",
    products: [{
      offer_id: "AV-140-mpobj9g5",
      product_id: 4779399576,
      name: "Offer fallback candidate",
      quantity: 1,
      price: 100
    }]
  });

  assert.equal(posting.items[0].ozon_sku, "");
  assert.equal(posting.items[0].offer_id, "AV-140-mpobj9g5");
  assert.equal(posting.items[0].ozon_product_id, "4779399576");
});

for (const [schema, normalize] of [["FBS", normalizeOzonPostingForTest], ["FBP", normalizeOzonFbpPostingForTest]]) {
  test(`${schema} does not use financial SKU as catalog product ID, including reordered financial rows`, () => {
    const posting = normalize({
      posting_number: "POST-SKU-CONTRACT",
      products: [
        { sku: 111, offer_id: "first", quantity: 1, price: "100", currency_code: "RUB" },
        { sku: 222, offer_id: "second", quantity: 2, price: "200", currency_code: "RUB" }
      ],
      financial_data: { products: [{ product_id: 222 }, { product_id: 111 }] }
    });
    assert.deepEqual(posting.items.map(item => item.ozon_sku), ["111", "222"]);
    assert.deepEqual(posting.items.map(item => item.ozon_product_id), ["", ""]);
    assert.deepEqual(posting.items.map(item => item.offer_id), ["first", "second"]);
    assert.deepEqual(posting.items.map(item => item.sale_price), [100, 200]);
  });
  test(`${schema} preserves an explicit catalog ID without replacing its SKU`, () => {
    const item = normalize({ products: [{ sku: 111, product_id: 999, offer_id: "first" }] }).items[0];
    assert.equal(item.ozon_sku, "111");
    assert.equal(item.ozon_product_id, "999");
  });
}

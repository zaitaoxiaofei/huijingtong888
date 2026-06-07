import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOzonPostingForTest, normalizeOzonProductForTest } from "../src/ozonClient.js";

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

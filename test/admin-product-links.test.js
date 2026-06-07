import assert from "node:assert/strict";
import test from "node:test";

import { ozonBuyerProductKeyFromRow, ozonBuyerProductLinkFromRow } from "../frontend/admin/utils/product-links.js";

test("admin product links prefer real sku from online product row", () => {
  const row = {
    ozon_product_id: "4936359904",
    ozon_sku: "4601347655",
    raw_json: JSON.stringify({
      id: 4936359904,
      sku: 4601347655,
      sources: [{ sku: 4601347655 }]
    })
  };

  assert.equal(ozonBuyerProductKeyFromRow(row), "4601347655");
  assert.equal(ozonBuyerProductLinkFromRow(row), "https://www.ozon.ru/product/4601347655/");
});

test("admin product links fall back to ozon product id when sku is unavailable", () => {
  const row = {
    ozon_product_id: "4779399576",
    ozon_sku: "__MISSING_SKU__:4779399576",
    raw_json: JSON.stringify({
      id: 4779399576,
      sku: 0
    })
  };

  assert.equal(ozonBuyerProductKeyFromRow(row), "4779399576");
  assert.equal(ozonBuyerProductLinkFromRow(row), "https://www.ozon.ru/product/4779399576/");
});

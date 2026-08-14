import assert from "node:assert/strict";
import test from "node:test";

import { fetchOzonProductRefs, fetchOzonProducts, filterPendingListingProductsWithoutFbsStock, normalizeOzonProductForTest, pendingListingVisibilityFilters } from "../src/ozonClient.js";
import fs from "node:fs";

test("fetchOzonProducts uses ozon_api_key even when api_key_hint is empty", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || "{}"), headers: options.headers || {} });
    if (String(url).endsWith("/v3/product/list")) {
      return jsonResponse({
        result: {
          items: calls.length === 1 ? [{ product_id: 12345 }] : [],
          last_id: ""
        }
      });
    }
    if (String(url).endsWith("/v3/product/info/list")) {
      return jsonResponse({
        result: {
          items: [{
            id: 12345,
            sku: 98765,
            offer_id: "real-offer",
            name: "Real Ozon Product",
            price: "101.50",
            currency_code: "RUB"
          }]
        }
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const products = await fetchOzonProducts({
    id: 1,
    name: "Real Shop",
    ozon_client_id: "4174207",
    ozon_api_key: "real-api-key",
    api_key_hint: ""
  });

  assert.ok(calls.length > 0);
  assert.equal(calls[0].headers["Api-Key"], "real-api-key");
  assert.deepEqual(products.map((item) => item.offer_id), ["real-offer"]);
});

test("fetchOzonProducts keeps specific zero-stock visibility over ALL", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    if (String(url).endsWith("/v3/product/list")) {
      const visibility = String(body?.filter?.visibility || "");
      return jsonResponse({
        result: {
          items: ["ALL", "STATE_FAILED", "EMPTY_STOCK"].includes(visibility) ? [{ product_id: 67890 }] : [],
          last_id: ""
        }
      });
    }
    if (String(url).endsWith("/v3/product/info/list")) {
      return jsonResponse({
        result: {
          items: [{
            id: 67890,
            sku: 123456,
            offer_id: "zero-stock-offer",
            name: "Zero Stock Product",
            price: "55.00",
            currency_code: "RUB"
          }]
        }
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const products = await fetchOzonProducts({
    id: 1,
    name: "Real Shop",
    ozon_client_id: "4174207",
    ozon_api_key: "real-api-key"
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].visibility, "EMPTY_STOCK");
  assert.equal(products[0].status, "ready");
});

test("fetchOzonProducts can limit product list to pending listing visibility", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/v3/product/list")) {
      return jsonResponse({
        result: {
          items: [{ product_id: body.filter.visibility === "EMPTY_STOCK" ? 101 : 102 }],
          last_id: ""
        }
      });
    }
    if (String(url).endsWith("/v3/product/info/list")) {
      return jsonResponse({
        result: {
          items: (body.product_id || []).map((id) => ({
            id,
            sku: id + 1000,
            offer_id: `pending-${id}`,
            name: `Pending ${id}`,
            price: "1.00"
          }))
        }
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const products = await fetchOzonProducts({
    id: 1,
    name: "Real Shop",
    ozon_client_id: "4174207",
    ozon_api_key: "real-api-key"
  }, { visibilityFilters: ["EMPTY_STOCK", "READY_TO_SUPPLY"] });

  const listVisibilities = calls
    .filter((item) => item.url.endsWith("/v3/product/list"))
    .map((item) => item.body.filter.visibility);
  assert.deepEqual(listVisibilities, ["EMPTY_STOCK", "READY_TO_SUPPLY"]);
  assert.deepEqual(products.map((item) => item.offer_id), ["pending-101", "pending-102"]);
});

test("pending listing sync only pulls the strict pending visibility buckets", () => {
  assert.deepEqual(pendingListingVisibilityFilters(), ["EMPTY_STOCK", "READY_TO_SUPPLY"]);
});

test("pending listing sync reconciles Ozon archived products into local status", () => {
  const source = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  assert.match(source, /fetchOzonProductRefs\(shop, \{ visibilityFilters: \["ARCHIVED"\]/);
  assert.match(source, /reconcileArchivedOnlineProductsMysql\(shop\.id, archivedRefs\)/);
  assert.match(source, /SET archived = 1,[\s\S]*status = 'archived',[\s\S]*visibility = 'ARCHIVED'/);
});

test("pending listing refs do not fetch full product details", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        result: {
          items: [{ product_id: body.filter.visibility === "EMPTY_STOCK" ? 101 : 102 }],
          last_id: ""
        }
      })
    };
  };

  const refs = await fetchOzonProductRefs({
    id: 1,
    name: "Pending Test Shop",
    ozon_client_id: "4174207",
    ozon_api_key: "real-api-key"
  }, {
    visibilityFilters: pendingListingVisibilityFilters(),
    visibilityConcurrency: 2
  });

  assert.deepEqual(refs.map((item) => item.id).sort(), [101, 102]);
  assert.equal(calls.filter((item) => item.url.endsWith("/v3/product/list")).length, 2);
  assert.equal(calls.filter((item) => item.url.endsWith("/v3/product/info/list")).length, 0);
});

test("archived product visibility wins over pending visibility when Ozon returns both", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    if (String(url).endsWith("/v3/product/list")) {
      return jsonResponse({
        result: {
          items: [{ product_id: 5013175620 }],
          last_id: ""
        }
      });
    }
    if (String(url).endsWith("/v3/product/info/list")) {
      return jsonResponse({
        result: {
          items: (body.product_id || []).map((id) => ({
            id,
            sku: 4666299221,
            offer_id: "AV-247-mq7s1nn4",
            name: "Archived product",
            price: "67.20"
          }))
        }
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const products = await fetchOzonProducts({
    id: 1,
    name: "Real Shop",
    ozon_client_id: "4174207",
    ozon_api_key: "real-api-key"
  }, { visibilityFilters: ["READY_TO_SUPPLY", "ARCHIVED"] });

  assert.equal(products.length, 1);
  assert.equal(products[0].visibility, "ARCHIVED");
  assert.equal(products[0].status, "archived");
  assert.equal(products[0].archived, 1);
});

test("autoarchived product info is normalized as archived", () => {
  const product = normalizeOzonProductForTest({
    id: 4068129151,
    sku: 3889414195,
    offer_id: "mz-26040917-247859",
    name: "Autoarchived product",
    visible: true,
    is_archived: true,
    is_autoarchived: true,
    stocks: {
      has_stock: true,
      stocks: [{ present: 888, reserved: 0, sku: 3889414195, source: "fbs" }]
    }
  });

  assert.equal(product.status, "archived");
  assert.equal(product.visibility, "ARCHIVED");
  assert.equal(product.archived, 1);
});

test("fetchOzonProducts can fetch visibility buckets concurrently", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let activeListRequests = 0;
  let maxActiveListRequests = 0;

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    if (String(url).endsWith("/v3/product/list")) {
      activeListRequests += 1;
      maxActiveListRequests = Math.max(maxActiveListRequests, activeListRequests);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeListRequests -= 1;
      const visibility = body.filter.visibility;
      return jsonResponse({
        result: {
          items: [{ product_id: visibility === "EMPTY_STOCK" ? 101 : visibility === "READY_TO_SUPPLY" ? 102 : 103 }],
          last_id: ""
        }
      });
    }
    if (String(url).endsWith("/v3/product/info/list")) {
      return jsonResponse({
        result: {
          items: (body.product_id || []).map((id) => ({
            id,
            sku: id + 1000,
            offer_id: `offer-${id}`,
            name: `Product ${id}`,
            price: "1.00"
          }))
        }
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const products = await fetchOzonProducts({
    id: 1,
    name: "Real Shop",
    ozon_client_id: "4174207",
    ozon_api_key: "real-api-key"
  }, {
    visibilityFilters: ["EMPTY_STOCK", "READY_TO_SUPPLY", "ARCHIVED"],
    visibilityConcurrency: 3
  });

  assert.equal(products.length, 3);
  assert.ok(maxActiveListRequests > 1);
});

test("fetchOzonProducts can fetch product detail chunks concurrently", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let activeDetailRequests = 0;
  let maxActiveDetailRequests = 0;

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    if (String(url).endsWith("/v3/product/list")) {
      return jsonResponse({
        result: {
          items: Array.from({ length: 2001 }, (_, index) => ({ product_id: index + 1 })),
          last_id: ""
        }
      });
    }
    if (String(url).endsWith("/v3/product/info/list")) {
      activeDetailRequests += 1;
      maxActiveDetailRequests = Math.max(maxActiveDetailRequests, activeDetailRequests);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeDetailRequests -= 1;
      return jsonResponse({
        result: {
          items: (body.product_id || []).map((id) => ({
            id,
            sku: id + 10000,
            offer_id: `offer-${id}`,
            name: `Product ${id}`,
            price: "1.00"
          }))
        }
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const products = await fetchOzonProducts({
    id: 1,
    name: "Real Shop",
    ozon_client_id: "4174207",
    ozon_api_key: "real-api-key"
  }, {
    visibilityFilters: ["ALL"],
    detailConcurrency: 3
  });

  assert.equal(products.length, 2001);
  assert.ok(maxActiveDetailRequests > 1);
});

test("pending listing sync filters stocked and archived products", () => {
  const products = [
    { ozon_product_id: "101", ozon_sku: "50101", offer_id: "offer-stocked" },
    { ozon_product_id: "102", ozon_sku: "50102", offer_id: "offer-empty" },
    { ozon_product_id: "103", ozon_sku: "50103", offer_id: "offer-fbp" },
    { ozon_product_id: "104", ozon_sku: "50104", offer_id: "offer-archived", status: "archived", visibility: "ARCHIVED", archived: 1 }
  ];
  const stockRows = [
    { ozon_product_id: "101", ozon_sku: "50101", offer_id: "offer-stocked", stock_type: "fbs_virtual", available: 888, present: 888 },
    { ozon_product_id: "102", ozon_sku: "50102", offer_id: "offer-empty", stock_type: "fbs_virtual", available: 0, present: 0 },
    { ozon_product_id: "103", ozon_sku: "50103", offer_id: "offer-fbp", stock_type: "fbp_real", available: 20, present: 20 },
    { ozon_product_id: "104", ozon_sku: "50104", offer_id: "offer-archived", stock_type: "fbs_virtual", available: 888, present: 888 }
  ];

  assert.deepEqual(
    filterPendingListingProductsWithoutFbsStock(products, stockRows).map((item) => item.offer_id),
    ["offer-empty", "offer-fbp"]
  );
});

test("pending listing prefilter uses product id before product details provide SKU", () => {
  const refs = [
    { ozon_product_id: "101", visibility: "READY_TO_SUPPLY" },
    { ozon_product_id: "102", visibility: "EMPTY_STOCK" }
  ];
  const stockRows = [
    { ozon_product_id: "101", stock_type: "fbs_virtual", available: 0, present: 0 },
    { ozon_product_id: "102", stock_type: "fbs_virtual", available: 10, present: 10 }
  ];

  assert.deepEqual(
    filterPendingListingProductsWithoutFbsStock(refs, stockRows, { requireSku: false })
      .map((item) => item.ozon_product_id),
    ["101"]
  );
  assert.deepEqual(filterPendingListingProductsWithoutFbsStock(refs, stockRows), []);
});

test("pending listing sync excludes products without a real Ozon SKU", () => {
  const products = [
    {
      ozon_product_id: "5485355520",
      ozon_sku: "",
      offer_id: "AI-VOLKSWAGEN-964568",
      visibility: "READY_TO_SUPPLY",
      stocks_json: JSON.stringify({
        has_stock: true,
        stocks: [{ present: 888, reserved: 0, source: "fbs" }]
      }),
      raw_json: JSON.stringify({
        product_id: 5485355520,
        offer_id: "AI-VOLKSWAGEN-964568",
        stocks: {
          has_stock: true,
          stocks: [{ present: 888, reserved: 0, source: "fbs" }]
        }
      })
    },
    {
      ozon_product_id: "5485355523",
      ozon_sku: "",
      offer_id: "AI-UNKNOWN-HAS-STOCK",
      visibility: "READY_TO_SUPPLY",
      stocks_json: JSON.stringify({
        has_stock: true,
        stocks: [{ present: 888, reserved: 0 }]
      })
    },
    {
      ozon_product_id: "5485355521",
      ozon_sku: "",
      offer_id: "AI-NISSAN-EMPTY",
      visibility: "EMPTY_STOCK",
      stocks_json: JSON.stringify({
        has_stock: false,
        stocks: [{ present: 0, reserved: 0, source: "fbs" }]
      })
    }
  ];

  assert.deepEqual(
    filterPendingListingProductsWithoutFbsStock(products, []).map((item) => item.offer_id),
    []
  );
});

test("pending listing sync excludes no-SKU products even when they only report FBP stock", () => {
  const products = [{
    ozon_product_id: "5485355522",
    ozon_sku: "",
    offer_id: "AI-FBP-ONLY",
    visibility: "READY_TO_SUPPLY",
    stocks_json: JSON.stringify({
      has_stock: true,
      stocks: [{ present: 20, reserved: 0, type: "fbo" }]
    })
  }];

  assert.deepEqual(
    filterPendingListingProductsWithoutFbsStock(products, []).map((item) => item.offer_id),
    []
  );
});

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(data)
  };
}

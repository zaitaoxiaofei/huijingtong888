import assert from "node:assert/strict";
import test from "node:test";

import { fetchOzonProducts } from "../src/ozonClient.js";

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

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(data)
  };
}

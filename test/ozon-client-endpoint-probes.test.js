import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOzonCategoryAttributeValues,
  fetchOzonCashFlowStatement,
  fetchOzonPostings,
  fetchOzonProductInfoLimit,
  fetchOzonProductPrices,
  fetchOzonProductStocks,
  fetchOzonWarehouses
} from "../src/ozonClient.js";

const REAL_SHOP = {
  id: 1,
  name: "Real Shop",
  ozon_client_id: "4174207",
  ozon_api_key: "real-api-key",
  api_key_hint: ""
};

test("fetchOzonWarehouses tries v2 before legacy v1", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
    return jsonResponse({
      result: [{
        warehouse_id: 1001,
        name: "Main warehouse",
        status: "active",
        delivery_schema: "fbs"
      }]
    });
  };

  const rows = await fetchOzonWarehouses(REAL_SHOP);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v2/warehouse/list"));
  assert.deepEqual(rows.map((item) => item.warehouse_id), ["1001"]);
});

test("fetchOzonPostings follows has_next when Ozon returns a short page", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push(body);
    const page = calls.length;
    return jsonResponse({
      result: {
        postings: [{ posting_number: `POST-${page}`, products: [] }],
        has_next: page === 1
      }
    });
  };

  const result = await fetchOzonPostings(REAL_SHOP, {
    from: "2026-07-24",
    to: "2026-07-25",
    limit: 1000
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((body) => body.offset), [0, 1000]);
  assert.deepEqual(result.postings.map((row) => row.posting_number), ["POST-1", "POST-2"]);
});

test("fetchOzonProductPrices reads product price v5 rows", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
    return jsonResponse({
      result: {
        items: [{
          product_id: 123,
          offer_id: "OFFER-1",
          sku: 987,
          price: { price: "150.50", currency_code: "RUB" },
          marketing_price: "140",
          old_price: "170",
          commissions: [{ sales_percent: 12 }]
        }],
        cursor: ""
      }
    });
  };

  const rows = await fetchOzonProductPrices(REAL_SHOP, { offerIds: ["OFFER-1"], limit: 1 });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v5/product/info/prices"));
  assert.deepEqual(calls[0].body.filter.offer_id, ["OFFER-1"]);
  assert.equal(rows[0].price, 150.5);
  assert.equal(rows[0].currency_code, "RUB");
});

test("fetchOzonProductStocks chunks product_id filters at Ozon limit", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ url: String(url), body });
    const firstProductId = body.filter.product_id[0];
    return jsonResponse({
      result: {
        items: [{
          product_id: firstProductId,
          offer_id: `offer-${firstProductId}`,
          sku: firstProductId + 10000,
          stocks: [{ sku: firstProductId + 10000, source: "fbs", present: 1, reserved: 0 }]
        }],
        cursor: ""
      }
    });
  };

  const rows = await fetchOzonProductStocks(REAL_SHOP, {
    productIds: Array.from({ length: 1001 }, (_, index) => index + 1)
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.endsWith("/v4/product/info/stocks")));
  assert.deepEqual(calls.map((call) => call.body.filter.product_id.length), [1000, 1]);
  assert.ok(calls.every((call) => call.body.filter.product_id.length <= 1000));
  assert.equal(rows.length, 2);
});

test("fetchOzonProductStocks retries Ozon rate limits", async (t) => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "content-type": "application/json", "retry-after": "0" }),
        text: async () => JSON.stringify({ message: "request rate limit" })
      };
    }
    return jsonResponse({
      result: {
        items: [{ product_id: 1, offer_id: "offer-1", sku: 10001, stocks: [] }],
        cursor: ""
      }
    });
  };

  const rows = await fetchOzonProductStocks(REAL_SHOP);

  assert.equal(calls, 2);
  assert.equal(rows.length, 1);
});

test("fetchOzonCashFlowStatement probes the new finance endpoint without mutating sync storage", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
    return jsonResponse({
      result: {
        items: [{
          operation_id: "cash-1",
          operation_type: "orders",
          operation_date: "2026-06-20T10:00:00Z",
          amount: "-12.3",
          posting: { posting_number: "P-1", order_number: "O-1" },
          currency_code: "RUB"
        }],
        page_count: 1
      }
    });
  };

  const result = await fetchOzonCashFlowStatement(REAL_SHOP, {
    from: "2026-06-01",
    to: "2026-06-20",
    pageSize: 1
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v1/finance/cash-flow-statement/list"));
  assert.equal(calls[0].body.page_size, 1);
  assert.equal(result.fetched, 1);
  assert.equal(result.rows[0].posting_number, "P-1");
  assert.equal(result.rows[0].amount, -12.3);
});

test("fetchOzonProductInfoLimit reads product limit v4 before legacy fallback", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
    return jsonResponse({
      daily_create: { usage: 3, limit: 100, reset_at: "2026-06-24T00:00:00Z" },
      daily_update: { usage: 8, limit: 100 },
      total: { usage: 500, limit: 10000 },
      operation_limits: [{ operation: "import", usage: 1, limit: 10 }]
    });
  };

  const result = await fetchOzonProductInfoLimit(REAL_SHOP);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v4/product/info/limit"));
  assert.equal(result.daily_create.usage, 3);
  assert.equal(result.daily_update.limit, 100);
  assert.equal(result.operation_limits[0].operation, "import");
});

test("fetchOzonCategoryAttributeValues follows last_value_id when Ozon clamps pages to 500", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ url: String(url), body });
    const page = calls.length;
    return jsonResponse({
      result: {
        items: Array.from({ length: 500 }, (_, index) => ({
          id: (page - 1) * 500 + index + 1,
          value: `value-${(page - 1) * 500 + index + 1}`
        })),
        last_value_id: page < 3 ? page * 500 : 0
      }
    });
  };

  const rows = await fetchOzonCategoryAttributeValues(REAL_SHOP, {
    descriptionCategoryId: 100,
    typeId: 200,
    attributeId: 300,
    limit: 1200,
    language: "ZH_HANS"
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.body.limit === 500));
  assert.deepEqual(calls.map((call) => call.body.last_value_id), [0, 500, 1000]);
  assert.equal(rows.length, 1200);
});

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(data)
  };
}

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadRelayPage({ cookie = "" } = {}) {
  const listeners = {};
  const postedMessages = [];
  let fetchCall = null;
  const storage = new Map();
  const window = {
    location: { href: "https://seller.ozon.ru/app/analytics?test=1" },
    localStorage: {
      getItem: (key) => storage.get(key) || "",
      setItem: (key, value) => storage.set(key, String(value))
    },
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    postMessage: (message) => {
      postedMessages.push(message);
    }
  };
  const context = {
    Headers,
    URL,
    window,
    document: { cookie },
    fetch: async (url, options) => {
      fetchCall = { url, options };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => "{\"success\":true}"
      };
    }
  };

  vm.runInNewContext(fs.readFileSync("pivot-table-master/content/erp-relay-page.js", "utf8"), context);

  return {
    dispatchExecute: async (request) => {
      listeners.message({
        source: window,
        data: {
          type: "PIVOT_ERP_ANALYTICS_EXECUTE_REQUEST",
          requestId: "request-1",
          request
        }
      });
      await new Promise((resolve) => setImmediate(resolve));
    },
    getFetchCall: () => fetchCall,
    getPostedMessages: () => postedMessages
  };
}

test("relay page adds x-o3-company-id from seller cookie when ERP headers omit it", async () => {
  const page = loadRelayPage({ cookie: "sc_company_id=123456; other=value" });

  await page.dispatchExecute({
    request_url: "https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/totals",
    request_method: "POST",
    request_headers: {
      "content-type": "application/json",
      "x-o3-language": "zh-Hans"
    },
    request_body: { metrics: ["revenue"] }
  });

  assert.equal(page.getFetchCall().options.headers["X-O3-Company-Id"], "123456");
  assert.equal(page.getPostedMessages()[0].payload.request_headers["X-O3-Company-Id"], "123456");
});

import assert from "node:assert/strict";
import test from "node:test";

import { fetchOzonPostings } from "../src/ozonClient.js";

const shop = (id) => ({ id, name: `Shop ${id}`, ozon_client_id: String(id), ozon_api_key: "test-api-key" });

test("a FBS list rate limit cools down concurrent requests across shops without rapid retries", async (t) => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "60" }),
      text: async () => JSON.stringify({ message: "You have reached request rate limit per second" })
    };
  };

  const options = { from: "2026-10-19T05:00:00Z", to: "2026-10-19T07:00:00Z" };
  const results = await Promise.allSettled([
    fetchOzonPostings(shop(1), options),
    fetchOzonPostings(shop(2), options)
  ]);

  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.match(results[0].reason.message, /rate limit per second/);
  assert.match(results[1].reason.message, /rate limited; retry after/);
});

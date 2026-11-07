import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAdvertisingBid, executeAdvertisingBid } from "../src/services/ozon-advertising-bid.js";

const body = { campaign_id: "123", ozon_sku: "456", mode: "bid", bid_rub: "1.2345", confirmKeywordReset: true };
test("bid conversion is exact, scoped to uint64 identifiers and explicit risk consent", () => {
  assert.deepEqual(normalizeAdvertisingBid(body).product, { sku: "456", bid: "1234500" });
  assert.equal(normalizeAdvertisingBid({ ...body, bid_rub: "0.0001" }).product.bid, "100");
  assert.equal(normalizeAdvertisingBid({ ...body, campaign_id: "18446744073709551615" }).campaignId, "18446744073709551615");
  for (const patch of [{ campaign_id: "../token" }, { ozon_sku: "18446744073709551616" }, { bid_rub: "Infinity" }, { bid_rub: "0" }, { bid_rub: "1.00001" }, { confirmKeywordReset: false }, { mode: "targetCir", target_cir: 9 }, { mode: "targetCir", target_cir: 101 }]) assert.throws(() => normalizeAdvertisingBid({ ...body, ...patch }));
});

function provider({ strategy = "TARGET_BIDS", after = { sku: "456", bid: "1234500" }, writeError = false } = {}) {
  const calls = [];
  let written = false;
  const request = async (path, payload, method) => {
    calls.push({ path, payload, method });
    if (path.startsWith("/api/client/campaign?")) return { list: [{ id: "123", productAutopilotStrategy: strategy }] };
    if (method === "PUT") { if (writeError) throw new Error("HTTP 405"); written = true; return {}; }
    return { products: [written ? after : { sku: "456", bid: "1000000" }] };
  };
  return { request, calls };
}
test("PUT writes bids at the documented path and read-back confirms the new micro-ruble amount", async () => {
  const p = provider();
  const result = await executeAdvertisingBid(normalizeAdvertisingBid(body), p.request);
  assert.equal(result.verified, true);
  const write = p.calls.find(c => c.method === "PUT");
  assert.equal(write.path, "/api/client/campaign/123/products");
  assert.deepEqual(write.payload, { bids: [{ sku: "456", bid: "1234500" }] });
  assert.equal(p.calls.filter(c => c.method === "PUT").length, 1);
});
test("wrong strategy fails before writing and a failed PUT never falls back to POST", async () => {
  const wrong = provider({ strategy: "MAX_CLICKS" });
  await assert.rejects(executeAdvertisingBid(normalizeAdvertisingBid(body), wrong.request), /策略/);
  assert.equal(wrong.calls.length, 1);
  const fail = provider({ writeError: true });
  await assert.rejects(executeAdvertisingBid(normalizeAdvertisingBid(body), fail.request), /405.*核对/);
  assert.equal(fail.calls.filter(c => c.method === "PUT").length, 1);
  assert.equal(fail.calls.some(c => c.method === "POST"), false);
});
test("unchanged read-back is pending rather than successful, including target CIR", async () => {
  const p = provider({ after: { sku: "456", bid: "1000000" } });
  assert.equal((await executeAdvertisingBid(normalizeAdvertisingBid(body), p.request)).pending_verification, true);
  const c = provider({ strategy: "TARGET_CIR", after: { sku: "456", targetCir: 15 } });
  const outcome = await executeAdvertisingBid(normalizeAdvertisingBid({ ...body, mode: "targetCir", target_cir: 15 }), c.request);
  assert.equal(outcome.ok, true);
  assert.deepEqual(c.calls.find(x => x.method === "PUT").payload, { bids: [{ sku: "456", targetCir: 15 }] });
});
test("product selection follows pages for both preflight and read-back", async () => {
  const setting = normalizeAdvertisingBid(body);
  const calls = [];
  let reads = 0;
  const request = async (path, payload, method) => {
    calls.push({ path, method });
    if (path.includes("campaignIds")) return { list: [{ id: "123", productAutopilotStrategy: "TARGET_BIDS" }] };
    if (method === "PUT") return {};
    reads++;
    return { products: path.includes("page=1&") ? Array.from({ length: 100 }, (_, i) => ({ sku: String(i + 1000) })) : [{ sku: "456", bid: "1234500" }] };
  };
  assert.equal((await executeAdvertisingBid(setting, request)).ok, true);
  assert.equal(reads, 4);
  assert.equal(calls.some(c => c.path.includes("page=2&")), true);
});

test("missing, malformed or repeated product pages cannot trigger a bid write", async () => {
  for (const response of [{ products: [] }, {}, { products: [{ sku: "999" }, { sku: "999" }] }]) {
    let writes = 0;
    const request = async (path, payload, method) => {
      if (method === "PUT") writes++;
      if (path.includes("campaignIds")) return { list: [{ id: "123", productAutopilotStrategy: "TARGET_BIDS" }] };
      return response;
    };
    await assert.rejects(executeAdvertisingBid(normalizeAdvertisingBid(body), request));
    assert.equal(writes, 0);
  }
});

test("read-back HTTP failure after an accepted write remains pending verification", async () => {
  const p = provider();
  let written = false;
  const result = await executeAdvertisingBid(normalizeAdvertisingBid(body), async (path, payload, method) => {
    if (written && method === "GET") throw new Error("HTTP 429");
    const response = await p.request(path, payload, method);
    if (method === "PUT") written = true;
    return response;
  });
  assert.equal(result.pending_verification, true);
  assert.match(result.message, /429/);
});

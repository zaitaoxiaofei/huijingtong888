import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/services/collector-seller-pool.js", import.meta.url), "utf8")
  .replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
const skus = ["1", "2", "3", "4", "5", "6", "7"];

function harness(companies, respond, beforeWrite = async () => {}) {
  const calls = [];
  const writes = [];
  const bindings = new Map(companies.map(company => [company, {
    company_id: company, cookie: "fixture-cookie", last_status: 200, last_ok_at: "2026-11-05T00:00:00Z"
  }]));
  const context = vm.createContext({
    AbortSignal,
    URL,
    setTimeout: callback => { callback(); return 1; },
    decryptSellerAuthSession: () => "",
    fetch: async (url, options) => {
      const call = { url, company: options.headers["X-O3-Company-Id"], body: JSON.parse(options.body) };
      calls.push(call);
      return respond(call);
    },
    mysqlQuery: async (sql, params) => {
      if (sql.includes("FROM shops")) {
        return companies.map((company, index) => ({
          shop_id: index + 1, shop_name: company, ozon_client_id: company, value: JSON.stringify(bindings.get(company))
        }));
      }
      const company = String(params[0]).replace("seller_analytics_auth_binding:", "");
      return [{ value: JSON.stringify(bindings.get(company)) }];
    },
    mysqlExecute: async (_sql, params) => {
      const binding = JSON.parse(params[0]);
      writes.push(binding);
      await beforeWrite(binding);
      bindings.set(binding.company_id, binding);
    }
  });
  vm.runInContext(source, context);
  return { calls, writes, run: () => context.collectSkusWithSellerPool(skus, "tenant-fixture") };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function successfulResponse(call) {
  if (call.url.includes("what_to_sell")) return json({ items: [{ sku: call.body.filter.sku, variantId: "fixture-variant" }] });
  if (call.url.endsWith("/search")) return json({ variants: [{ variant_id: "fixture-variant" }] });
  return json({ item: { name: "Fixture" } });
}

for (const status of [401, 403]) {
  test(`queued SKUs do not retry a rejected binding after its first HTTP ${status}`, async () => {
    let releaseWrite;
    const writePending = new Promise(resolve => { releaseWrite = resolve; });
    const pool = harness(["rejected"], () => json({ error: "rejected" }, status), () => writePending);
    const pending = pool.run();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pool.calls.length, 1);
    assert.equal(pool.writes.length, 1);
    releaseWrite();
    const result = await pending;
    assert.equal(result.fail_count, skus.length);
    assert.equal(pool.calls.length, 1);
    assert.equal(pool.writes.length, 1);
    assert.equal(pool.writes[0].last_status, status);
  });
}

for (const status of [403, 429]) {
  test(`HTTP ${status} disables only its shop and queued SKUs fail over to a healthy shop`, async () => {
    const pool = harness(["unavailable", "healthy"], call => call.company === "unavailable"
      ? json({ error: "unavailable" }, status)
      : successfulResponse(call));
    const result = await pool.run();
    assert.equal(result.success_count, skus.length);
    assert.equal(pool.calls.filter(call => call.company === "unavailable").length, 1);
    assert.ok(result.results.every(item => item.source_company_id === "healthy"));
    assert.equal(pool.writes.filter(binding => [401, 403].includes(binding.last_status)).length, status === 403 ? 1 : 0);
  });
}

test("a non-authorization SKU error does not disable a healthy shop", async () => {
  const pool = harness(["healthy"], call => call.url.includes("what_to_sell") && call.body.filter.sku === "1"
    ? json({ error: "temporary SKU failure" }, 500)
    : successfulResponse(call));
  const result = await pool.run();
  assert.equal(result.success_count, skus.length);
  assert.equal(pool.calls.filter(call => call.url.includes("what_to_sell")).length, skus.length);
  assert.ok(result.results.find(item => item.sku === "1").warnings.some(warning => warning.includes("HTTP 500")));
  assert.equal(pool.writes.filter(binding => [401, 403].includes(binding.last_status)).length, 0);
});

test("a rate limit in the final variant fallback disables that worker before the queue resumes", async () => {
  const pool = harness(["limited", "healthy"], call => {
    if (call.company === "healthy") return successfulResponse(call);
    if (call.url.includes("what_to_sell")) return json({ items: [] });
    if (call.url.endsWith("/search")) return json({ variants: [] });
    return json({ error: "rate limited" }, 429);
  });
  const result = await pool.run();
  assert.equal(result.success_count, skus.length);
  assert.equal(pool.calls.filter(call => call.company === "limited").length, 3);
  assert.ok(result.results.every(item => item.source_company_id === "healthy"));
  assert.equal(pool.writes.filter(binding => [401, 403].includes(binding.last_status)).length, 0);
});

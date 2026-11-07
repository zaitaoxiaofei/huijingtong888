import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const analyticsSource = readFileSync(new URL("../src/services/seller-analytics.js", import.meta.url), "utf8");
const poolSource = readFileSync(new URL("../src/services/collector-seller-pool.js", import.meta.url), "utf8");
const endpoint = "https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3";

function probeHarness(respond) {
  const calls = [];
  const budgets = [];
  const controller = new AbortController();
  const signal = controller.signal;
  const context = vm.createContext({
    URL,
    safeString: value => String(value ?? "").trim(),
    stringifyJson: JSON.stringify,
    AbortSignal: { timeout: ms => { budgets.push(ms); return signal; } },
    fetch: async (url, options) => {
      calls.push({ url, ...options, headers: { ...options.headers } });
      return respond(calls.length - 1, url, options);
    }
  });
  const probe = analyticsSource.slice(analyticsSource.indexOf("async function probeCollectorPoolAuth("), analyticsSource.indexOf("async function getAuthBinding("));
  const helpers = analyticsSource.slice(analyticsSource.indexOf("function normalizeProbeHeaders("), analyticsSource.indexOf("async function probeSellerAnalyticsAuth("));
  vm.runInContext(`${helpers}\n${probe}`, context);
  return {
    calls,
    budgets,
    signal,
    abort: reason => controller.abort(reason),
    run: () => context.probeCollectorPoolAuth({ company_id: "test-company", cookie: "session=fixture" })
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("collector auth probe carries redirect cookies and keeps one four-second budget", async () => {
  const harness = probeHarness(index => index === 0
    ? new Response(null, { status: 307, headers: { location: "?__rr=1", "set-cookie": "challenge=passed; Path=/; Secure" } })
    : jsonResponse({ items: [] }));
  const result = await harness.run();
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].url, `${endpoint}?__rr=1`);
  assert.match(harness.calls[1].headers.Cookie, /session=fixture/);
  assert.match(harness.calls[1].headers.Cookie, /challenge=passed/);
  assert.equal(harness.calls[0].redirect, "manual");
  assert.equal(harness.calls[1].method, "POST");
  assert.equal(harness.calls[1].body, harness.calls[0].body);
  assert.deepEqual(harness.budgets, [4000]);
  assert.ok(harness.calls.every(call => call.signal === harness.signal));
});

test("collector auth probe reports the real rejection after an Ozon redirect", async () => {
  const harness = probeHarness(index => index === 0
    ? new Response(null, { status: 307, headers: { location: "?__rr=1", "set-cookie": "challenge=passed" } })
    : jsonResponse({ error: "forbidden" }, 403));
  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(harness.calls.length, 2);
});

for (const [name, location] of [
  ["cross-domain", "https://id.ozon.ru/login"],
  ["insecure", "http://seller.ozon.ru/api/check"],
  ["login", "/app/registration/login"],
  ["loop", endpoint]
]) {
  test(`collector auth probe stops a ${name} redirect without sending another request`, async () => {
    const harness = probeHarness(() => new Response(null, { status: 307, headers: { location } }));
    const result = await harness.run();
    assert.equal(result.ok, false);
    assert.equal(harness.calls.length, 1);
    assert.ok(result.error);
  });
}

test("collector auth probe bounds changing redirect chains", async () => {
  const harness = probeHarness(index => new Response(null, { status: 307, headers: { location: `?__rr=${index + 1}` } }));
  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(harness.calls.length, 4);
  assert.deepEqual(harness.budgets, [4000]);
});

for (const [name, response] of [
  ["HTML login page", () => new Response("<html>Login</html>", { headers: { "content-type": "text/html" } })],
  ["invalid JSON", () => new Response("not JSON", { headers: { "content-type": "application/json" } })],
  ["empty JSON", () => jsonResponse(null)],
  ["empty object", () => jsonResponse({})],
  ["error object", () => jsonResponse({ error: "forbidden" })],
  ["error code", () => jsonResponse({ code: 403 })]
]) {
  test(`collector auth probe does not accept a successful HTTP ${name}`, async () => {
    const result = await probeHarness(response).run();
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
}

test("collector auth probe propagates the shared request deadline", async () => {
  const harness = probeHarness(() => { throw new DOMException("Request timed out", "TimeoutError"); });
  await assert.rejects(harness.run(), { name: "TimeoutError" });
  assert.deepEqual(harness.budgets, [4000]);
});

test("collector auth probe does not hide a deadline reached while reading JSON", async () => {
  const timeout = new DOMException("Request timed out", "TimeoutError");
  const harness = probeHarness(() => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => { harness.abort(timeout); throw timeout; }
  }));
  await assert.rejects(harness.run(), { name: "TimeoutError" });
});

test("pool status only counts verified bindings and supports encrypted and plaintext sessions", async () => {
  const checked = "2026-11-05T00:00:00Z";
  const bindings = [
    { company_id: "plain", cookie: "fixture", last_ok_at: checked, last_status: 200 },
    { company_id: "encrypted", cookie_encrypted: "encrypted-fixture", last_ok_at: checked, last_status: 200 },
    { company_id: "timeout", cookie: "fixture", updated_at: checked, last_status: 0, last_error: "timeout" },
    { company_id: "legacy-unverified", cookie: "fixture", bound_at: checked, last_status: 200 },
    { company_id: "rejected", cookie: "fixture", last_ok_at: checked, last_status: 403 }
  ];
  const context = vm.createContext({
    mysqlQuery: async (_sql, params) => {
      assert.equal(params[0], "tenant-fixture");
      return bindings.map((binding, index) => ({ shop_id: index + 1, shop_name: "Fixture", ozon_client_id: binding.company_id, value: JSON.stringify(binding) }));
    },
    mysqlExecute: async () => { throw new Error("Unexpected database write"); },
    decryptSellerAuthSession: value => value === "encrypted-fixture" ? "decrypted-fixture" : ""
  });
  vm.runInContext(poolSource.replace(/^import[^\n]+\n/gm, "").replaceAll("export ", ""), context);
  const status = await context.collectorSellerPoolStatus("tenant-fixture");
  assert.equal(status.enabled, true);
  assert.equal(status.available_workers, 2);
  assert.deepEqual(Array.from(status.workers, worker => worker.company_id), ["plain", "encrypted"]);
});

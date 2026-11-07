import assert from "node:assert/strict";
import test from "node:test";
import { CollectorBrowserPool } from "../src/services/collector-browser-pool.js";

function fixture(options = {}) {
  let now = Date.parse("2026-11-05T12:00:00Z");
  const pool = new CollectorBrowserPool({ clock: () => now, ...options });
  return {
    pool,
    advance(ms) { now += ms; },
    worker(company = "a", workerId = company, tenant = "tenant-a") {
      return pool.heartbeat(tenant, {
        worker_id: workerId, company_id: company, shop_id: company.charCodeAt(0), shop_name: `Shop ${company}`,
        page_company_id: company, cookie_company_id: company, observed_company_id: company
      });
    },
    claim(company = "a", worker = company, tenant = "tenant-a") {
      return pool.claim(tenant, { worker_id: worker, company_id: company }).task;
    },
    report(task, phase = "complete", fields = { monthlySales: 42 }, extra = {}, tenant = "tenant-a", worker = task.company_id) {
      return pool.report(tenant, { worker_id: worker, company_id: task.company_id,
        task_id: task.task_id, lease_token: task.lease_token, sku: task.sku, phase, fields, ...extra });
    }
  };
}

function code(expected) { return error => error.code === expected; }

test("two shops share rotation and company locks across batches", () => {
  const f = fixture(); f.worker("a"); f.worker("b");
  const first = f.pool.createBatch("tenant-a", ["1"]);
  const second = f.pool.createBatch("tenant-a", ["2"]);
  const a = f.claim("a"), b = f.claim("b");
  assert.equal(a.batch_id, first.batch_id);
  assert.equal(b.batch_id, second.batch_id);
  assert.equal(f.claim("a"), null);
  f.report(a); f.report(b);
  assert.equal(f.pool.batchStatus("tenant-a", first.batch_id).status, "complete");
  const third = f.pool.createBatch("tenant-a", ["3"]);
  assert.equal(f.claim("a").batch_id, third.batch_id);
});

test("same-company tabs do not add workers or parallel leases and tenant concurrency is at most six", () => {
  const f = fixture();
  for (const company of "abcdefg") f.worker(company);
  f.worker("a", "second-a");
  f.pool.createBatch("tenant-a", Array.from({ length: 20 }, (_, index) => String(index)));
  assert.equal(f.pool.status("tenant-a").available_workers, 7);
  assert.ok(f.claim("a"));
  assert.equal(f.claim("a", "second-a"), null);
  for (const company of "bcdef") assert.ok(f.claim(company));
  assert.equal(f.claim("g"), null);
  assert.doesNotMatch(JSON.stringify(f.pool.status("tenant-a")), /lease_token|cookie/);
});

test("partial sales are incremental, do not finish tasks and never populate complete cache", () => {
  const f = fixture(); f.worker();
  const batch = f.pool.createBatch("tenant-a", ["1"]), task = f.claim();
  const partial = f.report(task, "sales", { monthlySales: 4 });
  assert.equal(partial.completed_count, 0);
  assert.equal(partial.results[0].partial, true);
  assert.equal(f.pool.batchStatus("tenant-a", batch.batch_id, partial.revision).results.length, 0);
  const other = f.pool.createBatch("tenant-a", ["1"]);
  assert.equal(other.results.length, 0);
  const complete = f.report(task, "complete", { monthlySales: 5, brand: "Fixture" });
  assert.equal(complete.status, "complete");
  assert.equal(complete.completed_count, 1);
  assert.deepEqual(complete.results[0].product, { monthlySales: 5, brand: "Fixture" });
  assert.equal(complete.results[0].source_shop_name, "Shop a");
  assert.equal(complete.results[0].partial, false);
});

test("complete cache lasts five minutes, retains source and is isolated by tenant", () => {
  const f = fixture(); f.worker();
  f.pool.createBatch("tenant-a", ["1"]); const task = f.claim(); f.report(task);
  f.advance(61000);
  const cached = f.pool.createBatch("tenant-a", ["1"]);
  assert.equal(cached.status, "complete");
  assert.equal(cached.results[0].source_company_id, "a");
  assert.throws(() => f.pool.createBatch("tenant-b", ["1"]), code("COLLECTOR_BROWSER_POOL_UNAVAILABLE"));
  f.advance(240001);
  assert.throws(() => f.pool.createBatch("tenant-a", ["1"]), code("COLLECTOR_BROWSER_POOL_UNAVAILABLE"));
});

test("heartbeat requires real matching page and cookie identity", () => {
  const f = fixture();
  const metadata = { worker_id: "worker", company_id: "a", shop_id: 1, page_company_id: "a", cookie_company_id: "a" };
  assert.throws(() => f.pool.heartbeat("tenant-a", metadata), code("COLLECTOR_BROWSER_IDENTITY_MISMATCH"));
  assert.ok(f.pool.heartbeat("tenant-a", { ...metadata, identity_source: "page_cookie" }));
  assert.throws(() => f.pool.heartbeat("tenant-a", { ...metadata, observed_company_id: "b" }), code("COLLECTOR_BROWSER_IDENTITY_MISMATCH"));
  assert.throws(() => f.pool.heartbeat("tenant-a", { ...metadata, cookie_company_id: "b", identity_source: "page_cookie" }), code("COLLECTOR_BROWSER_IDENTITY_MISMATCH"));
});

test("results reject cross-tenant, wrong worker, wrong SKU, wrong shop and old leases", () => {
  const f = fixture({ leaseMs: 10 }); f.worker();
  const batch = f.pool.createBatch("tenant-a", ["1"]), old = f.claim();
  assert.throws(() => f.pool.batchStatus("tenant-b", batch.batch_id), code("COLLECTOR_BROWSER_BATCH_NOT_FOUND"));
  assert.throws(() => f.report(old, "complete", {}, {}, "tenant-b"), code("COLLECTOR_BROWSER_LEASE_INVALID"));
  for (const extra of [{ worker_id: "other" }, { sku: "2" }, { company_id: "b" }, { lease_token: "wrong" }]) {
    assert.throws(() => f.report(old, "complete", {}, extra), code("COLLECTOR_BROWSER_LEASE_INVALID"));
  }
  f.advance(11);
  const replacement = f.claim();
  assert.notEqual(replacement.lease_token, old.lease_token);
  assert.throws(() => f.report(old), code("COLLECTOR_BROWSER_LEASE_INVALID"));
  assert.equal(f.report(replacement).status, "complete");
});

for (const status of [401, 403, 429]) {
  test(`HTTP ${status} cools only the affected company and retries without merging old partial fields`, () => {
    const f = fixture(); f.worker("a"); f.worker("b");
    const batch = f.pool.createBatch("tenant-a", ["1"]), first = f.claim("a");
    f.report(first, "sales", { oldCompanyOnly: true });
    f.report(first, "failed", {}, { status, error: "Rejected" });
    assert.equal(f.pool.status("tenant-a").available_workers, 1);
    f.worker("a");
    assert.equal(f.claim("a"), null);
    assert.equal(f.pool.batchStatus("tenant-a", batch.batch_id).results.length, 0);
    const next = f.claim("b");
    const result = f.report(next, "complete", { monthlySales: 9 });
    assert.deepEqual(result.results[0].product, { monthlySales: 9 });
    assert.equal(result.results[0].source_company_id, "b");
  });
}

test("offline workers and expired leases reassign, and bounded attempts terminate a batch", () => {
  const f = fixture({ workerTtlMs: 20, leaseMs: 10, maxAttempts: 2 }); f.worker("a"); f.worker("b");
  const batch = f.pool.createBatch("tenant-a", ["1"]); const a = f.claim("a");
  f.advance(11); f.worker("b");
  const b = f.claim("b");
  assert.equal(b.sku, a.sku);
  assert.equal(f.report(b, "failed", {}, { status: 500 }).status, "failed");
  assert.equal(f.pool.batchStatus("tenant-a", batch.batch_id).failed_count, 1);
  assert.equal(f.pool.status("tenant-a").available_workers, 2);
});

test("an offline worker is reassigned before its longer lease expires", () => {
  const f = fixture({ workerTtlMs: 20, leaseMs: 100 }); f.worker("a"); f.worker("b");
  f.pool.createBatch("tenant-a", ["1"]); const old = f.claim("a");
  f.advance(21); f.worker("b");
  const next = f.claim("b");
  assert.equal(next.sku, old.sku);
  assert.throws(() => f.report(old), code("COLLECTOR_BROWSER_LEASE_INVALID"));
  assert.equal(f.report(next).status, "complete");
});

test("identical company IDs in different tenants have independent locks and result ownership", () => {
  const f = fixture(); f.worker("a"); f.worker("a", "a", "tenant-b");
  const first = f.pool.createBatch("tenant-a", ["1"]), second = f.pool.createBatch("tenant-b", ["1"]);
  const a = f.claim(), b = f.claim("a", "a", "tenant-b");
  assert.equal(a.batch_id, first.batch_id);
  assert.equal(b.batch_id, second.batch_id);
  f.report(a, "complete", { monthlySales: 1 });
  f.report(b, "complete", { monthlySales: 2 }, {}, "tenant-b");
  assert.equal(f.pool.batchStatus("tenant-a", first.batch_id).results[0].product.monthlySales, 1);
  assert.equal(f.pool.batchStatus("tenant-b", second.batch_id).results[0].product.monthlySales, 2);
});

test("expired batches explicitly fail unfinished SKUs while preserving completed results", () => {
  const f = fixture({ batchTtlMs: 10 }); f.worker();
  const batch = f.pool.createBatch("tenant-a", ["1", "2"]); f.report(f.claim());
  f.advance(11);
  const expired = f.pool.batchStatus("tenant-a", batch.batch_id);
  assert.equal(expired.status, "failed");
  assert.equal(expired.completed_count, 1);
  assert.equal(expired.failed_count, 1);
  assert.match(expired.results.find(result => !result.success).error, /expired/);
});

test("worker, batch, result and total memory limits are bounded", () => {
  const f = fixture({ maxWorkers: 1, maxBatches: 1, maxResultItemBytes: 1400, maxResultBytes: 4000 }); f.worker();
  assert.throws(() => f.worker("b"), code("COLLECTOR_BROWSER_CAPACITY"));
  const batch = f.pool.createBatch("tenant-a", ["1"]), task = f.claim();
  assert.throws(() => f.pool.createBatch("tenant-a", ["2"]), code("COLLECTOR_BROWSER_CAPACITY"));
  assert.throws(() => f.report(task, "sales", { huge: "x".repeat(2000) }), code("COLLECTOR_BROWSER_RESULT_TOO_LARGE"));
  assert.throws(() => f.report(task, "complete", { nested: { cookie: "must-not-store" } }), code("COLLECTOR_BROWSER_INPUT_INVALID"));
  f.report(task);
  assert.equal(f.pool.createBatch("tenant-a", ["2"]).status, "pending");
  assert.throws(() => f.pool.batchStatus("tenant-a", batch.batch_id), code("COLLECTOR_BROWSER_BATCH_NOT_FOUND"));
  const small = fixture({ maxResultBytes: 1500 }); small.worker();
  assert.throws(() => small.pool.createBatch("tenant-a", ["1", "2"]), code("COLLECTOR_BROWSER_CAPACITY"));
  assert.equal(small.pool.batches.size, 0);
});

test("large partials cannot consume the memory reserved for explicit terminal failure", () => {
  const f = fixture({ maxResultBytes: 2100, maxResultItemBytes: 1800, batchTtlMs: 100 }); f.worker();
  const batch = f.pool.createBatch("tenant-a", ["1"]), task = f.claim();
  f.report(task, "sales", { description: "x".repeat(500) });
  assert.throws(() => f.report(task, "sales", { description: "x".repeat(1200) }), code("COLLECTOR_BROWSER_CAPACITY"));
  f.advance(101);
  assert.equal(f.pool.batchStatus("tenant-a", batch.batch_id).status, "failed");
  assert.equal(f.pool.reservedBytes, 0);
  assert.ok(f.pool.resultBytes <= f.pool.maxResultBytes);
});

test("caller mutation cannot modify cached or previously reported fields", () => {
  const f = fixture(); f.worker();
  const batch = f.pool.createBatch("tenant-a", ["1"]), task = f.claim();
  const fields = { monthlySales: 42 };
  const result = f.report(task, "complete", fields);
  fields.monthlySales = 0;
  result.results[0].product.monthlySales = 0;
  assert.equal(f.pool.batchStatus("tenant-a", batch.batch_id).results[0].product.monthlySales, 42);
  assert.equal(f.pool.createBatch("tenant-a", ["1"]).results[0].product.monthlySales, 42);
});

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CollectorBrowserPool } from "../src/services/collector-browser-pool.js";
import { createCollectorBrowserPoolHandler } from "../src/server/collector-browser-pool-route.js";
import { isTenantScopedPluginRoute, tenantPluginApiError } from "../src/server/local-plugin-tenant.js";

const prefix = ["api", "local-plugin", "collector-browser-pool"];
const sendJson = (_req, res, payload, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
};

test("browser pool opens only its implemented enterprise plugin routes", () => {
  for (const [method, suffix] of [
    ["GET", ["status"]], ["POST", ["heartbeat"]], ["POST", ["batches"]],
    ["GET", ["batches", "batch-fixture"]], ["POST", ["claim"]], ["POST", ["results"]]
  ]) assert.equal(isTenantScopedPluginRoute(method, [...prefix, ...suffix]), true);
  for (const [method, suffix] of [
    ["DELETE", ["batches", "batch-fixture"]], ["POST", ["batches", "batch-fixture"]],
    ["GET", ["claim"]], ["POST", ["heartbeat", "extra"]], ["GET", ["batches", "../secret"]]
  ]) assert.equal(isTenantScopedPluginRoute(method, [...prefix, ...suffix]), false);
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const route = server.slice(server.indexOf("async function handleLocalPluginRoute"), server.indexOf('if (parts[2] === "plugin"', server.indexOf("async function handleLocalPluginRoute")));
  assert.ok(route.indexOf("resolveLocalPluginPrincipal(req)") < route.indexOf("handleCollectorBrowserPoolRoute(req"));
  assert.ok(route.indexOf("tenantPluginApiError(") < route.indexOf("handleCollectorBrowserPoolRoute(req"));
});

test("real HTTP broker on local 8788 dispatches two shops and isolates partial, final and tenant results", async (t) => {
  const pool = new CollectorBrowserPool();
  const accesses = [];
  const handler = createCollectorBrowserPoolHandler({
    pool, sendJson,
    resolveShop: async (company, tenant) => {
      accesses.push([company, tenant]);
      if (tenant !== "tenant-a" || !["1001", "1002"].includes(company)) {
        throw Object.assign(new Error("Shop does not belong to this enterprise"), { status: 403, code: "COLLECTOR_BROWSER_SHOP_FORBIDDEN" });
      }
      return { company_id: company, shop_id: Number(company), shop_name: `Fixture ${company}` };
    }
  });
  const server = http.createServer(async (req, res) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const principal = token === "fixture-a" ? { tenantKey: "tenant-a", tenantId: 41, tenantSlug: "fixture-a" }
      : token === "fixture-b" ? { tenantKey: "tenant-b", tenantId: 42, tenantSlug: "fixture-b" } : null;
    const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean);
    const denied = tenantPluginApiError(principal, req.method, parts);
    if (denied) return sendJson(req, res, { success: false, code: denied.code }, denied.status);
    try {
      if (!await handler(req, res, parts, principal)) sendJson(req, res, { success: false }, 404);
    } catch {
      sendJson(req, res, { success: false }, 500);
    }
  });
  server.listen(8788, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (path, body, token = "fixture-a", method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`http://127.0.0.1:8788/api/local-plugin/collector-browser-pool/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cache: response.headers.get("cache-control") };
  };
  const missingAuth = await call("status", undefined, "invalid");
  assert.equal(missingAuth.status, 403);
  const noWorkers = await call("batches", { skus: ["9001"] });
  assert.equal(noWorkers.status, 409);
  for (const company of ["1001", "1002"]) {
    const reply = await call("heartbeat", {
      worker_id: `fixture-worker-${company}`, company_id: company,
      page_company_id: company, cookie_company_id: company,
      observed_company_id: "", identity_source: "page_cookie", plugin_version: "1.4.39",
      shop_id: 999999, shop_name: "Untrusted name", tenant_id: "tenant-b"
    });
    assert.equal(reply.status, 200);
  }
  assert.equal((await call("status")).data.available_workers, 2);
  const created = await call("batches", { skus: ["9001", "9002"], tenant_id: "tenant-b" });
  assert.equal(created.status, 200);
  const batchId = created.data.batch_id;
  assert.ok(batchId);
  const tasks = [];
  for (const company of ["1001", "1002"]) {
    const claim = await call("claim", { worker_id: `fixture-worker-${company}`, company_id: company });
    assert.equal(claim.status, 200);
    assert.ok(claim.data.task);
    assert.equal(claim.data.task.company_id, company);
    assert.equal(claim.data.task.shop_id, Number(company));
    tasks.push({ ...claim.data.task, worker_id: `fixture-worker-${company}` });
  }
  assert.equal(new Set(tasks.map(task => task.sku)).size, 2);
  const first = tasks[0];
  const sales = await call("results", { ...first, phase: "sales", fields: { soldCount: 12, soldSum: 1200 }, warnings: [] });
  assert.equal(sales.status, 200);
  assert.equal(sales.data.accepted, true);
  assert.equal(sales.data.task_id, first.task_id);
  assert.equal(sales.data.results, undefined);
  const partial = await call(`batches/${batchId}?after=0`);
  assert.equal(partial.cache, "no-store");
  assert.ok(partial.data.results.some(row => row.sku === first.sku && row.partial === true && row.product.soldCount === 12));
  assert.equal(partial.data.completed_count, 0);
  assert.notEqual((await call(`batches/${batchId}`, undefined, "fixture-b")).status, 200);
  assert.notEqual((await call("results", { ...first, phase: "complete", fields: {} }, "fixture-b")).status, 200);
  assert.equal((await call("results", { ...first, lease_token: "wrong-token", phase: "complete", fields: {} })).status, 409);
  for (const task of tasks) {
    assert.equal((await call("results", { ...task, phase: "complete", fields: { soldCount: 12, soldSum: 1200, category: "Fixture" }, warnings: [] })).status, 200);
  }
  const complete = (await call(`batches/${batchId}?after=0`)).data;
  assert.equal(complete.status, "complete");
  assert.equal(complete.completed_count, 2);
  assert.ok(complete.results.every(row => row.success && !row.partial && row.source_shop_id !== 999999));
  const cached = (await call("batches", { skus: ["9001"] })).data;
  assert.equal(cached.status, "complete");
  assert.equal(cached.results[0].product.soldCount, 12);
  assert.ok(accesses.every(([, tenant]) => tenant === "tenant-a" || tenant === "tenant-b"));
  assert.equal((await call("heartbeat", { company_id: "not-owned" })).status, 403);
  assert.equal((await call(`batches/${batchId}?after=-1`)).status, 400);
});

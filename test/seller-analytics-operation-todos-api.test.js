import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSellerAnalyticsRoutes, handleSellerAnalyticsRestRoute } from "../src/server/routes/sellerAnalytics.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readRepoFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

test("seller analytics exposes operation todo routes and frontend API helpers", () => {
  const routes = readRepoFile("src/server/routes/sellerAnalytics.js");
  const api = readRepoFile("frontend/admin/api/sellerAnalytics.js");

  assert.match(routes, /GET \/api\/db\/seller-analytics\/operation-todos/);
  assert.match(routes, /POST \/api\/db\/seller-analytics\/operation-todos\/refresh/);
  assert.match(routes, /GET \/api\/db\/seller-analytics\/plugin-status/);
  assert.match(routes, /GET \/api\/db\/seller-analytics\/plugin-status\/validate/);
  assert.match(routes, /sellerAnalyticsOperationTodos/);
  assert.match(routes, /sellerAnalyticsRefreshOperationTodos/);
  assert.match(routes, /sellerAnalyticsPluginStatus/);
  assert.match(routes, /sellerAnalyticsValidatePluginStatus/);
  assert.match(api, /function getSellerAnalyticsOperationTodos/);
  assert.match(api, /function refreshSellerAnalyticsOperationTodos/);
  assert.match(api, /function getSellerAnalyticsPluginStatus/);
  assert.match(api, /function validateSellerAnalyticsPluginStatus/);
});

test("seller analytics route binds tenant scope to the session and ignores client tenant selectors", async () => {
  const calls = [];
  const services = new Proxy({}, {
    get: (_target, method) => (...args) => {
      calls.push({ method, args });
      return { ok: true };
    }
  });
  const routes = createSellerAnalyticsRoutes({
    services,
    readJson: async () => ({ tenant_id: "other-tenant", tenantId: "also-other", store_id: "store-a" })
  });
  const req = {
    headers: { "x-tenant-id": "other-tenant" },
    query: { tenant_id: "other-tenant" },
    _session: { tenant: { id: 42, slug: "company-a" } }
  };
  const url = new URL("http://localhost/api/db/seller-analytics/analysis?tenant_id=other-tenant&tenantId=also-other&store_id=store-a");

  await routes["GET /api/db/seller-analytics/analysis"](req, url);
  await routes["POST /api/db/seller-analytics/collect-runs"](req);

  assert.deepEqual(calls, [
    { method: "sellerAnalyticsAnalysis", args: [{ store_id: "store-a" }, "42"] },
    { method: "sellerAnalyticsCreateCollectRun", args: [{ store_id: "store-a" }, "42"] }
  ]);
});

test("seller analytics route maps the default tenant to its legacy storage key and rejects missing context", async () => {
  const calls = [];
  const routes = createSellerAnalyticsRoutes({
    services: { sellerAnalyticsSummary: async (...args) => calls.push(args) },
    readJson: async () => ({})
  });
  await routes["GET /api/db/seller-analytics/summary"]({ _session: { tenant: { id: 1, slug: "default" } } });
  assert.deepEqual(calls, [["admin"]]);
  assert.throws(
    () => routes["GET /api/db/seller-analytics/summary"]({ headers: { "x-tenant-id": "admin" } }),
    (error) => error.statusCode === 403
  );
});

test("seller analytics tenant gate allows only registered methods and paths", () => {
  const routes = createSellerAnalyticsRoutes({ services: {}, readJson: async () => ({}) });
  const tenantSession = { tenant: { id: 42, slug: "company-a" } };
  for (const route of Object.keys(routes)) {
    const [method, routePath] = route.split(" ");
    const parts = new URL(routePath, "http://localhost").pathname.split("/").filter(Boolean);
    assert.equal(tenantIsolationDecision(tenantSession, parts, method).allowed, true, `${method} ${routePath}`);
  }
  assert.equal(tenantIsolationDecision(tenantSession, ["api", "db", "seller-analytics", "analysis", "internal-debug"], "GET").allowed, false);
  assert.equal(tenantIsolationDecision(tenantSession, ["api", "db", "seller-analytics", "plugin-status"], "PUT").allowed, false);
  assert.equal(tenantIsolationDecision(tenantSession, ["api", "db", "seller-analytics", "collect-runs", "run-a", "retry"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(tenantSession, ["api", "db", "seller-analytics", "snapshots", "snapshot-a"], "DELETE").allowed, true);
});

test("seller analytics REST mutations use the session tenant rather than client headers", async () => {
  const calls = [];
  const services = {
    sellerAnalyticsRetryCollectRun: async (...args) => calls.push(["retry", ...args]),
    sellerAnalyticsDeleteCollectRun: async (...args) => calls.push(["delete-run", ...args]),
    sellerAnalyticsDeleteSnapshot: async (...args) => calls.push(["delete-snapshot", ...args])
  };
  const req = { method: "DELETE", headers: { "x-tenant-id": "99" }, _session: { tenant: { id: 42, slug: "company-a" } } };
  const res = {};
  const json = (_res, payload) => payload;

  await handleSellerAnalyticsRestRoute({ req, res, parts: ["api", "db", "seller-analytics", "collect-runs", "run-a"], services, json });
  req.method = "POST";
  await handleSellerAnalyticsRestRoute({ req, res, parts: ["api", "db", "seller-analytics", "collect-runs", "run-a", "retry"], services, json });
  req.method = "DELETE";
  await handleSellerAnalyticsRestRoute({ req, res, parts: ["api", "db", "seller-analytics", "snapshots", "snapshot-a"], services, json });

  assert.deepEqual(calls, [
    ["delete-run", "run-a", "42"],
    ["retry", "run-a", "42"],
    ["delete-snapshot", "snapshot-a", "42"]
  ]);
});

test("tenant analytics skips enrichment from the still-shared online products table", () => {
  const service = readRepoFile("src/services/seller-analytics.js");
  assert.match(service, /if \(tenantId === 'admin' && enrichmentTargets\.length > 0\)/);
  assert.match(service, /online_products is still shared legacy data without tenant_id/);
  assert.match(service, /KEY idx_seller_snapshots_tenant_captured \(tenant_id, captured_at\)/);
  assert.match(service, /KEY idx_seller_metrics_tenant_captured \(tenant_id, captured_at\)/);
  assert.match(service, /KEY idx_seller_todos_tenant_status_date \(tenant_id, status, biz_date, priority\)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOperationsRoutes, handleOperationsRestRoute } from "../src/server/routes/operations.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("tenant procurement request routes take tenant scope only from the authenticated session", async () => {
  const calls = [];
  const services = {
    procurementRequests: async (...args) => { calls.push(["list", ...args]); return { rows: [], total: 0 }; },
    createProcurementRequest: async (...args) => { calls.push(["create", ...args]); return { id: 1 }; },
    updateProcurementRequest: async (...args) => { calls.push(["update", ...args]); },
    deleteProcurementRequest: async (...args) => { calls.push(["delete", ...args]); return { ok: true }; }
  };
  const body = { raw_name: "申请商品", tenant_id: 999, tenantId: 998 };
  const routes = createOperationsRoutes({ services, readJson: async () => body });
  const req = { _session: { personId: 7, tenant: { id: 42, slug: "company-a" } }, headers: { "x-tenant-id": "99" } };
  const url = new URL("https://example.test/api/procurement/requests?tenant_id=999&query=abc");
  await routes["GET /api/procurement/requests"](req, url);
  await routes["POST /api/procurement/requests"](req);
  const json = (_res, data) => data;
  await handleOperationsRestRoute({ req: { ...req, method: "PUT" }, res: {}, parts: ["api", "procurement", "requests", "12"], services, readJson: async () => body, json });
  await handleOperationsRestRoute({ req: { ...req, method: "DELETE" }, res: {}, parts: ["api", "procurement", "requests", "12"], services, readJson: async () => ({}), json });
  assert.deepEqual(calls, [
    ["list", { tenant_id: "999", query: "abc" }, "42"],
    ["create", body, 7, "42"],
    ["update", 12, body, "42"],
    ["delete", 12, "42"]
  ]);
});

test("tenant procurement gate allows only list/create and numeric record edit/delete", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "procurement", "requests"]],
    ["POST", ["api", "procurement", "requests"]],
    ["PUT", ["api", "procurement", "requests", "12"]],
    ["DELETE", ["api", "procurement", "requests", "12"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "procurement", "requests", "12"]],
    ["POST", ["api", "procurement", "requests", "submit"]],
    ["POST", ["api", "procurement", "requests", "12"]],
    ["DELETE", ["api", "procurement", "requests", "12", "hard"]],
    ["GET", ["api", "procurement", "ledger"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("tenant procurement service fails closed and keeps requests free of shared business joins", () => {
  const service = read("../src/services/mysql-cutover.js");
  const tenantList = service.slice(service.indexOf("async function tenantProcurementRequestsMysql"), service.indexOf("async function createTenantProcurementRequestMysql"));
  const tenantCreate = service.slice(service.indexOf("async function createTenantProcurementRequestMysql"), service.indexOf("async function updateTenantProcurementRequestMysql"));
  const tenantUpdate = service.slice(service.indexOf("async function updateTenantProcurementRequestMysql"), service.indexOf("async function deleteTenantProcurementRequestMysql"));
  const tenantDelete = service.slice(service.indexOf("async function deleteTenantProcurementRequestMysql"), service.indexOf("export async function procurementRequestsMysql"));
  assert.match(service, /mysqlSchemaColumnExists\("procurement_requests", "tenant_id"\)/);
  assert.match(service, /mysqlSchemaIndexExists\("procurement_requests", "idx_procurement_tenant_status_created"\)/);
  assert.match(tenantList, /pr\.tenant_id = \?/);
  assert.match(tenantList, /pr\.purchase_order_id IS NULL/);
  assert.match(tenantList, /pr\.product_id IS NULL/);
  assert.match(tenantList, /pr\.supplier_id IS NULL/);
  assert.doesNotMatch(tenantList, /JOIN\s+(?:products|people|suppliers|purchase_orders|orders)\b/i);
  assert.match(tenantCreate, /tenant_members WHERE tenant_id = \? AND person_id = \? AND active = 1/);
  assert.match(tenantCreate, /\[item, body\]\.some/);
  assert.match(tenantCreate, /\(tenant_id, request_group_no, product_id/);
  assert.match(tenantUpdate, /WHERE id = \? AND tenant_id = \?/);
  assert.match(tenantUpdate, /AND purchase_order_id IS NULL AND product_id IS NULL/);
  assert.match(tenantDelete, /WHERE id = \? AND tenant_id = \?/);
  assert.match(tenantDelete, /AND source_order_id IS NULL AND source_order_item_id IS NULL AND supplier_id IS NULL/);
});

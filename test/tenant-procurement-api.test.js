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

test("tenant procurement gate admits reviewed daily routes and rejects unreviewed or malformed actions", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "procurement", "requests"]],
    ["POST", ["api", "procurement", "requests"]],
    ["PUT", ["api", "procurement", "requests", "12"]],
    ["DELETE", ["api", "procurement", "requests", "12"]],
    ["GET", ["api", "procurement", "requests", "12"]],
    ["POST", ["api", "procurement", "requests", "direct-inbound"]],
    ["POST", ["api", "procurement", "purchases"]],
    ["POST", ["api", "procurement", "warehouse-requests"]],
    ["GET", ["api", "procurement", "summary"]],
    ["GET", ["api", "procurement", "ledger"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
  for (const [method, parts] of [
    ["POST", ["api", "procurement", "requests", "submit"]],
    ["POST", ["api", "procurement", "requests", "12"]],
    ["DELETE", ["api", "procurement", "requests", "12", "hard"]],
    ["PUT", ["api", "procurement", "requests", "all"]],
    ["POST", ["api", "procurement", "requests", "batch-delete"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("tenant procurement service validates every referenced domain before scoped reads and transactional writes", () => {
  const service = read("../src/services/mysql-cutover.js");
  const section = name => service.match(new RegExp(`export async function ${name}\\([\\s\\S]*?(?=\\n(?:export )?(?:async )?function )`))?.[0] || "";
  const tenantList = section("procurementRequestsMysql");
  const tenantCreate = section("createProcurementRequestMysql");
  const tenantUpdate = section("updateProcurementRequestMysql");
  const tenantDelete = section("deleteProcurementRequestMysql");
  assert.match(service, /mysqlSchemaColumnExists\("procurement_requests", "tenant_id"\)/);
  assert.match(service, /mysqlSchemaIndexExists\("procurement_requests", "idx_procurement_tenant_status_created"\)/);
  assert.match(tenantList, /resolveInventoryTenantScope\(tenantId\)/);
  assert.match(tenantList, /requireProcurementTenantSchemaMysql\(\)/);
  for (const alias of ["pr","p","s","po"]) assert.match(tenantList, new RegExp(`inventoryTenantSql\\(scope, '${alias}'\\)`));
  assert.match(tenantList, /pr\.product_id IS NULL OR p\.id IS NOT NULL/);
  assert.match(tenantList, /pr\.supplier_id IS NULL OR s\.id IS NOT NULL/);
  assert.match(tenantList, /pr\.purchase_order_id IS NULL OR po\.id IS NOT NULL/);
  assert.match(tenantList, /pr\.source_order_id IS NULL OR source_shop\.id IS NOT NULL/);
  assert.match(tenantCreate, /assertInventoryMember\(scope, personId, run\)/);
  assert.match(tenantCreate, /assertInventoryReferences\(scope, body, run\)/);
  assert.match(tenantCreate, /SELECT id FROM products WHERE id = \? AND \$\{scope\.predicate\(\)\.sql\} FOR UPDATE/);
  assert.match(tenantCreate, /\(tenant_id, request_group_no, product_id/);
  assert.match(tenantUpdate, /assertInventoryRecord\(scope, 'request', requestId, run, \{ lock: true \}\)/);
  assert.match(tenantUpdate, /assertInventoryReferences\(scope, body, run\)/);
  assert.match(tenantUpdate, /scope\.predicate\('request'\)\.sql/);
  assert.match(tenantUpdate, /scope\.predicate\('product'\)\.sql/);
  assert.match(tenantDelete, /withMysqlTransaction/);
  assert.match(tenantDelete, /assertInventoryRecord\(scope, 'request', requestId,[\s\S]*?\{ lock: true \}\)/);
  assert.ok(tenantDelete.indexOf("assertInventoryRecord") < tenantDelete.indexOf("DELETE FROM procurement_requests"));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("supplier table has nullable ownership and a tenant-first index", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const table = schema.match(/CREATE TABLE IF NOT EXISTS suppliers \(([\s\S]*?)\) ENGINE=InnoDB/);
  assert.ok(table, "suppliers schema exists");
  assert.match(table[1], /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(table[1], /idx_suppliers_tenant_status_id \(tenant_id, status, id\)/);
});

test("supplier migration is opt-in and does not infer ownership for legacy records", () => {
  const migration = read("../scripts/migrate-tenant-suppliers.mjs");
  const packageJson = read("../package.json");
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /existing suppliers remain NULL and visible only to the default tenant; ownership is not inferred/);
  assert.doesNotMatch(migration, /UPDATE suppliers SET tenant_id/);
  assert.match(migration, /GET_LOCK\('tenant_suppliers_v1'/);
  assert.match(migration, /idx_suppliers_tenant_status_id/);
  assert.match(packageJson, /"db:migrate:tenant-suppliers": "node scripts\/migrate-tenant-suppliers\.mjs"/);
});

test("supplier service scopes list, counts, and every write by the authenticated tenant", () => {
  const service = read("../src/services/mysql-suppliers.js");
  assert.match(service, /function supplierTenantScope\(tenantId/);
  assert.match(service, /tenant_id = \?/);
  assert.match(service, /tenant_id IS NULL/);
  assert.match(service, /async function hasSupplierTenantSchema\(\)/);
  assert.match(service, /if \(!hasTenantColumn && String\(tenantId\) !== "admin"\)/);
  assert.match(service, /供应商企业隔离暂不可用：suppliers\.tenant_id 尚未迁移/);
  assert.match(service, /suppliersMysql\(query = \{\}, tenantId = "admin"\)/);
  assert.match(service, /createSupplierMysql\(body = \{\}, tenantId = "admin"\)/);
  assert.match(service, /updateSupplierMysql\(id, body = \{\}, tenantId = "admin"\)/);
  assert.match(service, /deleteSupplierMysql\(id, tenantId = "admin"\)/);
  assert.match(service, /WHERE id = \? AND \$\{scope\.sql\}/);
  assert.match(service, /productScope = !hasTenantColumn \? "1 = 1" : String\(tenantId\) === "admin" \? "tenant_id IS NULL" : "tenant_id = \?"/);
  assert.match(service, /invalidateMasterDataCachePrefix\("suppliers:"\)/);
});

test("supplier routes derive tenant scope from session and do not accept caller-selected tenants", () => {
  const routes = read("../src/server/routes/operations.js");
  const tenant = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "suppliers"]],
    ["POST", ["api", "suppliers"]],
    ["PUT", ["api", "suppliers", "12"]],
    ["DELETE", ["api", "suppliers", "12"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "suppliers", "other"]],
    ["PUT", ["api", "suppliers", "other"]],
    ["POST", ["api", "suppliers", "12"]],
    ["DELETE", ["api", "suppliers"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, false);
  assert.match(routes, /services\.suppliers\(query, tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.createSupplier\(await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.updateSupplier\(Number\(parts\[2\]\), await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.deleteSupplier\(Number\(parts\[2\]\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /delete query\.tenant_id;[\s\S]*?delete query\.tenantId;/);
});

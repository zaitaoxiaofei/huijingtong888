import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { authorizeApiRequest } from "../src/server/authorization.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const tenant = { tenant: { id: 42, slug: "company-a", role: "owner" } };

test("tenant manual outbound exposes scoped dedicated routes and verified legacy aliases", () => {
  for (const [method, parts] of [
    ["GET", ["api", "inventory", "manual-outbound-records"]],
    ["PUT", ["api", "inventory", "manual-outbound-records", "123"]],
    ["DELETE", ["api", "inventory", "manual-outbound-records", "123"]],
    ["GET", ["api", "inventory"]],
    ["POST", ["api", "inventory", "movements"]],
    ["PUT", ["api", "inventory", "movements", "123"]],
    ["DELETE", ["api", "inventory", "movements", "123"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, true);

  for (const [method, parts] of [
    ["POST", ["api", "inventory", "manual-outbound-records"]],
    ["PUT", ["api", "inventory", "manual-outbound-records", "all"]],
    ["DELETE", ["api", "inventory", "manual-outbound-records", "123", "extra"]],
    ["PUT", ["api", "inventory", "movements", "all"]],
    ["DELETE", ["api", "inventory", "movements", "123", "extra"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, false);
});

test("manual outbound API derives tenant scope from session and keeps read/write permissions distinct", () => {
  const routes = read("../src/server/routes/operations.js");
  const authorization = read("../src/server/authorization.js");
  assert.match(routes, /inventoryManualOutboundRecords\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /updateInventoryMovement\(Number\(parts\[3\]\), await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /deleteInventoryMovement\(Number\(parts\[3\]\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(authorization, /resource === "inventory" && parts\[2\] === "manual-outbound-records"\) return read \? require\("inventory\.read"\) : require\("packing", "inventory\.write"\)/);

  const check = (roles, method, path) => authorizeApiRequest({ method, _session: { role: "operator", roles } }, path.split("/").filter(Boolean)).allowed;
  assert.equal(check(["packing"], "GET", "/api/inventory/manual-outbound-records"), true);
  assert.equal(check(["technical"], "GET", "/api/inventory/manual-outbound-records"), false);
  assert.equal(check(["packing"], "PUT", "/api/inventory/manual-outbound-records/123"), true);
  assert.equal(check(["inventory"], "DELETE", "/api/inventory/manual-outbound-records/123"), false);
});

test("tenant manual outbound reads and mutations enforce tenant and record type in SQL", () => {
  const service = read("../src/services/mysql-cutover.js");
  const readService = service.match(/export async function inventoryManualOutboundRecordsMysql\([\s\S]*?(?=export async function inventoryStockDebtsMysql)/)?.[0] || "";
  const updateService = service.match(/export async function updateInventoryMovementMysql\([\s\S]*?(?=export async function deleteInventoryMovementMysql)/)?.[0] || "";
  const deleteService = service.match(/export async function deleteInventoryMovementMysql\([\s\S]*?(?=export async function inventoryManualOutboundRecordsMysql)/)?.[0] || "";

  assert.match(readService, /resolveInventoryTenantScope\(tenantId\)/);
  assert.match(readService, /scope\.predicate\('im'\)\.sql\} AND \$\{scope\.predicate\('p'\)\.sql\} AND p\.active = 1/);
  assert.match(readService, /im\.source_type = 'manual_outbound'/);
  assert.match(readService, /scope\.predicate\('parent_pc'\)\.sql/);
  assert.match(readService, /scope\.predicate\('s'\)\.sql/);
  for (const mutation of [updateService,deleteService]) {
    assert.match(mutation, /resolveInventoryTenantScope\(tenantId\)/);
    assert.match(mutation, /AND \$\{scope\.predicate\(\)\.sql\} AND source_type = 'manual_outbound' FOR UPDATE/);
    assert.match(mutation, /DELETE FROM inventory_movements WHERE source_type = 'manual_outbound' AND source_ref = \? AND \$\{scope\.predicate\(\)\.sql\}/);
    assert.match(mutation, /const tenantScoped = true/);
  }
  assert.match(updateService, /SELECT id FROM products WHERE id = \? AND \$\{scope\.predicate\(\)\.sql\} AND active = 1 FOR UPDATE/);
  assert.match(updateService, /assertInventoryReferences\(scope, body,/);
});

test("tenant inventory UI uses dedicated manual outbound routes and respects write roles", () => {
  const view = read("../frontend/admin/views/inventory/InventoryProductsPage.vue");
  assert.match(view, /canOutbound = computed\(\(\) => hasPermission\(authStore\.user, "packing"\) \|\| hasPermission\(authStore\.user, "inventory\.write"\)\)/);
  assert.match(view, /isTenantScoped\.value \? "manual-outbound-records" : "movements"/);
  assert.match(view, /isTenantScoped\.value \? "\/api\/inventory\/manual-outbound-records" : "\/api\/inventory"/);
  assert.match(view, /el-button v-if="canOutbound" type="warning" @click="openManualOutbound/);
  assert.match(view, /el-table-column v-if="canOutbound" label="操作"/);
});

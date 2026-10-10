import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { authorizeApiRequest } from "../src/server/authorization.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const tenant = { tenant: { id: 42, slug: "company-a", role: "owner" } };

test("tenant manual outbound exposes only its dedicated list and numeric mutation routes", () => {
  for (const [method, parts] of [
    ["GET", ["api", "inventory", "manual-outbound-records"]],
    ["PUT", ["api", "inventory", "manual-outbound-records", "123"]],
    ["DELETE", ["api", "inventory", "manual-outbound-records", "123"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, true);

  for (const [method, parts] of [
    ["POST", ["api", "inventory", "manual-outbound-records"]],
    ["PUT", ["api", "inventory", "manual-outbound-records", "all"]],
    ["DELETE", ["api", "inventory", "manual-outbound-records", "123", "extra"]],
    ["PUT", ["api", "inventory", "movements", "123"]],
    ["DELETE", ["api", "inventory", "movements", "123"]]
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

  assert.match(readService, /im\.tenant_id = \? AND p\.tenant_id = \? AND p\.active = 1/);
  assert.match(readService, /im\.source_type = 'manual_outbound'/);
  assert.match(readService, /parent_pc\.tenant_id = \?/);
  assert.match(readService, /s\.tenant_id = \?/);
  assert.match(updateService, /AND tenant_id = \? AND source_type = 'manual_outbound'/);
  assert.match(updateService, /SELECT id FROM products WHERE id = \? AND tenant_id = \? AND active = 1 FOR UPDATE/);
  assert.match(updateService, /DELETE FROM inventory_movements WHERE source_type = 'manual_outbound' AND source_ref = \? \$\{tenantScoped \? "AND tenant_id = \?" : ""\}/);
  assert.match(deleteService, /AND tenant_id = \? AND source_type = 'manual_outbound'/);
  assert.match(deleteService, /DELETE FROM inventory_movements WHERE source_type = 'manual_outbound' AND source_ref = \? \$\{tenantScoped \? "AND tenant_id = \?" : ""\}/);
});

test("tenant inventory UI uses dedicated manual outbound routes and respects write roles", () => {
  const view = read("../frontend/admin/views/inventory/InventoryProductsPage.vue");
  assert.match(view, /canOutbound = computed\(\(\) => hasPermission\(authStore\.user, "packing"\) \|\| hasPermission\(authStore\.user, "inventory\.write"\)\)/);
  assert.match(view, /isTenantScoped\.value \? "manual-outbound-records" : "movements"/);
  assert.match(view, /isTenantScoped\.value \? "\/api\/inventory\/manual-outbound-records" : "\/api\/inventory"/);
  assert.match(view, /el-button v-if="canOutbound" type="warning" @click="openManualOutbound/);
  assert.match(view, /el-table-column v-if="canOutbound" label="操作"/);
});

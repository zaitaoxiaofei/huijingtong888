import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("verified tenant order list and operations open without permitting unknown routes", () => {
  const tenant = { tenant: { id: 42, slug: "company-a" } };
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123", "status-history"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123", "mark"], "PUT").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123", "procurement-preview"], "GET").allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "orders"]],
    ["POST", ["api", "orders", "123", "recalculate-profit"]],
    ["POST", ["api", "orders", "package-label"]],
    ["POST", ["api", "orders", "package-label-printed"]],
    ["POST", ["api", "orders", "package-label-print-failed"]],
    ["POST", ["api", "orders", "ship"]],
    ["POST", ["api", "orders", "recalculate-profits"]],
    ["GET", ["api", "order-car-heatmap", "models"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "orders", "abc"]],
    ["DELETE", ["api", "orders", "123"]],
    ["POST", ["api", "orders", "123", "unverified"]],
    ["POST", ["api", "orders", "ship", "unverified"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, false);
});

test("tenant order REST routes propagate enterprise ownership into procurement and batch writes", () => {
  const routes = read("../src/server/routes/orders.js");
  assert.match(routes, /services\.previewOrderProcurement\(Number\(parts\[2\]\), tenantId\)/);
  assert.match(routes, /services\.orderProcurementBatches\(Number\(parts\[2\]\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.createOrderProcurementRequests\(Number\(parts\[2\]\), await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.shipOrders\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\), \{ session: req\._session \}\)/);
});

test("default enterprise uses the same fail-closed order ownership and safe enrichment as other enterprises", () => {
  const service = read("../src/services/mysql-cutover.js");
  const fn = name => service.match(new RegExp('^(?:export )?(?:async )?function '+name+'\\([^]*?^}', 'm'))?.[0] || '';
  const scope = fn('orderListTenantScopeMysql');
  assert.match(scope, /const id = await resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(scope, /mysqlSchemaColumnExists\(table, "tenant_id"\)/);
  assert.match(scope, /inbound_records.*purchase_orders.*purchase_order_items/);
  assert.doesNotMatch(scope, /tenantId === "admin"\) return null/);
  const detail = fn('orderDetailMysql');
  assert.match(detail, /const scope = await orderListTenantScopeMysql\(tenantId\)/);
  assert.match(detail, /tenantShopPredicateMysql\("s", scope\.defaultTenant\)/);
  assert.match(detail, /sm\.shop_id = \?/);
  assert.match(detail, /tenantShopPredicateMysql\("p", scope\.defaultTenant\)/);
  assert.match(detail, /member\.tenant_id = \$\{scope\.id\}.*member\.active = 1/);
  assert.match(detail, /readableLogisticsTenantScopeMysql\(tenantId, "frozen_rule"\)/);
  assert.match(detail, /oi\.\*, sm\.id AS sku_mapping_id, frozen_rule\.id AS frozen_logistics_rule_id/);
});

test("paging, counts, derived coverage, logistics cache and picking all keep an explicit enterprise", () => {
  const service = read("../src/services/mysql-cutover.js");
  const picking = read("../src/services/order-inventory-picking.js");
  const fn = name => service.match(new RegExp('^(?:export )?(?:async )?function '+name+'\\([^]*?^}', 'm'))?.[0] || '';
  assert.match(fn('orderBaseSqlMysql'), /orderTenantPredicateMysql\("tenant_shop", tenantScope\)/);
  assert.match(fn('ordersPagedMysql'), /orderTenantCoverageMysql\(tenantScope\)/);
  assert.doesNotMatch(fn('ordersPagedMysql'), /const includeCounts = !tenantScope/);
  assert.match(fn('orderTenantCoverageMysql'), /tenantId: scope\.id/);
  assert.match(fn('orderTenantCoverageMysql'), /includeLegacyTenantNull: scope\.defaultTenant, fresh: true/);
  assert.doesNotMatch(fn('enrichOrderRowsForListMysql'), /cachedOrderProcurementCoverage\(/);
  assert.match(fn('enrichOrderRowsForListMysql'), /orderInventoryPickingMysql\(orderIds, tenantScope\.id\)/);
  assert.match(fn('loadOrderLogisticsSummaryForBaseMysql'), /orders:logistics-summary:v9:/);
  assert.match(picking, /direct_mapping\.shop_id = o\.shop_id/);
  assert.match(picking, /legacy \? .*tenant_id IS NULL/);
  assert.match(picking, /scope\("child"\)/);
});

test("order schema supports tenant shop pagination and the opt-in migration audits linked records", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const migration = read("../scripts/migrate-tenant-orders.mjs");
  const packageJson = read("../package.json");
  const service = read("../src/services/mysql-cutover.js");
  assert.match(schema, /idx_orders_shop_ordered_id \(shop_id, ordered_at, id\)/);
  assert.match(schema, /UNIQUE KEY uk_orders_shop_posting_number \(shop_id, posting_number\)/);
  assert.doesNotMatch(schema, /UNIQUE KEY uk_orders_posting_number \(posting_number\)/);
  assert.match(schema, /idx_order_items_order_mapping_sku \(order_id, sku_mapping_id, ozon_sku\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /orders_without_shop/);
  assert.match(migration, /items_without_order/);
  assert.match(migration, /mapping_shop_mismatches/);
  assert.match(migration, /finance_posting_shop_mismatches/);
  assert.match(migration, /own_shop_order\.shop_id=fi\.shop_id/);
  assert.match(migration, /duplicate_shop_posting_groups/);
  assert.match(migration, /ADD UNIQUE KEY \$\{uniqueName\} \$\{uniqueDefinition\}/);
  assert.match(migration, /DROP INDEX \$\{LEGACY_GLOBAL_UNIQUE_INDEX\[1\]\}/);
  assert.match(migration, /Shop-scoped order uniqueness verification failed/);
  assert.ok(migration.indexOf("const orderTables = await query(\"SHOW TABLES LIKE 'orders'\")") < migration.indexOf("SHOW COLUMNS FROM orders"));
  assert.ok(migration.indexOf("ADD UNIQUE KEY ${uniqueName} ${uniqueDefinition}") < migration.indexOf("DROP INDEX ${LEGACY_GLOBAL_UNIQUE_INDEX[1]}"));
  assert.ok(migration.indexOf("uniqueColumns.join(\",\") !== \"shop_id,posting_number\"") < migration.indexOf("DROP INDEX ${LEGACY_GLOBAL_UNIQUE_INDEX[1]}"));
  assert.match(migration, /GET_LOCK\('tenant_orders_indexes_v1'/);
  assert.doesNotMatch(migration, /UPDATE orders SET tenant_id/);
  assert.match(packageJson, /"db:migrate:tenant-orders": "node scripts\/migrate-tenant-orders\.mjs"/);
  const sync = service.match(/async function upsertPostingMysql\(shop, posting[^)]*\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(sync, /SELECT \* FROM orders WHERE shop_id = \? AND posting_number = \?/);
  assert.doesNotMatch(sync, /SELECT \* FROM orders WHERE posting_number = \?/);
});

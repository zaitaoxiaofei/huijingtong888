import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("tenant order routes allow only order-owned detail, history, mark, and guarded procurement preview", () => {
  const tenant = { tenant: { id: 42, slug: "company-a" } };
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders"], "GET").code, "TENANT_ISOLATION_PENDING");
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123", "status-history"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123", "mark"], "PUT").allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ["api", "orders", "123", "procurement-preview"], "GET").allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "orders"]],
    ["GET", ["api", "orders", "abc"]],
    ["POST", ["api", "orders", "123", "recalculate-profit"]],
    ["GET", ["api", "orders", "123", "procurement-batches"]],
    ["POST", ["api", "orders", "123", "procurement-requests"]],
    ["POST", ["api", "orders", "package-label"]],
    ["POST", ["api", "orders", "package-label-printed"]],
    ["POST", ["api", "orders", "package-label-print-failed"]],
    ["POST", ["api", "orders", "ship"]],
    ["POST", ["api", "orders", "recalculate-profits"]],
    ["GET", ["api", "order-car-heatmap", "models"]]
  ]) assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, false);
});

test("tenant order REST route propagates tenant ownership and guards shared procurement preview", () => {
  const routes = read("../src/server/routes/orders.js");
  assert.match(routes, /services\.orderStatusHistory\(Number\(parts\[2\]\), Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.updateOrderMark\(Number\(parts\[2\]\), await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /if \(tenantId !== "admin"\)\s*\{\s*throw Object\.assign\(new Error\("企业订单采购预览暂不可用/);
});

test("tenant order detail scopes shop and all product-derived fields, and fails closed without ownership schema", () => {
  const routes = read("../src/server/routes/orders.js");
  const service = read("../src/services/mysql-cutover.js");
  const isolation = read("../src/server/tenant-isolation.js");
  assert.match(routes, /services\.orderDetail\(Number\(parts\[2\]\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.orderStatusHistory\(Number\(parts\[2\]\), Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.updateOrderMark\(Number\(parts\[2\]\), await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  const detail = service.match(/export async function orderDetailMysql\(id, tenantId = "admin"\) \{([\s\S]*?)\n\}\n\nconst CUSTOMER_MESSAGE_TYPES/)?.[1] || "";
  assert.match(detail, /mysqlSchemaColumnExists\(table, "tenant_id"\)/);
  assert.match(detail, /企业订单详情暂不可用/);
  assert.match(detail, /\["shops", "sku_mappings", "products", "logistics_fee_rules"\]/);
  assert.match(detail, /tenantShopPredicateMysql\("s", false\)/);
  assert.match(detail, /sm\.shop_id = \? AND sm\.tenant_id = \?/);
  assert.match(detail, /p\.tenant_id = \?/);
  assert.match(detail, /LEFT JOIN people pe ON 1 = 0/);
  assert.match(detail, /frozen_rule\.tenant_id = \?/);
});

test("tenant order paging scopes shop, mapping and product rows without shared procurement coverage", () => {
  const routes = read("../src/server/routes/orders.js");
  const service = read("../src/services/mysql-cutover.js");
  const picking = read("../src/services/order-inventory-picking.js");
  const isolation = read("../src/server/tenant-isolation.js");
  assert.match(routes, /services\.ordersPaged\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(service, /async function orderBaseSqlMysql\(query = \{\}, tenantId = "admin"\)/);
  assert.match(service, /tenant_shop\.tenant_id = \$\{tenantScope\.id\} AND tenant_shop\.status = 'active'/);
  assert.match(service, /AND sm\.tenant_id = \$\{tenantScope\.id\}/);
  assert.match(service, /p\.tenant_id = \$\{tenantScope\.id\}/);
  assert.match(service, /tenantScope \? `AND inventory_movements\.tenant_id = \$\{tenantScope\.id\}`/);
  assert.match(service, /component_product\.tenant_id = \$\{tenantScope\.id\} AND pc\.tenant_id = \$\{tenantScope\.id\}/);
  assert.match(service, /AND request\.tenant_id = \$\{tenantScope\.id\}/);
  assert.match(service, /member\.tenant_id = \$\{tenantScope\.id\} AND member\.person_id = request_person\.id AND member\.active = 1/);
  assert.match(service, /orderInventoryPickingMysql\(orderIds, tenantScoped \? tenantId : "admin"\)/);
  assert.match(service, /rule\.tenant_id = \$\{Number\(tenantId\)\}/);
  assert.match(service, /const logisticsRuleFilterCacheMysql = new Map\(\)/);
  assert.match(service, /async function activeOrderLogisticsFilterMethodsMysql\(tenantId = "admin"\)/);
  assert.match(service, /const tenantScope = await logisticsTenantScopeMysql\(tenantId, "l"\)/);
  assert.match(service, /if \(logisticsRuleFilterCacheMysql\.size > 128\)/);
  assert.match(service, /logisticsRuleFilterCacheMysql\.delete\(cacheKey\)/);
  assert.match(service, /activeOrderLogisticsFilterMethodsMysql\(tenantScoped \? tenantId : "admin"\)/);
  assert.match(service, /const tenantCacheKey = String\(tenantId \|\| "admin"\)/);
  assert.match(service, /orders:logistics-summary:v6:\$\{tenantCacheKey\}:/);
  assert.match(picking, /direct_mapping\.tenant_id = \$\{tenantPk\}/);
  assert.match(picking, /pc\.tenant_id = \$\{tenantPk\}/);
  assert.match(picking, /child\.tenant_id = \$\{tenantPk\}/);
  assert.match(service, /tenantScoped \? new Map\(\) : coveragePromise === null \? \(cachedOrderProcurementCoverage\(\) \|\| new Map\(\)\)/);
  assert.match(service, /if \(tenantScope && requestedCoverageFilter\)/);
  assert.match(service, /function assertTenantOrderListFiltersMysql\(query = \{\}, tenantScope = null\)/);
  assert.match(service, /const tenantSafeStatuses = new Set\(\["all", "awaiting_packaging", "awaiting_deliver", "delivering", "dispute", "cancelled", "delivered", "unbound"\]\)/);
  assert.match(service, /function addOrderSearchSqlMysql\(where, params, query, tenantScope = null\)/);
  assert.match(service, /direct_sm\.tenant_id = \$\{tenantScope\.id\}/);
  assert.match(service, /fallback_p\.tenant_id = \$\{tenantScope\.id\}/);
  assert.match(service, /sm_by_id\.tenant_id = \$\{tenantScope\.id\} AND p_by_id\.tenant_id = \$\{tenantScope\.id\}/);
  assert.match(service, /相关映射或采购数据租户隔离尚未完成/);
  assert.match(service, /const includeCounts = !tenantScope/);
  assert.match(isolation, /tenantOrderDetailRead/);
  assert.match(isolation, /企业订单列表隔离改造尚未完成/);
  assert.match(service, /export async function updateOrderMarkMysql\(orderId, body = \{\}, userId = null, tenantId = "admin"\)/);
  assert.match(service, /export async function orderStatusHistoryMysql\(orderId, query = \{\}, tenantId = "admin"\)/);
  assert.match(service, /export async function previewOrderProcurementMysql\(orderId, tenantId = "admin"\)/);
  assert.match(service, /企业订单采购预览暂不可用：采购、入库与库存关联数据尚未完成租户隔离/);
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
  const sync = service.match(/async function upsertPostingMysql\(shop, posting\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(sync, /SELECT \* FROM orders WHERE shop_id = \? AND posting_number = \?/);
  assert.doesNotMatch(sync, /SELECT \* FROM orders WHERE posting_number = \?/);
});

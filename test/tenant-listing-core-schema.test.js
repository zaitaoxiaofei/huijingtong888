import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { assertNoDuplicateCategoryUsage, assertNoDuplicateTenantRequest, assertTenantIdColumnType } from "../scripts/lib/tenant-listing-core-migration-guard.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("tenant-scoped template and core draft CRUD routes open without exposing batch or conversion routes", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "templates"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "templates", "1"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "templates"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "templates", "1"], "PUT").allowed, true);
  for (const [method, parts] of [
    ["POST", ["api", "listing", "drafts", "batch-publish"]],
    ["POST", ["api", "listing", "drafts", "from-inventory-product"]],
    ["GET", ["api", "listing", "drafts", "not-numeric"]],
    ["PUT", ["api", "listing", "drafts", "not-numeric"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
  for (const [method, parts] of [
    ["GET", ["api", "listing", "drafts"]],
    ["POST", ["api", "listing", "drafts"]],
    ["PUT", ["api", "listing", "drafts", "1"]],
    ["DELETE", ["api", "listing", "drafts", "1"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
});

test("listing core tables define nullable tenant ownership with query-first indexes", () => {
  const service = read("../src/services/listing-automation.js");
  assert.match(service, /CREATE TABLE IF NOT EXISTS listing_category_templates \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /idx_listing_templates_tenant_status_updated \(tenant_id, status, updated_at, id\)/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS listing_drafts \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /idx_listing_drafts_tenant_status_updated \(tenant_id, status, updated_at, id\)/);
  assert.match(service, /idx_listing_drafts_tenant_template \(tenant_id, template_id, status, updated_at\)/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS listing_shop_copies \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /idx_listing_shop_copies_tenant_draft_shop \(tenant_id, draft_id, shop_id, status\)/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS listing_publish_records \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /idx_listing_publish_tenant_status_created \(tenant_id, status, created_at, id\)/);
  assert.match(service, /idx_listing_publish_tenant_draft \(tenant_id, draft_id, status, updated_at\)/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS listing_publish_tasks \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /uq_listing_publish_tasks_tenant_request", "\(tenant_id, request_id\)"/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS listing_publish_task_items \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /idx_listing_publish_task_items_tenant_draft_shop \(tenant_id, draft_id, shop_id, status\)/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS ozon_category_usage \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /uq_ozon_category_usage_tenant \(tenant_id, source_module, source_id, description_category_id, type_id\)/);
  assert.match(service, /idx_ozon_category_usage_tenant_category \(tenant_id, description_category_id, type_id, last_used_at\)/);
});

test("listing core migration is dry-run by default and does not infer legacy tenant ownership", () => {
  const migration = read("../scripts/migrate-tenant-listing-core-ownership.mjs");
  const guards = read("../scripts/lib/tenant-listing-core-migration-guard.mjs");
  const packageJson = read("../package.json");
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /existing rows remain NULL and must stay default-tenant-only/);
  assert.doesNotMatch(migration, /UPDATE listing_(category_templates|drafts|shop_copies|publish_records|publish_tasks|publish_task_items) SET tenant_id/);
  assert.match(migration, /GET_LOCK\('tenant_listing_core_ownership_v1'/);
  assert.match(migration, /listing_publish_records:[\s\S]*?idx_listing_publish_tenant_status_created/);
  assert.match(migration, /listing_publish_task_items:[\s\S]*?idx_listing_publish_task_items_tenant_draft_shop/);
  assert.match(migration, /ozon_category_usage:[\s\S]*?idx_ozon_category_usage_tenant_category/);
  assert.match(migration, /uq_ozon_category_usage_tenant/);
  assert.match(migration, /ozon_category_usage: \["uq_ozon_category_usage"\]/);
  assert.match(migration, /uq_listing_publish_tasks_tenant_request/);
  assert.match(migration, /uq_listing_publish_tasks_request/);
  assert.match(migration, /assertTenantIdColumnType\(snapshot\.table, tenantColumn\?\.Type\)/);
  assert.match(migration, /assertNoDuplicateTenantRequest\(duplicate\)/);
  assert.match(migration, /assertNoDuplicateCategoryUsage\(duplicate\)/);
  assert.match(guards, /expected VARCHAR\(80\); no schema changes were applied/);
  assert.match(guards, /duplicate request_id .* no schema changes were applied/);
  assert.match(migration, /COALESCE\(NULLIF\(tenant_id, ''\), 'admin'\)/);
  assert.match(migration, /async function inspectTable\(table, query = mysqlQuery\)/);
  assert.match(migration, /const adminQuery = async \(sql, params = \[\]\) => \(await admin\.query\(sql, params\)\)\[0\]/);
  assert.match(migration, /Object\.keys\(TABLES\)\.map\(\(table\) => inspectTable\(table, adminQuery\)\)/);
  assert.ok(migration.indexOf("GET_LOCK('tenant_listing_core_ownership_v1'") < migration.indexOf("inspectTable(table, adminQuery)"));
  assert.ok(migration.indexOf("Validate every existing table before the first ALTER/DROP") < migration.indexOf("ADD COLUMN tenant_id VARCHAR(80) NULL"));
  assert.match(packageJson, /"db:migrate:tenant-listing-core": "node scripts\/migrate-tenant-listing-core-ownership\.mjs"/);
});

test("listing migration preflight guards accept expected legacy schemas and reject drift or duplicate tenant requests", () => {
  assert.doesNotThrow(() => assertTenantIdColumnType("listing_drafts", undefined));
  assert.doesNotThrow(() => assertTenantIdColumnType("listing_drafts", "VARCHAR(80)"));
  assert.throws(() => assertTenantIdColumnType("listing_drafts", "varchar(64)"), /expected VARCHAR\(80\)/);
  assert.throws(() => assertTenantIdColumnType("listing_drafts", "bigint unsigned"), /listing_drafts\.tenant_id has unexpected type/);

  assert.doesNotThrow(() => assertNoDuplicateTenantRequest(null));
  assert.throws(() => assertNoDuplicateTenantRequest({ tenant_key: "42", request_id: "req-1" }), /duplicate request_id req-1 in tenant 42/);
  assert.doesNotThrow(() => assertNoDuplicateCategoryUsage(null));
  assert.throws(() => assertNoDuplicateCategoryUsage({ tenant_key: "42", source_module: "listing_template", source_id: "7", description_category_id: 10, type_id: 20 }), /duplicate listing_template\/7\/10:20 in tenant 42/);
});

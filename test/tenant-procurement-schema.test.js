import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("procurement request schema has tenant-first indexes for tenant queue access", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const tableStart = schema.indexOf("CREATE TABLE IF NOT EXISTS procurement_requests (");
  const tableEnd = schema.indexOf("CREATE TABLE IF NOT EXISTS procurement_ledger_actions", tableStart);
  const table = schema.slice(tableStart, tableEnd);
  assert.match(table, /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(table, /idx_procurement_tenant_status_created \(tenant_id, status, created_at, id\)/);
  assert.match(table, /idx_procurement_tenant_purchase_status \(tenant_id, purchase_order_id, status\)/);
  assert.match(schema, /ALTER TABLE procurement_requests ADD COLUMN tenant_id BIGINT UNSIGNED NULL/);
  assert.match(schema, /CREATE INDEX idx_procurement_tenant_status_created ON procurement_requests \(tenant_id, status, created_at, id\)/);
  assert.match(schema, /CREATE INDEX idx_procurement_tenant_purchase_status ON procurement_requests \(tenant_id, purchase_order_id, status\)/);
});

test("procurement request tenant attribution is explicit, dry-run first, and stops on ambiguous ownership", () => {
  const migration = read("../scripts/migrate-tenant-procurement-requests.mjs");
  const packageJson = read("../package.json");
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /if \(APPLY && !socketPath\).*--mysql-admin-socket/s);
  assert.match(migration, /GET_LOCK\('tenant_procurement_requests_v1'/);
  assert.match(migration, /LEFT JOIN orders source_order ON source_order\.id = pr\.source_order_id/);
  assert.match(migration, /LEFT JOIN shops source_shop ON source_shop\.id = source_order\.shop_id/);
  assert.match(migration, /COALESCE\(source_shop\.tenant_id, tenant_default\.id\)/);
  assert.match(migration, /WHERE pr\.tenant_id IS NULL/);
  assert.match(migration, /orphan_source_order_count/);
  assert.match(migration, /mixed_purchase_order_count/);
  assert.match(migration, /mismatched_existing_tenant_count/);
  assert.match(migration, /invalid_tenant_reference_count/);
  assert.match(migration, /pr\.tenant_id IS NOT NULL AND pr\.source_order_id IS NOT NULL/);
  assert.match(migration, /changes_database: false/);
  assert.match(migration, /tenant_id_remains_nullable_for_legacy_writers: true/);
  assert.match(packageJson, /"db:migrate:tenant-procurement": "node scripts\/migrate-tenant-procurement-requests\.mjs"/);
});

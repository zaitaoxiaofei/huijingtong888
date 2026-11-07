import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("online product action audit writes and completion updates remain tenant-bound", () => {
  const service = read("../src/services/mysql-cutover.js");
  const helper = service.slice(service.indexOf("async function recordOnlineProductActionMysql"), service.indexOf("function isOzonItemNotFoundError"));
  const batch = service.slice(service.indexOf("export async function batchUpdateOnlineProductStocksMysql"), service.indexOf("export async function performOnlineProductActionMysql"));
  const action = service.slice(service.indexOf("export async function performOnlineProductActionMysql"), service.indexOf("export async function mappingsMysql"));
  assert.match(helper, /ALTER TABLE online_product_actions ADD COLUMN tenant_id VARCHAR\(80\) NULL/);
  assert.match(helper, /idx_online_product_actions_tenant_shop_created \(tenant_id, shop_id, created_at, id\)/);
  assert.match(helper, /INSERT INTO online_product_actions\s*\(tenant_id, online_product_id,/);
  assert.match(helper, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(batch, /tenantId: normalizedTenantId/);
  assert.match(batch, /finishOnlineProductActionMysql\(actionId, "success", result, "", normalizedTenantId\)/);
  assert.match(action, /tenantId: normalizedTenantId/);
  assert.match(action, /finishOnlineProductActionMysql\(actionId, "failed", result, result\.error, normalizedTenantId\)/);
});

test("online product action tenant migration is guarded, dry-run by default, and preserves legacy ownership as null", () => {
  const migration = read("../scripts/migrate-tenant-online-product-actions.mjs");
  const schema = read("../scripts/init-mysql-schema.mjs");
  const packageJson = read("../package.json");
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /existing rows remain NULL and visible only to the default tenant; ownership is not inferred/);
  assert.match(migration, /GET_LOCK\('tenant_online_product_actions_v1'/);
  assert.doesNotMatch(migration, /UPDATE online_product_actions SET tenant_id/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS online_product_actions \([\s\S]*?tenant_id VARCHAR\(80\) NULL[\s\S]*?idx_online_product_actions_tenant_shop_created/);
  assert.match(packageJson, /"db:migrate:tenant-online-product-actions": "node scripts\/migrate-tenant-online-product-actions\.mjs"/);
});

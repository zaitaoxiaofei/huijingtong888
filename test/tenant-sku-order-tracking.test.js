import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("SKU tracking routes derive tenant scope from the authenticated session", async () => {
  const routes = read("../src/server/routes/orders.js");
  assert.match(routes, /services\.skuOrderTrackingList\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(routes, /services\.saveSkuOrderTracker\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  const session = { personId: 7, tenant: { id: 42, slug: "company-a" } };
  assert.equal(tenantIsolationDecision(session, ["api", "sku-order-tracking"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "sku-order-tracking"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "sku-order-tracking", "other"], "POST").allowed, false);
});

test("SKU tracker records and owner assignments are tenant-bound", () => {
  const service = read("../src/services/sku-order-tracking.js");
  assert.match(service, /tenant_id BIGINT UNSIGNED NOT NULL/);
  assert.match(service, /SHOW COLUMNS FROM sku_order_trackers/);
  assert.match(service, /SHOW INDEX FROM sku_order_trackers/);
  assert.match(service, /idx_sku_order_tracker_tenant_active_shop/);
  assert.doesNotMatch(service, /ALTER TABLE sku_order_trackers/);
  assert.match(service, /tracker\.tenant_id = \$\{trackerTenantExpr\}/);
  assert.match(service, /order_shop\.tenant_id = \?/);
  assert.match(service, /s\.tenant_id = \?/);
  assert.match(service, /FROM tenant_members WHERE tenant_id = \? AND person_id = \? AND active = 1/);
  assert.match(service, /INSERT INTO sku_order_trackers \(tenant_id, shop_id, ozon_sku/);
  assert.match(service, /WHERE m\.tenant_id = \? AND m\.period_key/);
  assert.doesNotMatch(service, /m\.tenant_id = 'admin'/);
  assert.match(service, /tenant\.isDefault \? "sm\.product_id inventory_product_id, p\.code inventory_code, p\.name inventory_name"/);
});

test("SKU tracker migration is explicit, dry-run by default, and attributes rows from shops", () => {
  const migration = read("../scripts/migrate-tenant-sku-order-trackers.mjs");
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /Apply mode requires --mysql-admin-socket/);
  assert.match(migration, /COALESCE\(s\.tenant_id, tenant_default\.id\)/);
  assert.match(migration, /orphan_shop_count/);
  assert.match(migration, /GET_LOCK\('tenant_sku_order_trackers_v1'/);
  assert.match(migration, /uk_sku_order_tracker_tenant_shop_sku/);
  assert.match(migration, /idx_sku_order_tracker_tenant_active_shop/);
  assert.match(migration, /changes_database: false/);
});

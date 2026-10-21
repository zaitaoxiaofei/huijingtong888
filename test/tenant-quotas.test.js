import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertTenantQuotaAvailable, normalizeTenantQuotaLimit } from "../src/services/tenant-quotas.js";
import { authorizeApiRequest } from "../src/server/authorization.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("tenant quota normalization supports defaults, unlimited, and zero", () => {
  assert.equal(normalizeTenantQuotaLimit(undefined, 1), 1);
  assert.equal(normalizeTenantQuotaLimit(null), null);
  assert.equal(normalizeTenantQuotaLimit(""), null);
  assert.equal(normalizeTenantQuotaLimit("0"), 0);
  assert.equal(normalizeTenantQuotaLimit("10"), 10);
  for (const value of [-1, 1.5, "no", 1000001]) {
    assert.throws(() => normalizeTenantQuotaLimit(value), error => error.statusCode === 400);
  }
});

test("tenant quota guard allows available or unlimited capacity and blocks at the cap", () => {
  assert.doesNotThrow(() => assertTenantQuotaAvailable({ label: "子账号", current: 0, limit: 1 }));
  assert.doesNotThrow(() => assertTenantQuotaAvailable({ label: "子账号", current: 100, limit: null }));
  assert.throws(() => assertTenantQuotaAvailable({ label: "店铺", current: 1, limit: 1 }), error => error.statusCode === 409 && error.message.includes("店铺额度已达上限"));
  assert.throws(() => assertTenantQuotaAvailable({ label: "子账号", current: 0, limit: 0 }), error => error.statusCode === 409);
});

test("quota administration endpoint remains platform-admin only", () => {
  assert.equal(authorizeApiRequest({ method: "POST", _session: { roles: ["admin"], platform_role: "super_admin" } }, ["api", "tenants", "quotas"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: { roles: ["admin"], tenant: { id: 4, slug: "acme", role: "admin" } } }, ["api", "tenants", "quotas"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "POST", _session: { roles: ["operations"], tenant: { id: 4, slug: "acme", role: "owner" } } }, ["api", "tenants", "quotas"]).allowed, false);
});

test("tenant quota configuration is persisted and enforced for members and shops", () => {
  const tenantService = read("../src/services/tenants.js");
  const shopService = read("../src/services/mysql-cutover.js");
  const server = read("../src/server.js");
  const view = read("../frontend/admin/views/settings/TenantSubscriptionView.vue");
  assert.match(tenantService, /ADD COLUMN member_limit INT UNSIGNED NULL/);
  assert.match(tenantService, /ADD COLUMN shop_limit INT UNSIGNED NULL/);
  assert.match(tenantService, /DATE_ADD\(CURRENT_TIMESTAMP, INTERVAL \? DAY\)/);
  assert.match(tenantService, /SELECT \* FROM tenant_plans WHERE code = \? AND active = 1 LIMIT 1/);
  assert.match(tenantService, /SELECT id, member_limit FROM tenants WHERE id = \? AND status = 'active' FOR UPDATE/);
  assert.match(tenantService, /person_id <> \?/);
  assert.match(shopService, /SELECT id, slug, shop_limit FROM tenants WHERE id = \? FOR UPDATE/);
  assert.match(shopService, /SELECT COUNT\(\*\) AS used FROM shops WHERE \(tenant_id = \? OR \(\? = 1 AND tenant_id IS NULL\)\) AND status != 'deleted'/);
  assert.match(server, /POST \/api\/tenants\/quotas/);
  assert.match(view, /子账号用量/);
  assert.match(view, /店铺用量/);
  assert.match(view, /saveQuotas/);
});

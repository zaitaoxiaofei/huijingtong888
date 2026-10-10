import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("AI variant asset routes open only the tenant-scoped list, save, and batch delete", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "listing", "ai-variant-assets"]],
    ["POST", ["api", "listing", "ai-variant-assets"]],
    ["POST", ["api", "listing", "ai-variant-assets", "batch-delete"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "listing", "ai-variant-assets", "123"]],
    ["DELETE", ["api", "listing", "ai-variant-assets", "123"]],
    ["POST", ["api", "listing", "ai-variant-assets", "batch-delete", "123"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("AI variant asset persistence and mutations are scoped by session tenant and existing creator", () => {
  const service = read("../src/services/listing-automation.js");
  const normalize = service.slice(service.indexOf("function normalizeListingAiVariantAssetPayload"), service.indexOf("function nullablePositiveNumber"));
  const list = service.slice(service.indexOf("export async function listingAiVariantAssets"), service.indexOf("export async function listingVariantWorkbenchDrafts"));
  const save = service.slice(service.indexOf("export async function saveListingAiVariantAsset"), service.indexOf("async function normalizeListingAiVariantAssetPayloadForSave"));
  const remove = service.slice(service.indexOf("export async function deleteListingAiVariantAssets"), service.indexOf("export async function createListingDraft"));
  assert.match(normalize, /tenant_id: listingTenantId\(session\)/);
  assert.match(list, /const tenantId = listingTenantId\(session\)/);
  assert.match(list, /tenant_id = \?/);
  assert.match(list, /created_by_person_id = \?/);
  assert.match(save, /\(tenant_id, source_module,/);
  assert.match(save, /WHERE id = \? AND \$\{tenantScope\}/);
  assert.match(remove, /tenant_id = \?/);
  assert.match(remove, /created_by_person_id = \?/);
});

test("AI variant asset tenant migration preserves legacy attribution and adds tenant-first keys", () => {
  const service = read("../src/services/listing-automation.js");
  const migration = read("../scripts/migrate-tenant-listing-ai-variant-assets.mjs");
  const packageJson = read("../package.json");
  assert.match(service, /tenant_id VARCHAR\(80\) NULL,[\s\S]*?uq_listing_ai_variant_asset_tenant_result_field_owner \(tenant_id, result_id, field_key, owner_scope\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /existing rows remain NULL and visible only to the default tenant/);
  assert.doesNotMatch(migration, /UPDATE listing_ai_variant_assets SET tenant_id/);
  assert.match(migration, /GET_LOCK\('tenant_listing_ai_variant_assets_v1'/);
  assert.match(migration, /DROP INDEX \$\{name\}/);
  assert.match(packageJson, /"db:migrate:tenant-listing-ai-assets": "node scripts\/migrate-tenant-listing-ai-variant-assets\.mjs"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createListingAutomationRoutes } from "../src/server/routes/listingAutomation.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("listing media asset routes pass tenant session and expose only scoped list and upload", async () => {
  const calls = [];
  const session = { tenant: { id: 42, slug: "company-a" } };
  const routes = createListingAutomationRoutes({
    services: {
      listingMediaAssets: async (...args) => { calls.push(["list", ...args]); return []; },
      uploadListingMedia: async (...args) => { calls.push(["upload", ...args]); return { ok: true }; }
    },
    readJson: async () => ({})
  });
  const req = { _session: session, query: { paged: "1" } };
  await routes["GET /api/listing/media/assets"](req);
  await routes["POST /api/listing/media/upload"]({ _session: session });
  assert.deepEqual(calls, [
    ["list", { paged: "1" }, session],
    ["upload", { _session: session }, { session }]
  ]);
});

test("only the listing media collection read and upload routes are tenant-enabled", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "listing", "media", "assets"]],
    ["POST", ["api", "listing", "media", "upload"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
  for (const [method, parts] of [
    ["GET", ["api", "listing", "media", "assets", "12"]],
    ["POST", ["api", "listing", "media", "assets"]],
    ["GET", ["api", "listing", "media", "upload"]],
    ["POST", ["api", "listing", "media", "repair"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("listing media asset list, idempotent upload, and registration are tenant-scoped", () => {
  const service = read("../src/services/listing-automation.js");
  const list = service.slice(service.indexOf("export async function listingMediaAssets"), service.indexOf("function applyPreparedDraftShopMedia"));
  const upload = service.slice(service.indexOf("async function uploadListingMediaWithSlot"), service.indexOf("function listingMediaUploadResult"));
  const register = service.slice(service.indexOf("export async function registerListingMediaAsset"), service.indexOf("async function enqueueOzonSellerMediaUploadForListingAsset"));
  const normalize = service.slice(service.indexOf("function normalizeListingMediaAssetPayload"), service.indexOf("function normalizeListingMediaAssetRow"));
  assert.match(list, /const tenantId = listingTenantId\(session\)/);
  assert.match(list, /m\.tenant_id = \?/);
  assert.match(list, /LEFT JOIN asset_variants v ON 1 = 0/);
  assert.match(upload, /WHERE \$\{tenantId === "admin" \? "\(tenant_id = \? OR tenant_id IS NULL\)" : "tenant_id = \?"\}\s+AND source_module = \? AND source_id = \? AND role = \?/);
  assert.match(upload, /\}, session\);/);
  assert.match(normalize, /tenant_id: listingTenantId\(session\)/);
  assert.match(register, /\(tenant_id, source_module,/);
});

test("listing media asset migration leaves legacy rows unattributed and adds tenant-first indexes", () => {
  const service = read("../src/services/listing-automation.js");
  const migration = read("../scripts/migrate-tenant-listing-media-assets.mjs");
  const packageJson = read("../package.json");
  assert.match(service, /CREATE TABLE IF NOT EXISTS listing_media_assets \([\s\S]*?tenant_id VARCHAR\(80\) NULL/);
  assert.match(service, /idx_listing_media_tenant_status_updated \(tenant_id, status, updated_at, id\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /existing rows remain NULL and visible only to the default tenant/);
  assert.doesNotMatch(migration, /UPDATE listing_media_assets SET tenant_id/);
  assert.match(packageJson, /"db:migrate:tenant-listing-media": "node scripts\/migrate-tenant-listing-media-assets\.mjs"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createListingAutomationRoutes } from "../src/server/routes/listingAutomation.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { isTenantScopedPluginRoute, tenantPluginApiError } from "../src/server/local-plugin-tenant.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("media upload job UI routes pass the authenticated tenant session", async () => {
  const calls = [];
  const services = {
    listOzonSellerMediaUploadJobs: async (...args) => { calls.push(["list", ...args]); return []; },
    createOzonSellerMediaUploadJobs: async (...args) => { calls.push(["create", ...args]); return { jobs: [] }; }
  };
  const body = { media: [{ sourceUrl: "https://cdn.example/image.jpg" }], tenant_id: "admin" };
  const session = { tenant: { id: 42, slug: "company-a" } };
  const routes = createListingAutomationRoutes({ services, readJson: async () => body });
  const req = { _session: session, query: { tenant_id: "1" } };
  await routes["GET /api/listing/media/ozon-upload-jobs"](req);
  await routes["POST /api/listing/media/ozon-upload-jobs"](req);
  assert.deepEqual(calls, [["list", req.query, session], ["create", body, session]]);
});

test("seller media endpoints expose only tenant-scoped UI and plugin operations", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const method of ["GET", "POST"]) {
    assert.equal(tenantIsolationDecision(session, ["api", "listing", "media", "ozon-upload-jobs"], method).allowed, true);
  }
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "media", "ozon-upload-jobs", "123"], "DELETE").allowed, false);
  const plugin = ["api", "local-plugin", "server-publish", "media-upload-jobs"];
  assert.equal(isTenantScopedPluginRoute("POST", [...plugin, "claim"]), true);
  assert.equal(isTenantScopedPluginRoute("POST", [...plugin, "job-a", "image-a"]), true);
  assert.equal(isTenantScopedPluginRoute("GET", [...plugin, "claim"]), false);
  assert.equal(isTenantScopedPluginRoute("POST", [...plugin, "claim", "extra"]), false);
  assert.equal(tenantPluginApiError({ tenantId: 42, tenantKey: "42", tenantSlug: "company-a" }, "POST", [...plugin, "claim"]), null);
});

test("media upload job create, cache, claim, complete, and list SQL all include tenant scope", () => {
  const service = read("../src/services/listing-automation.js");
  const create = service.slice(service.indexOf("export async function createOzonSellerMediaUploadJobs"), service.indexOf("export async function claimServerPublishMediaUploadJobs"));
  const claim = service.slice(service.indexOf("export async function claimServerPublishMediaUploadJobs"), service.indexOf("export async function completeServerPublishMediaUploadJob"));
  const complete = service.slice(service.indexOf("export async function completeServerPublishMediaUploadJob"), service.indexOf("export async function listOzonSellerMediaUploadJobs"));
  const list = service.slice(service.indexOf("export async function listOzonSellerMediaUploadJobs"), service.indexOf("export async function searchMaterialPackages"));
  const publishPoll = service.slice(service.indexOf("async function prepareOzonSellerMediaForPublishPayload"), service.indexOf("export async function publishListingTemplateToOzon"));
  assert.match(create, /const tenantId = listingTenantId\(session\)/);
  assert.match(create, /WHERE tenant_id = \? AND \(source_hash = \?/);
  assert.match(create, /INSERT INTO listing_ozon_seller_media_upload_jobs\s+\(tenant_id,/);
  assert.match(claim, /WHERE tenant_id = \? AND \(status IN/);
  assert.match(claim, /WHERE tenant_id = \? AND id IN/);
  assert.match(complete, /WHERE tenant_id = \? AND job_id = \? AND media_job_id = \?/);
  assert.match(list, /const tenantId = listingTenantId\(session\)/);
  assert.match(publishPoll, /WHERE tenant_id = \? AND media_job_id IN/);
  const server = read("../src/server.js");
  assert.match(server, /claimServerPublishMediaUploadJobs\(body \|\| \{\}, tenantId\)/);
  assert.match(server, /completeServerPublishMediaUploadJob\(parts\[4\], parts\[5\], body \|\| \{\}, tenantId\)/);
});

test("media job schema uses tenant-first lookup indexes and an explicit dry-run migration", () => {
  const service = read("../src/services/listing-automation.js");
  const migration = read("../scripts/migrate-tenant-ozon-media-jobs.mjs");
  const packageJson = read("../package.json");
  assert.match(service, /tenant_id VARCHAR\(80\) NOT NULL DEFAULT 'admin'[\s\S]*?uq_listing_seller_media_tenant_job \(tenant_id, media_job_id\)/);
  assert.match(service, /idx_listing_seller_media_tenant_status \(tenant_id, status, updated_at, id\)/);
  assert.match(service, /idx_listing_seller_media_tenant_hash \(tenant_id, source_hash, status, updated_at\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /GET_LOCK\('tenant_ozon_media_jobs_v1'/);
  assert.match(migration, /all pre-tenant media jobs will remain assigned to default tenant admin/);
  assert.match(migration, /Found media jobs with NULL tenant ownership/);
  assert.match(packageJson, /"db:migrate:tenant-ozon-media-jobs": "node scripts\/migrate-tenant-ozon-media-jobs\.mjs"/);
});

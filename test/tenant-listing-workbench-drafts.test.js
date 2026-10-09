import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createListingAutomationRoutes, handleListingAutomationRestRoute } from "../src/server/routes/listingAutomation.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("variant workbench routes pass the authenticated session and scope delete to service", async () => {
  const calls = [];
  const services = {
    listingVariantWorkbenchDrafts: async (...args) => { calls.push(["list", ...args]); return []; },
    saveListingVariantWorkbenchDraft: async (...args) => { calls.push(["save", ...args]); return { id: 1 }; },
    deleteListingVariantWorkbenchDraft: async (...args) => { calls.push(["delete", ...args]); return { ok: true }; }
  };
  const body = { workbench_id: "wb-1", tenant_id: "admin", tenantId: "1", snapshot: { text: "draft" } };
  const routes = createListingAutomationRoutes({ services, readJson: async () => body });
  const session = { personId: 7, tenant: { id: 42, slug: "company-a" } };
  const req = { _session: session };
  await routes["GET /api/listing/variant-workbench-drafts"](req, new URL("https://example.test/?tenant_id=1"));
  await routes["POST /api/listing/variant-workbench-drafts"](req);
  const json = (_res, data) => data;
  await handleListingAutomationRestRoute({
    req: { ...req, method: "DELETE", query: {} }, res: {},
    parts: ["api", "listing", "variant-workbench-drafts", "wb-1"],
    services, readJson: async () => ({}), json
  });
  assert.deepEqual(calls, [
    ["list", { tenant_id: "1" }, session],
    ["save", body, session],
    ["delete", "wb-1", session, "asset-variant-center-wizard"]
  ]);
});

test("only the tenant-scoped workbench draft list, save, and delete routes are opened", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "listing", "variant-workbench-drafts"]],
    ["POST", ["api", "listing", "variant-workbench-drafts"]],
    ["DELETE", ["api", "listing", "variant-workbench-drafts", "wb-1"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
  for (const [method, parts] of [
    ["PUT", ["api", "listing", "variant-workbench-drafts", "wb-1"]],
    ["DELETE", ["api", "listing", "variant-workbench-drafts"]],
    ["GET", ["api", "listing", "variant-workbench-drafts", "wb-1"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("variant workbench draft queries and writes include session tenant scope", () => {
  const service = read("../src/services/listing-automation.js");
  const list = service.slice(service.indexOf("export async function listingVariantWorkbenchDrafts"), service.indexOf("export async function saveListingVariantWorkbenchDraft"));
  const save = service.slice(service.indexOf("export async function saveListingVariantWorkbenchDraft"), service.indexOf("export async function deleteListingVariantWorkbenchDraft"));
  const remove = service.slice(service.indexOf("export async function deleteListingVariantWorkbenchDraft"), service.indexOf("export async function saveListingAiVariantAsset"));
  assert.match(list, /const tenantId = listingTenantId\(session\)/);
  assert.match(list, /\(tenant_id = \? OR tenant_id IS NULL\)/);
  assert.match(list, /tenant_id = \?/);
  assert.match(service, /tenant_id: listingTenantId\(session, body\.tenant_id \|\| body\.tenantId \|\| "admin"\)/);
  assert.match(save, /WHERE \$\{tenantScope\}[\s\S]*?created_by_person_id <=> \?/);
  assert.match(save, /SET tenant_id = \?/);
  assert.match(save, /INSERT INTO listing_variant_workbench_drafts\s+\(tenant_id,/);
  assert.match(remove, /AND \$\{tenantScope\}/);
  assert.match(remove, /created_by_person_id = \?/);
});

test("workbench migration preserves unattributed legacy rows and adds tenant-first indexes", () => {
  const service = read("../src/services/listing-automation.js");
  const migration = read("../scripts/migrate-tenant-listing-workbench-drafts.mjs");
  const packageJson = read("../package.json");
  assert.match(service, /tenant_id VARCHAR\(80\) NULL[\s\S]*?uq_listing_variant_workbench_tenant_owner \(tenant_id, workbench_id, route_name, created_by_person_id\)/);
  assert.match(service, /idx_listing_variant_workbench_tenant_status \(tenant_id, status, updated_at, id\)/);
  assert.match(migration, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(migration, /--mysql-admin-socket/);
  assert.match(migration, /GET_LOCK\('tenant_listing_workbench_drafts_v1'/);
  assert.match(migration, /legacy rows remain NULL and are visible only in the default tenant/);
  assert.doesNotMatch(migration, /UPDATE listing_variant_workbench_drafts SET tenant_id/);
  assert.match(migration, /DROP INDEX \$\{OLD_UNIQUE_INDEX\}/);
  assert.match(packageJson, /"db:migrate:tenant-listing-workbench": "node scripts\/migrate-tenant-listing-workbench-drafts\.mjs"/);
});

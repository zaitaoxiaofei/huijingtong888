import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("listing templates and core draft operations expose only tenant-scoped routes", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "listing", "templates"]],
    ["GET", ["api", "listing", "templates", "12"]],
    ["POST", ["api", "listing", "templates"]],
    ["PUT", ["api", "listing", "templates", "12"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);

  for (const [method, parts] of [
    ["POST", ["api", "listing", "templates", "from-collected"]],
    ["GET", ["api", "listing", "templates", "not-numeric"]],
    ["PUT", ["api", "listing", "templates", "not-numeric"]],
    ["POST", ["api", "listing", "drafts", "batch-publish"]],
    ["POST", ["api", "listing", "drafts", "from-inventory-product"]],
    ["POST", ["api", "listing", "drafts", "12", "shop-copies", "extra"]],
    ["GET", ["api", "listing", "drafts", "not-numeric"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);

  for (const [method, parts] of [
    ["GET", ["api", "listing", "drafts"]],
    ["POST", ["api", "listing", "drafts"]],
    ["GET", ["api", "listing", "drafts", "12"]],
    ["PUT", ["api", "listing", "drafts", "12"]],
    ["DELETE", ["api", "listing", "drafts", "12"]],
    ["PUT", ["api", "listing", "drafts", "12", "development-meta"]],
    ["GET", ["api", "listing", "drafts", "12", "shop-copies"]],
    ["POST", ["api", "listing", "drafts", "12", "shop-copies"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
});

test("listing template list, detail, create, update, and collected-template reuse carry session tenant", () => {
  const service = read("../src/services/listing-automation.js");
  const list = service.slice(service.indexOf("export async function listingCategoryTemplates"), service.indexOf("export async function listingCategoryTemplateDetail"));
  const create = service.slice(service.indexOf("export async function createListingCategoryTemplate"), service.indexOf("export async function createListingTemplateFromCollectedProduct"));
  const collected = service.slice(service.indexOf("export async function createListingTemplateFromCollectedProduct"), service.indexOf("function firstCollectedValue"));
  const update = service.slice(service.indexOf("export async function updateListingCategoryTemplate"), service.indexOf("function sameTimestamp"));
  const raw = service.slice(service.indexOf("async function listingCategoryTemplateRaw"), service.indexOf("async function listingCopyJob(id)"));
  assert.match(list, /const tenantId = listingTenantId\(session\)/);
  assert.match(list, /t\.tenant_id = \?/);
  assert.match(list, /creator_members\.tenant_id = \?/);
  assert.match(raw, /creator_members\.tenant_id = \?/);
  assert.match(create, /\(tenant_id, ozon_category_id,/);
  assert.match(create, /listingTenantId\(session\)/);
  assert.match(collected, /AND \$\{listingTenantId\(session\) === "admin" \?/);
  assert.match(collected, /WHERE id = \? AND \$\{listingTenantId\(session\) === "admin" \?/);
  assert.match(collected, /\(tenant_id, ozon_category_id,/);
  assert.match(update, /WHERE id = \? AND status <> 'deleted' AND \$\{tenantScope\}/);
  assert.match(update, /const tenantId = listingTenantId\(session\)/);
  assert.match(create, /recordOzonCategoryUsage\([\s\S]*?\}, session\)/);
  assert.match(update, /recordOzonCategoryUsage\([\s\S]*?\}, session\)/);
  assert.match(raw, /const tenantId = listingTenantId\(session\)/);
  assert.match(raw, /WHERE t\.id = \? AND \$\{tenantScope\}/);
});

test("category usage writes and per-tenant sync queries are tenant scoped", () => {
  const service = read("../src/services/listing-automation.js");
  const usage = service.slice(service.indexOf("async function recordOzonCategoryUsage"), service.indexOf("function parseOzonCategoryKey"));
  const sync = service.slice(service.indexOf("async function usedOzonCategoriesForSync"), service.indexOf("export function importInfoStatus"));
  assert.match(usage, /const tenantId = listingTenantId\(session\)/);
  assert.match(usage, /INSERT INTO ozon_category_usage\s*\(tenant_id,/);
  assert.match(usage, /VALUES \(\?, \?, \?, \?, \?, \?, 1, CURRENT_TIMESTAMP\)/);
  assert.match(sync, /const tenantId = session \? listingTenantId\(session\) : null/);
  assert.match(sync, /FROM listing_category_templates\s+WHERE status <> 'deleted' AND ozon_category_id LIKE '%:%' AND \$\{tenantScope\}/);
  assert.match(sync, /FROM ozon_category_usage\s+WHERE \$\{tenantScope\}/);
  assert.match(sync, /\[\.\.\.tenantParams, \.\.\.tenantParams, limit\]/);
});

test("offer identifier availability checks cannot reveal or reserve another tenant's records", () => {
  const service = read("../src/services/listing-automation.js");
  const check = service.slice(service.indexOf("async function listingOfferIdExistsInTenant"), service.indexOf("export async function listingOzonCategories"));
  assert.match(check, /const tenantId = listingTenantId\(session\)/);
  assert.match(check, /const tenantScope = \(alias\) => tenantId === "admin"/);
  assert.match(check, /JOIN shops s ON s\.id = op\.shop_id AND \$\{tenantScope\("s"\)\}/);
  assert.match(check, /listing_publish_records r[\s\S]*?\$\{tenantScope\("r"\)\}/);
  assert.match(check, /listing_shop_copies c[\s\S]*?\$\{tenantScope\("c"\)\}/);
  assert.match(check, /listing_drafts d[\s\S]*?\$\{tenantScope\("d"\)\}/);
});

test("listing draft and shop-copy service paths apply tenant ownership before enabling core routes", () => {
  const service = read("../src/services/listing-automation.js");
  const drafts = service.slice(service.indexOf("export async function listingDrafts"), service.indexOf("export async function listingDraftDetail"));
  const create = service.slice(service.indexOf("export async function createListingDraft"), service.indexOf("async function prepareListingDraftUpdate"));
  const update = service.slice(service.indexOf("async function prepareListingDraftUpdate"), service.indexOf("async function writeListingDraftUpdate"));
  const remove = service.slice(service.indexOf("export async function deleteListingDraft"), service.indexOf("async function listingDraft(id"));
  const access = service.slice(service.indexOf("async function assertDraftAccess"), service.indexOf("async function repairAiVariantDraftTemplateReference"));
  const sourceProductOwnership = service.slice(service.indexOf("async function assertDraftSourceProductTenant"), service.indexOf("async function insert"));
  assert.match(drafts, /COALESCE\(d\.tenant_id, 'admin'\) = \?/);
  assert.match(drafts, /COALESCE\(t\.tenant_id, 'admin'\) = COALESCE\(d\.tenant_id, 'admin'\)/);
  assert.match(drafts, /relatedTenantScope\("c_shop"\)/);
  assert.match(drafts, /relatedTenantScope\("r"\)/);
  assert.match(drafts, /publish_record_count/);
  assert.match(drafts, /creator_members\.tenant_id = \?/);
  assert.match(create, /INSERT INTO listing_drafts\s*\(tenant_id, template_id/);
  assert.match(create, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(create, /assertDraftSourceProductTenant\(sourceProductId, tenantId\)/);
  assert.match(update, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(update, /assertDraftSourceProductTenant\(sourceProductId, tenantId\)/);
  assert.match(remove, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(remove, /INSERT INTO listing_shop_copies\s*\(tenant_id, draft_id/);
  assert.match(access, /COALESCE\(d\.tenant_id, 'admin'\) = \?/);
  assert.match(access, /creator_members\.tenant_id = \?/);
  assert.match(access, /COALESCE\(t\.tenant_id, 'admin'\) = COALESCE\(d\.tenant_id, 'admin'\)/);
  const session = { tenant: { id: 42, slug: "company-a" } };
  assert.match(sourceProductOwnership, /p\.tenant_id IS NULL OR p\.tenant_id = \(SELECT id FROM tenants WHERE slug = 'default'/);
  assert.match(sourceProductOwnership, /p\.tenant_id = \?/);
  assert.match(sourceProductOwnership, /products\.tenant_id 尚未迁移/);
});

test("AI draft inheritance, deduplication, project candidates, and repair jobs stay within tenant ownership", () => {
  const service = read("../src/services/listing-automation.js");
  const aiDraft = service.slice(service.indexOf("export async function createAiVariantListingDraftLightweight"), service.indexOf("export async function createInventoryProductListingDraft"));
  const projectCandidates = service.slice(service.indexOf("async function listingDraftProjectCandidates"), service.indexOf("export async function listingPublishRecordDetail"));
  const aiHelpers = service.slice(service.indexOf("async function findExistingAiVariantDraft"), service.indexOf("function canonicalDraftMainImageUrl"));
  const collectorTemplateLookup = service.slice(service.indexOf("async function findCollectorTemplateForAiVariantDraft"), service.indexOf("async function buildShopCopy"));
  const collectorCategoryHistory = service.slice(service.indexOf("async function enrichCollectedProductCategoryFromHistory"), service.indexOf("function parseCollectedPayloadJson"));
  const mediaRepair = service.slice(service.indexOf("export async function repairAiOptimizationListingMedia"), service.indexOf("function cleanColorCandidateValue"));
  const colorRepair = service.slice(service.indexOf("export async function repairListingColorFieldPollution"), service.indexOf("export async function deleteListingDraft"));
  assert.match(aiDraft, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(aiDraft, /INSERT INTO listing_drafts\s*\(tenant_id, template_id/);
  assert.match(aiDraft, /COALESCE\(tenant_id, 'admin'\) = \?"/);
  assert.match(aiHelpers, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(collectorTemplateLookup, /const tenantId = listingTenantId\(session\)/);
  assert.match(collectorTemplateLookup, /WHERE tenant_id = \?/);
  assert.match(collectorCategoryHistory, /WHERE tenant_id = \? AND status <> 'deleted'/);
  assert.match(collectorCategoryHistory, /\[String\(tenantId \|\| "admin"\), sku, title\]/);
  assert.match(projectCandidates, /COALESCE\(d\.tenant_id, 'admin'\) = \?/);
  assert.match(projectCandidates, /COALESCE\(c_shop\.tenant_id, 'admin'\) = COALESCE\(d\.tenant_id, 'admin'\)/);
  assert.match(mediaRepair, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(colorRepair, /COALESCE\(tenant_id, 'admin'\) = \?/);
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["POST", ["api", "listing", "drafts", "ai-variant-lightweight"]],
    ["POST", ["api", "listing", "drafts", "repair-media-contamination"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "draft-projects"], "GET").allowed, true);
});

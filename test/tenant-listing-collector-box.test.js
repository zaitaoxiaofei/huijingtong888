import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createListingAutomationRoutes } from "../src/server/routes/listingAutomation.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("collector-box routes forward the authenticated tenant session", async () => {
  const calls = [];
  const services = {
    collectorBoxProducts: async (...args) => { calls.push(["list", ...args]); return { rows: [] }; },
    deleteCollectorBoxProducts: async (...args) => { calls.push(["delete", ...args]); return { ok: true }; },
    collectorBoxProductDetail: async (...args) => { calls.push(["detail", ...args]); return { sku: "sku-a" }; }
  };
  const body = { skus: ["sku-a"], tenant_id: "1", tenantId: "admin" };
  const routes = createListingAutomationRoutes({ services, readJson: async () => body });
  const session = { tenant: { id: 42, slug: "company-a" } };
  const req = { _session: session, query: { tenant_id: "1" } };
  await routes["GET /api/listing/collector-box"](req);
  await routes["DELETE /api/listing/collector-box"](req);
  assert.deepEqual(calls, [["list", req.query, session], ["delete", body, session]]);
});

test("collector-box isolation opens only tenant-scoped list, detail, and delete routes", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "listing", "collector-box"]],
    ["GET", ["api", "listing", "collector-box", "sku-a"]],
    ["DELETE", ["api", "listing", "collector-box"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);
  for (const [method, parts] of [
    ["POST", ["api", "listing", "collector-box"]],
    ["PUT", ["api", "listing", "collector-box", "sku-a", "edit"]],
    ["GET", ["api", "listing", "collector-box", "sku-a", "diagnostics"]],
    ["DELETE", ["api", "listing", "collector-box", "sku-a"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("collector-box storage reads and deletes use session tenant, never client selectors", () => {
  const service = read("../src/services/listing-automation.js");
  const list = service.slice(service.indexOf("export async function collectorBoxProducts"), service.indexOf("export async function collectorBoxProductDetail"));
  const detail = service.slice(service.indexOf("export async function collectorBoxProductDetail"), service.indexOf("export async function deleteCollectorBoxProducts"));
  const deletion = service.slice(service.indexOf("export async function deleteCollectorBoxProducts"), service.indexOf("export async function saveCollectorBoxEdit"));
  assert.match(service, /function listingTenantId\(session, fallback = "admin"\)/);
  assert.match(service, /return tenant\.slug === "default" \? "admin" : String\(tenant\.id\)/);
  assert.match(list, /const tenantId = listingTenantId\(session\)/);
  assert.doesNotMatch(list, /query\.tenant_?id/);
  assert.match(list, /WHERE \$\{whereSql\}/);
  assert.match(list, /tenantId === "admin" && pageSkus\.length/);
  assert.match(list, /selection_product_id: null, listing_template_id: null/);
  assert.match(detail, /listingTenantId\(session, tenantId\)/);
  assert.match(detail, /normalizedTenantId !== "admin"[\s\S]*?normalized\.listing_template_id = null/);
  assert.match(deletion, /const tenantId = listingTenantId\(session\)/);
  assert.doesNotMatch(deletion, /body\.tenant_?id/);
  assert.match(deletion, /WHERE tenant_id = \? AND sku IN/);
});

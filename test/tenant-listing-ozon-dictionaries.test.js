import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("tenant Ozon category dictionaries expose only exact read and sync routes", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "listing", "ozon-category-attributes"]],
    ["GET", ["api", "listing", "ozon-attribute-values"]],
    ["POST", ["api", "listing", "ozon-category-attributes", "sync"]],
    ["POST", ["api", "listing", "ozon-attribute-values", "sync"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, true);

  for (const [method, parts] of [
    ["DELETE", ["api", "listing", "ozon-category-attributes"]],
    ["PUT", ["api", "listing", "ozon-attribute-values"]],
    ["POST", ["api", "listing", "ozon-category-attributes", "unexpected"]],
    ["POST", ["api", "listing", "ozon-categories", "sync"]],
    ["POST", ["api", "listing", "ozon-category-cache", "refresh"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
});

test("Ozon API shop lookup always applies the active tenant scope before an optional shop selector", () => {
  const lookup = service.slice(service.indexOf("async function resolveOzonApiShop"), service.indexOf("async function attachCachedAttributeValues"));
  assert.match(lookup, /const tenantId = listingTenantId\(session\)/);
  assert.match(lookup, /tenant_id = \(SELECT id FROM tenants WHERE slug = 'default' LIMIT 1\) OR tenant_id IS NULL/);
  assert.match(lookup, /: "tenant_id = \?"/);
  assert.match(lookup, /const params = tenantId === "admin" \? \[\] : \[tenantId\]/);
  assert.match(lookup, /if \(id\) params\.push\(id\)/);
  assert.match(lookup, /WHERE \$\{tenantScope\}[\s\S]*?AND id = \?/);
  assert.equal((lookup.match(/AND tenant_id = \?/g) || []).length, 0);
});

test("all Ozon category and attribute refresh paths pass the authenticated session into shop lookup", () => {
  for (const name of [
    "syncListingOzonCategories",
    "resolveOzonCategoryFromSku",
    "syncListingOzonCategoryAttributes",
    "refreshOzonCategoryCache",
    "syncListingOzonAttributeValues"
  ]) {
    const start = service.indexOf(`export async function ${name}`);
    assert.notEqual(start, -1, `${name} is present`);
    const body = service.slice(start, service.indexOf("\n}\n", start));
    assert.match(body, /resolveOzonApiShop\(body\.shop_id \|\| body\.shopId, session\)/, name);
  }
});

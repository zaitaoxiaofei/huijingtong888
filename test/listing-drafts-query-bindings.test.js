import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";
import { createListingFrozenReadScope } from "../src/services/listing-frozen-content.js";

const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const draftsSource = service.slice(service.indexOf("export async function listingDrafts("), service.indexOf("export async function listingDevelopmentReview("));
const queryHelpers = service.slice(service.indexOf("function listingTenantId("), service.indexOf("async function assertDraftSourceProductTenant("));

function draftListReader() {
  const calls = [];
  const context = vm.createContext({
    listingTenantLookup,
    createListingFrozenReadScope,
    ensureListingListReadSchema: async () => {},
    mysqlQuery: async (sql, params) => {
      assert.equal(params.length, (sql.match(/\?/g) || []).length, "every SQL placeholder must have exactly one binding");
      calls.push({ sql, params: [...params] });
      return sql.includes("SELECT COUNT(*) AS total") ? [{ total: 0 }] : [];
    }
  });
  vm.runInContext(`${queryHelpers}\n${draftsSource.replace("export ", "")}`, context);
  return { listingDrafts: context.listingDrafts, calls };
}

const filters = [
  { label: "without filters", query: {}, params: [] },
  { label: "keyword", query: { keyword: "Seat" }, params: Array(7).fill("%seat%") },
  { label: "shop", query: { shopId: "73" }, params: [73] },
  { label: "keyword and shop", query: { keyword: "Seat", shopId: "73" }, params: [...Array(7).fill("%seat%"), 73] }
];

for (const status of ["all", "editing", "waiting"]) {
  for (const lightweight of ["1", "0"]) {
    for (const filter of filters) {
      test(`project drafts ${status}, lightweight=${lightweight}, ${filter.label} keep filters and pagination bound correctly`, async () => {
        const { listingDrafts, calls } = draftListReader();
        const result = await listingDrafts({
          paged: "1", projectOnly: "1", page: "1", pageSize: "20", status, lightweight, ...filter.query
        }, { tenant: { id: 42, slug: "company-a" } });

        assert.equal(result.total, 0);
        assert.equal(result.page, 1);
        assert.equal(result.pageSize, 20);
        assert.equal(result.rows.length, 0);
        assert.equal(calls.length, 2);
        const count = calls.find(({ sql }) => sql.includes("SELECT COUNT(*) AS total"));
        const list = calls.find(({ sql }) => !sql.includes("SELECT COUNT(*) AS total"));
        const expected = lightweight === "1" ? ["42", ...filter.params] : [42, "42", ...filter.params];
        assert.deepEqual(count.params, expected);
        assert.deepEqual(list.params, [...expected, 20, 0]);
        assert.match(list.sql, /LIMIT \? OFFSET \?/);
        for (const { sql } of calls) {
          assert.match(sql, /d\.tenant_id = \?/);
          if (lightweight === "0") assert.match(sql, /t\.tenant_id = d\.tenant_id COLLATE utf8mb4_unicode_ci/);
          else assert.doesNotMatch(sql, /JOIN listing_category_templates/);
          if (filter.query.keyword) assert.match(sql, /t_filter\.tenant_id = d\.tenant_id COLLATE utf8mb4_unicode_ci/);
          if (status !== "all") assert.match(sql, /c_project\.tenant_id = d\.tenant_id COLLATE utf8mb4_unicode_ci/);
          if (status === "editing") assert.match(sql, /NOT EXISTS \(SELECT 1 FROM listing_shop_copies c_project WHERE c_project\.draft_id = d\.id/);
          if (status === "waiting") assert.match(sql, /EXISTS \(SELECT 1 FROM listing_shop_copies c_project WHERE c_project\.draft_id = d\.id[\s\S]*c_project\.status = 'prepared'/);
          if (filter.query.shopId) assert.match(sql, /c_shop\.shop_id = \?/);
        }
      });
    }
  }
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const listingDraftsSource = source.match(/export async function listingDrafts\(query = \{\}, session\) \{[\s\S]*?\n\}/)?.[0] || "";

test("draft inbox starts shop options and records in parallel", () => {
  assert.match(viewSource, /await Promise\.all\(\[loadShops\(\), loadPeople\(\), loadRecords\(\)\]\)/);
});

test("listing drafts use index-friendly updated_at range filters", () => {
  assert.match(listingDraftsSource, /where\.push\("d\.updated_at >= \?"\)/);
  assert.match(listingDraftsSource, /params\.push\(`\$\{startDate\} 00:00:00`\)/);
  assert.match(listingDraftsSource, /where\.push\("d\.updated_at < DATE_ADD\(\?, INTERVAL 1 DAY\)"\)/);
  assert.doesNotMatch(listingDraftsSource, /DATE\(d\.updated_at\) >= \?/);
  assert.doesNotMatch(listingDraftsSource, /DATE\(d\.updated_at\) <= \?/);
});

test("draft inbox can explicitly sort by creation time without changing other callers", () => {
  assert.match(listingDraftsSource, /const sortBy = String\(query\.sortBy \|\| query\.sort_by \|\| "updated_at"\)/);
  assert.match(listingDraftsSource, /const sortColumn = sortBy === "created_at" \? "d\.created_at" : "d\.updated_at";/);
  assert.match(listingDraftsSource, /ORDER BY \$\{sortColumn\} DESC, d\.id DESC/);
  assert.match(viewSource, /params\.set\("sortBy", "created_at"\);/);
  assert.match(viewSource, /isDraftMode \? '生成时间' : '更新时间'/);
});

test("listing drafts avoid unnecessary joins for paged lightweight queries", () => {
  assert.match(listingDraftsSource, /const fromSqlJoins = \[\s*"LEFT JOIN listing_category_templates t ON t\.id = d\.template_id"\s*\]/);
  assert.match(listingDraftsSource, /if \(!paged \|\| !lightweight\) \{\s*fromSqlJoins\.push\("LEFT JOIN people p ON p\.id = d\.created_by_person_id"\);/s);
  assert.doesNotMatch(listingDraftsSource, /GROUP BY draft_id/);
  assert.match(listingDraftsSource, /if \(projectOnly && \(!status \|\| status === "all"\)\)/);
  assert.match(listingDraftsSource, /NOT EXISTS \(SELECT 1 FROM listing_shop_copies c_project_any WHERE c_project_any\.draft_id = d\.id\)/);
  assert.match(listingDraftsSource, /EXISTS \(SELECT 1 FROM listing_shop_copies c_project_visible WHERE c_project_visible\.draft_id = d\.id AND c_project_visible\.status IN \('prepared', 'blocked'\)\)/);
});

test("listing drafts keep status predicates index friendly", () => {
  assert.match(listingDraftsSource, /const where = \["COALESCE\(d\.status, ''\) <> 'deleted'"\]/);
  assert.match(listingDraftsSource, /where\.push\("d\.status = \?"\)/);
  assert.doesNotMatch(listingDraftsSource, /LOWER\(TRIM\(COALESCE\(d\.status/);
});

test("paged lightweight drafts read stored list projections instead of parsing large JSON", () => {
  const lightweightPageSource = listingDraftsSource.match(/if \(paged && lightweight\) \{[\s\S]*?const rowsSql = lightweight/)?.[0] || "";
  assert.match(lightweightPageSource, /JSON_ARRAY\(d\.list_image_url\) AS source_images_json/);
  assert.match(lightweightPageSource, /d\.list_price AS draft_variant_price/);
  assert.match(lightweightPageSource, /d\.list_image_url AS draft_template_primary_image/);
  assert.doesNotMatch(lightweightPageSource, /JSON_EXTRACT\(d\.template_payload_json/);
});

test("listing draft schema stores image and price projections in one migration", () => {
  assert.match(source, /list_image_url VARCHAR\(2048\) GENERATED ALWAYS AS/);
  assert.match(source, /list_price VARCHAR\(64\) GENERATED ALWAYS AS/);
  assert.match(source, /await ensureMysqlColumns\("listing_drafts", \[\{/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const automationSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const draftBoxSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("draft box opens selected drafts in the existing multi-variant listing editor", () => {
  assert.match(draftBoxSource, /@click="batchOpenDraftsForListing">批量编辑/);
  assert.match(draftBoxSource, /draftIds:\s*rows\.map\(\(row\) => row\.id\)\.join\(","\)/);
  assert.match(automationSource, /const routeDraftIds = computed/);
  assert.match(automationSource, /Promise\.all\(routeDraftIds\.value\.map/);
  assert.match(automationSource, /templateEditor\.variants = rows\.map\(batchDraftVariant\)/);
});

test("batch editor keeps one immutable draft identity per variant row", () => {
  assert.match(automationSource, /_draft_id:\s*Number\(draft\.id\)/);
  assert.match(automationSource, /_template_id:\s*Number\(draft\.template_id/);
  assert.match(automationSource, /rows\.length !== expectedIds\.length/);
  assert.match(automationSource, /actualIds\.some\(\(id\) => !expectedIds\.includes\(id\)\)/);
  assert.match(automationSource, /批量草稿编辑中不能删除草稿行/);
});

test("batch draft loading and saving enforce one Ozon category", () => {
  assert.match(automationSource, /function draftCategoryKey\(draft = \{\}\)/);
  assert.match(automationSource, /descriptionCategoryId > 0 && typeId > 0/);
  assert.match(automationSource, /批量编辑仅支持相同 Ozon 类目的草稿/);
  assert.match(serviceSource, /function listingDraftPayloadCategoryKey\(payload = \{\}\)/);
  assert.match(serviceSource, /Batch draft editing only supports drafts in the same Ozon category/);
});

test("batch draft updates use optimistic checks and one database transaction", () => {
  assert.match(routeSource, /"POST \/api\/listing\/drafts\/batch-update"/);
  assert.match(serviceSource, /export async function updateListingDraftsBatch/);
  assert.match(serviceSource, /!sameTimestamp\(expected, current\)/);
  assert.match(serviceSource, /await withMysqlTransaction\(async \(connection\) =>/);
  assert.match(serviceSource, /connection\.execute\(sql, params\)/);
});

test("batch rows preserve their own effective images and save one variant per draft", () => {
  assert.match(automationSource, /draft\.effective_images/);
  assert.match(automationSource, /typeof item === "string" \? \{ url: item \}/);
  assert.match(automationSource, /\.filter\(\(item\) => item\.url\)/);
  assert.match(automationSource, /variant\.images = images/);
  assert.match(automationSource, /variant\.images_manually_edited = true/);
  assert.match(automationSource, /variants:\s*\[variant\]/);
  assert.match(automationSource, /apiClient\.post\("\/api\/listing\/drafts\/batch-update", \{ items \}\)/);
});

test("single draft loading prefers the saved draft weight over stale template dimensions", () => {
  assert.match(automationSource, /templateEditor\.weight_g = Number\(draft\.weight_g \|\| templateEditor\.weight_g \|\| 0\)/);
});

test("tags, weight, and dimensions are independent for every variant row", () => {
  assert.match(automationSource, /weight:\s*true/);
  assert.match(automationSource, /dimensions:\s*true/);
  assert.match(automationSource, /tags:\s*true/);
  assert.match(automationSource, /function ensureIndependentVariantFields\(options = \{\}\)/);
  assert.match(automationSource, /main_tags:\s*draftTags/);
  assert.match(automationSource, /weight_g:\s*variantFieldMode\.weight \? item\.weight_g/);
  assert.match(automationSource, /length_mm:\s*variantFieldMode\.dimensions \? item\.length_mm/);
  assert.match(automationSource, /main_tags:\s*variantFieldMode\.tags \? item\.main_tags/);
  assert.match(automationSource, /function firstVariantPackageValues\(variants = templateEditor\.variants\)/);
});

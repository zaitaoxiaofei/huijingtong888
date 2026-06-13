import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");

test("listing draft media contamination repair is exposed as a dry-run capable service", () => {
  assert.match(source, /export async function repairListingDraftMediaContamination/);
  assert.match(source, /const apply = body\.apply === true \|\| body\.dryRun === false \|\| body\.dry_run === false/);
  assert.match(routeSource, /POST \/api\/listing\/drafts\/repair-media-contamination/);
  assert.match(runtimeSource, /repairListingDraftMediaContamination/);
});

test("listing draft detail edits can update the existing draft row", () => {
  assert.match(source, /export async function updateListingDraft/);
  assert.match(source, /UPDATE listing_drafts[\s\S]*source_images_json = \?/);
  assert.match(routeSource, /req\.method === "PUT" && parts\[2\] === "drafts" && parts\[3\]/);
  assert.match(routeSource, /services\.updateListingDraft\(Number\(parts\[3\]\), await readJson\(req\), req\._session\)/);
  assert.match(runtimeSource, /updateListingDraft/);
});

test("listing draft repair only updates rows with repairable media pollution", () => {
  const repairSource = source.match(/function buildDraftMediaRepairPlan[\s\S]*?function collectDraftMediaFields/)?.[0] || "";
  assert.match(repairSource, /manual-image-bloat/);
  assert.match(repairSource, /video-in-image-field/);
  assert.match(repairSource, /object-string/);
  assert.match(repairSource, /const hasRepairableIssue = issues\.some\(\(issue\) => issue !== "source-template-primary-diff"\)/);
  assert.match(repairSource, /const changed = hasRepairableIssue &&/);
});

test("draft save paths drop duplicated user facts images while preserving clean snapshots", () => {
  assert.match(source, /sanitizeDraftManualFactsMedia\(objectValue\(body\.manual_facts \|\| body\.manualFacts\), images, \{ dropImages: true \}\)/);
  assert.match(source, /sanitizeDraftManualFactsMedia\(objectValue\(payload\.manual_facts \|\| payload\.manualFacts\), sourceImages, \{ dropImages: true \}\)/);
  assert.match(source, /sanitizeDraftManualFactsMedia\(\{\s*[\s\S]*normalizedTemplate\.editable_payload[\s\S]*\}, payload\.source_images, \{ forceImages: true \}\)/);
});

test("manually edited draft variant images do not fall back to template images", () => {
  assert.match(source, /const variantImagesEdited = Boolean\(variant\?\.images_manually_edited \|\| variant\?\.image_edit_intent === "manual"\)/);
  assert.match(source, /const rawVariantImages = variantImagesEdited \? \(variant\.images \|\| \[\]\)/);
  assert.match(source, /variantImagesEdited \? variantImages : \(variantImages\.length \? variantImages : cleanImages\)/);
  assert.match(source, /images: normalizeImages\(\(item\.images_manually_edited \|\| item\.image_edit_intent === "manual"\) \? \(item\.images \|\| \[\]\) : \(item\.images \|\| finalImages\)\)/);
});

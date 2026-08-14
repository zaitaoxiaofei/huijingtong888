import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const listingSource = fs.readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const aiWorkflowSource = fs.readFileSync(new URL("../src/server/services/ai/aiWorkflowService.js", import.meta.url), "utf8");
const aiVariantLabSource = fs.readFileSync(new URL("../src/services/ai-variant-lab.js", import.meta.url), "utf8");
const productDialogSource = fs.readFileSync(new URL("../frontend/admin/components/inventory/ProductCreateEditDialog.vue", import.meta.url), "utf8");
const teamPlanSource = fs.readFileSync(new URL("../frontend/admin/views/team/TeamPlanView.vue", import.meta.url), "utf8");
const shopVariantSource = fs.readFileSync(new URL("../frontend/admin/views/listing/ShopAssetVariantCenter.vue", import.meta.url), "utf8");
const assetVariantEngineSource = fs.readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");

test("collector box sync stores remote media references while durable detail saves still archive media", () => {
  assert.match(listingSource, /archivedBody = await archiveCollectedProductMedia\(archivedBody, session\)/);
  assert.match(listingSource, /media_storage_mode: "remote_url_reference"/);
  assert.doesNotMatch(listingSource, /archivedProduct = await archiveCollectedProductMedia\(product, null\)/);
  assert.match(listingSource, /force_archive_remote: true/);
  assert.match(listingSource, /require_managed_oss: true/);
  assert.match(listingSource, /storage_prefix: "collector-media"/);
});

test("collector box editing defers unavailable Ozon image archival without weakening other durable saves", () => {
  assert.match(listingSource, /if \(!options\.allowMediaArchiveFailure \|\| !archiveFailure\) throw error;/);
  assert.match(listingSource, /media_archive_warning: mediaArchiveWarning/);
  assert.match(listingSource, /createListingTemplateFromCollectedProduct\(normalized\.templatePayload, session, \{\s*allowMediaArchiveFailure: true,\s*deferMediaArchive: true\s*\}\)/);
  assert.match(listingSource, /const payload = deferMediaArchive\s*\? collectedPayload\s*:\s*await materializeListingTemplateMediaForDraftSafety/);
});

test("unused AI images use a temporary OSS prefix and selected images are promoted", () => {
  assert.match(aiWorkflowSource, /prefix: "ai-unused"/);
  assert.match(listingSource, /isManagedOssObjectUrl\(sourceUrl, \{ prefix: "ai-unused" \}\)/);
  assert.match(listingSource, /metadata\.storage_prefix \|\| metadata\.storagePrefix \|\| mediaObjectPrefixForRetention\(\{/);
});

test("video source routing is explicit while final videos remain permanent", () => {
  assert.match(listingSource, /mediaObjectPrefixForRetention\(\{/);
  assert.match(listingSource, /role: mediaRole/);
});

test("AI material text compositions are stored as permanent listing media", () => {
  assert.match(aiVariantLabSource, /putContentAddressedObject\(composedBuffer, \{/);
  assert.match(aiVariantLabSource, /prefix: "listing-media"/);
  assert.match(aiVariantLabSource, /if \(stored\) \{[\s\S]*url: stored\.url/);
});

test("inventory product images upload to OSS instead of being embedded as base64", () => {
  assert.match(productDialogSource, /uploadListingMedia\(rawFile, \{/);
  assert.match(productDialogSource, /role: "inventory_product_image"/);
  assert.doesNotMatch(productDialogSource, /form\.image_url = dataUrl/);
});

test("team candidate images upload to OSS instead of being embedded as base64", () => {
  assert.match(teamPlanSource, /source_module: "team_candidate"/);
  assert.match(teamPlanSource, /role: "team_candidate_image"/);
  assert.doesNotMatch(teamPlanSource, /taskForm\.image_url = String\(reader\.result/);
});

test("asset variant source images store OSS URLs instead of base64 in background jobs", () => {
  assert.match(shopVariantSource, /source_module: "asset_variant_source"/);
  assert.match(shopVariantSource, /role: "asset_variant_source_image"/);
  assert.doesNotMatch(shopVariantSource, /async function fileToDataUrl/);
});

test("tail template images use permanent OSS storage before local fallback", () => {
  assert.match(assetVariantEngineSource, /putContentAddressedObject\(buffer, \{/);
  assert.match(assetVariantEngineSource, /prefix: "listing-media"/);
  assert.match(assetVariantEngineSource, /if \(stored\) return stored\.url/);
});

test("asset variants reuse permanent detail and tail URLs without generating duplicate files", () => {
  assert.match(assetVariantEngineSource, /reusablePermanentMediaResult\(source, "detail", index \+ 1\)/);
  assert.match(assetVariantEngineSource, /reusablePermanentMediaResult\(tailImageUrl, "tail", 1\)/);
  assert.match(assetVariantEngineSource, /reused: true/);
});

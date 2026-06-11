import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("AI variant templates materialize media before template insert", () => {
  assert.match(serviceSource, /let payload = normalizeTemplatePayload\(body\)/);
  assert.match(serviceSource, /payload = await materializeAiOptimizationTemplateMedia\(payload, session\)/);
  assert.match(serviceSource, /async function materializeAiOptimizationTemplateMedia/);
  assert.match(serviceSource, /syncAiOptimizationTemplateImages\(/);
  assert.match(serviceSource, /registerListingMediaAsset\(/);
  assert.match(serviceSource, /ensureListingMediaPublicUrl\(/);
});

test("AI variant drafts materialize source images before draft insert", () => {
  assert.match(serviceSource, /materializeAiOptimizationDraftMedia\(normalizeDraftPayload\(body\), session\)/);
  assert.match(serviceSource, /source_images: sourceImages/);
  assert.match(serviceSource, /role: "draft_source_image"/);
});

test("listing media public sync has a bounded timeout", () => {
  assert.match(serviceSource, /const LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS = 20000/);
  assert.match(serviceSource, /signal: AbortSignal\.timeout\(LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS\)/);
});

test("AI variant save path emits segmented performance logs", () => {
  assert.match(serviceSource, /function logAiVariantSavePerf/);
  assert.match(serviceSource, /backend\.template\.materialize_media/);
  assert.match(serviceSource, /backend\.draft\.normalize_and_materialize/);
  assert.match(serviceSource, /backend\.media\.url/);
  assert.match(serviceSource, /backend\.media\.public_sync/);
});

test("AI variant lightweight draft save skips full media materialization and protects sibling variants", () => {
  assert.match(serviceSource, /export async function createAiVariantListingDraftLightweight/);
  assert.match(serviceSource, /backend\.ai_variant_light_draft\.start/);
  assert.match(serviceSource, /function findExistingAiVariantDraft/);
  assert.match(serviceSource, /if \(!resultId\) return null/);
  const lightweightSource = serviceSource.match(/export async function createAiVariantListingDraftLightweight[\s\S]*?function applyAiVariantDraftPatch/)?.[0] || "";
  assert.doesNotMatch(lightweightSource, /materializeAiOptimizationTemplateMedia|materializeAiOptimizationDraftMedia/);
});

test("AI variant lightweight draft save writes an editable template snapshot", () => {
  const lightweightSource = serviceSource.match(/export async function createAiVariantListingDraftLightweight[\s\S]*?function applyAiVariantDraftPatch/)?.[0] || "";
  assert.match(lightweightSource, /upsertAiVariantListingDraftTemplate\(/);
  assert.match(lightweightSource, /payload\.template_id = draftTemplateId/);
  assert.match(serviceSource, /source_type, source_ozon_sku, source_raw_json,[\s\S]*'ai_optimization_v2_lightweight'/);
  assert.match(serviceSource, /function syncAiVariantTextAttributes/);
  assert.match(serviceSource, /item\.value = normalizedValue/);
  assert.match(serviceSource, /SELECT id, template_id[\s\S]*FROM listing_drafts/);
});

test("AI variant draft detail repairs stale base template references", () => {
  assert.match(serviceSource, /function repairAiVariantDraftTemplateReference/);
  assert.match(serviceSource, /template_source_type/);
  assert.match(serviceSource, /source\.includes\("ai_optimization_v2_lightweight"\)/);
  assert.match(serviceSource, /UPDATE listing_drafts[\s\S]*SET template_id = \?/);
  assert.match(serviceSource, /if \(repaired\) return assertDraftAccess\(draftId, session\)/);
});

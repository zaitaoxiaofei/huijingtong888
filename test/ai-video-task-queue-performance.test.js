import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const taskSource = readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../frontend/admin/api/tools/aiImageGenerator.js", import.meta.url), "utf8");
const optimizerSource = readFileSync(new URL("../frontend/admin/views/listing/AiProductMaterialOptimizerView.vue", import.meta.url), "utf8");
const listingSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const labSource = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");

test("interactive video generation uses the persistent task worker", () => {
  assert.match(taskSource, /if \(input\.listingVariantMedia\) return generateListingVariantMediaFromImage\(videoPayload\)/);
  assert.match(taskSource, /listingVariantMedia: Boolean/);
  assert.match(apiSource, /export async function generateAiVideo/);
  assert.match(apiSource, /fieldKey: "video"/);
  assert.match(optimizerSource, /await generateAiVideo\(/);
  assert.match(listingSource, /listingVariantMedia: true/);
  assert.match(labSource, /listingVariantMedia: true/);
  assert.doesNotMatch(optimizerSource, /post\("\/api\/asset-variant-engine\/generate-video"/);
  assert.doesNotMatch(listingSource, /post\("\/api\/listing\/variant-media\/generate"/);
  assert.doesNotMatch(labSource, /post\("\/api\/listing\/variant-media\/generate"/);
});

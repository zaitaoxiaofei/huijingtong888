import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingRecordEditorView.vue", import.meta.url), "utf8");
const publishRecordsSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const collectorBoxSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");

test("listing record editor loads standardized template snapshot before raw request", () => {
  assert.match(source, /function buildTemplateFromDetailRow\(row\)/);
  assert.match(source, /const snapshot = plainClone\(row\.template_snapshot, null\)/);
  assert.match(source, /if \(snapshot\?\.editable_payload\)/);
  assert.match(source, /sourceRaw\.from_publish_record = true/);
  assert.match(source, /template,/);
});

test("listing record editor has a safe local clone helper for snapshot drafts", () => {
  assert.match(source, /function plainClone\(value, fallback = null\)/);
  assert.match(source, /JSON\.parse\(JSON\.stringify\(value\)\)/);
});

test("publish record drawer gates large technical JSON behind explicit loading", () => {
  assert.match(publishRecordsSource, /drawerPayloadCache/);
  assert.match(publishRecordsSource, /drawerResponseCache/);
  assert.match(publishRecordsSource, /technicalJsonLoaded:\s*false/);
  assert.match(publishRecordsSource, /function loadDrawerTechnicalJson\(\)/);
  assert.match(publishRecordsSource, /v-if="drawer\.technicalJsonLoaded"/);
  assert.doesNotMatch(publishRecordsSource, /drawer\.payloadText\s*=\s*JSON\.stringify\(payload, null, 2\);\s*drawer\.visible = true/s);
  assert.doesNotMatch(publishRecordsSource, /:model-value="prettyJson\(\{ response: drawer\.row\.response, error: drawer\.row\.error \}\)"/);
});

test("collector box does not persist or render large raw payloads by default", () => {
  assert.doesNotMatch(collectorBoxSource, /detail:\s*detail\.value\s*\|\|\s*null/);
  assert.doesNotMatch(collectorBoxSource, /detail\.value\s*=\s*parsed\?\.detail\s*\|\|\s*null/);
  assert.match(collectorBoxSource, /rawPayloadPreviewLoaded/);
  assert.match(collectorBoxSource, /function loadRawPayloadPreview\(\)/);
  assert.match(collectorBoxSource, /v-if="!rawPayloadPreviewLoaded"/);
  assert.doesNotMatch(collectorBoxSource, /<pre class="payload-preview">\{\{ JSON\.stringify/);
});

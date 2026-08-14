import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const uploadClientSource = fs.readFileSync(new URL("../frontend/admin/api/tools/imageCropper.js", import.meta.url), "utf8");
const listingServiceSource = fs.readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("listing media uploads limit browser concurrency and retry transient network failures", () => {
  assert.match(uploadClientSource, /LISTING_MEDIA_UPLOAD_CONCURRENCY = 10/);
  assert.match(uploadClientSource, /uploadListingMediaWithRetry/);
  assert.match(uploadClientSource, /error instanceof TypeError/);
  assert.match(uploadClientSource, /\[408, 429, 502, 503, 504\]/);
});

test("listing media upload retries keep one idempotency source id", () => {
  assert.match(uploadClientSource, /upload_request_id: requestId/);
  assert.match(uploadClientSource, /source_id: metadata\?\.source_id \|\| metadata\?\.sourceId \|\| `upload:\$\{requestId\}`/);
  assert.match(listingServiceSource, /String\(sourceId\)\.startsWith\("upload:"\)/);
  assert.match(listingServiceSource, /WHERE source_module = \? AND source_id = \? AND role = \?/);
  assert.match(listingServiceSource, /listingMediaUploadResult\(existingAsset/);
});

test("listing media is OSS-only and never falls back to local persistent files", () => {
  const body = listingServiceSource.match(/async function writeListingMediaFile[\s\S]*?\n\}/)?.[0] || "";
  assert.match(body, /OSS 未启用或配置不完整/);
  assert.doesNotMatch(body, /fs\.writeFile/);
  assert.doesNotMatch(body, /previewUrl:\s*`\/uploads\/listing-media/);
});

test("listing media upload streams multipart payloads through temp files and OSS", () => {
  assert.match(listingServiceSource, /ozon-listing-upload-/);
  assert.match(listingServiceSource, /putContentAddressedFile/);
  assert.match(listingServiceSource, /optimizeListingImageFileForPublish/);
  assert.match(listingServiceSource, /LISTING_MEDIA_UPLOAD_MAX_CONCURRENCY/);
  const uploadBody = listingServiceSource.match(/async function uploadListingMediaWithSlot[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(uploadBody, /file\.buffer/);
  assert.doesNotMatch(uploadBody, /mediaBuffer/);
});

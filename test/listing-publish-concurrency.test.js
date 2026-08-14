import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("listing publish concurrency is configurable with memory-safe defaults", () => {
  assert.match(source, /config\.listingPublishBackgroundConcurrency \|\| 4/);
  assert.match(source, /const backgroundListingPublishQueue = \[\];/);
  assert.match(source, /backgroundListingPublishActiveCount < adaptiveConcurrency/);
  assert.match(source, /backgroundListingPublishQueue\.push\(\{ label, task, completion, resolveCompletion \}\)/);
});

test("batch listing publish prepares drafts with configured concurrency", () => {
  const batchSource = source.match(/async function processListingDraftBatchPublishTask[\s\S]*?export async function publishListingDraftsToOzon/)?.[0] || "";
  assert.match(source, /config\.listingPublishDraftConcurrency \|\| 2/);
  assert.match(source, /config\.listingPublishShopConcurrency \|\| 2/);
  assert.match(source, /config\.listingPublishBackgroundConcurrency \|\| 4/);
  assert.match(batchSource, /await mapWithConcurrency\(draftIds, LISTING_PUBLISH_DRAFT_CONCURRENCY, async \(draftId\) => \{/);
  assert.match(source, /const backgroundListingPublishBatchQueue = \[\];/);
  assert.match(source, /runBackgroundListingPublishBatch\(`draft batch publish task/);
  assert.doesNotMatch(source, /runBackgroundListingPublish\(`draft batch publish task/);
});

test("queued Ozon submissions retain only record ids and reload payloads on demand", () => {
  assert.match(source, /submitPreparedListingPublishRecord\(\{ recordId \}\)/);
  assert.match(source, /SELECT r\.request_json, shops\.id, shops\.name, shops\.ozon_client_id/);
  assert.match(source, /shopPayload = parseJson\(prepared\.request_json, \{\}\)/);
  const directQueue = source.match(/runBackgroundListingPublish\(`direct publish record[\s\S]*?\n\s*}\);/)?.[0] || "";
  assert.doesNotMatch(directQueue, /shopPayload|validation|mediaRepair/);
});

test("Ozon submit concurrency backs off under heap or database pressure", () => {
  assert.match(source, /function adaptiveListingPublishSubmitConcurrency\(\)/);
  assert.match(source, /heapMb >= 700 \|\| pool\.activeConnections >= pool\.connectionLimit - 1/);
  assert.match(source, /heapMb >= 500 \|\| pool\.activeConnections >= pool\.connectionLimit - 3/);
  assert.match(source, /backgroundListingPublishActiveCount < adaptiveConcurrency/);
});

test("Ozon submissions report stage timings without logging payload contents", () => {
  assert.match(source, /\[listing-publish-stage\]/);
  assert.match(source, /media_repair_ms/);
  assert.match(source, /media_check_ms/);
  assert.match(source, /ozon_submit_ms/);
  assert.match(source, /import_check_ms/);
  assert.match(source, /db_finalize_ms/);
  assert.match(source, /payload_bytes: Buffer\.byteLength/);
});

test("collector media sidecar drains claimed media in concurrent batches", () => {
  const plugin = readFileSync(new URL("../ozon-erp-collector-plugin/background.js", import.meta.url), "utf8");
  assert.match(plugin, /SERVER_PUBLISH_MEDIA_SIDECAR_LIMIT = 20/);
  assert.match(plugin, /SERVER_PUBLISH_MEDIA_SIDECAR_CONCURRENCY = 8/);
  assert.match(plugin, /SERVER_PUBLISH_MEDIA_SIDECAR_INITIAL_DELAY_MINUTES = 0\.05/);
  assert.match(plugin, /const resultOffset = results\.length/);
  assert.match(plugin, /await Promise\.all\(Array\.from/);
});

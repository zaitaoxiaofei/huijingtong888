import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("draft box restores a fresh lightweight snapshot before background refresh", () => {
  assert.match(source, /const DRAFT_LIST_CACHE_TTL_MS = 30 \* 1000/);
  assert.match(source, /const draftListCache = new Map\(\)/);
  assert.match(source, /if \(hasFreshCache\) applyDraftListResult\(cached\.result\)/);
  assert.match(source, /loading\.value = !hasFreshCache/);
  assert.match(source, /setBoundedListCache\(draftListCache, cacheKey, result\)/);
});

test("draft box prevents stale requests and invalidates snapshots for destructive refreshes", () => {
  assert.match(source, /const requestSeq = \+\+recordsRequestSeq/);
  assert.match(source, /if \(requestSeq !== recordsRequestSeq\) return/);
  assert.match(source, /async function reloadRecordsAfterDelete[\s\S]*?draftListCache\.clear\(\)/);
  assert.match(source, /async function refreshToolbarRecords[\s\S]*?draftListCache\.clear\(\)/);
});

test("draft box reuses the shared shop dictionary", () => {
  assert.match(source, /import \{ loadShopDictionary \} from "\.\.\/\.\.\/utils\/shop-dictionary"/);
  assert.match(source, /const rows = await loadShopDictionary\(\)/);
  assert.doesNotMatch(source, /apiClient\.get\("\/api\/shops", \{ noCache: true \}\)/);
});

test("draft box supports creator and development type filters end to end", () => {
  assert.match(source, /v-model="state\.creatorId"/);
  assert.match(source, /v-model="state\.developmentType"/);
  assert.match(source, /const creatorId = String\(state\.creatorId\)/);
  assert.match(source, /params\.set\("creatorId", creatorId\)/);
  assert.match(source, /params\.set\("developmentType", String\(state\.developmentType\)\)/);
  assert.match(serviceSource, /const creatorId = Number\(query\.creatorId \|\| query\.creator_id \|\| 0\)/);
  assert.match(serviceSource, /d\.created_by_person_id = \?/);
  assert.match(serviceSource, /const developmentType = String\(query\.developmentType \|\| query\.development_type \|\| ""\)/);
  assert.match(serviceSource, /COALESCE\(d\.development_type, ''\) = \?/);
  const listingDraftsSource = serviceSource.match(/export async function listingDrafts[\s\S]*?export async function listingDraft\(/)?.[0] || "";
  assert.doesNotMatch(listingDraftsSource, /r\.created_by_person_id/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");

test("listing media public sync keeps publish concurrency while deduplicating and retrying uploads", () => {
  assert.match(source, /const listingMediaPublicSyncRequests = new Map\(\)/);
  assert.match(source, /listingMediaPublicSyncRequests\.get\(requestKey\)/);
  assert.match(source, /LISTING_MEDIA_PUBLIC_SYNC_ATTEMPTS/);
  assert.match(source, /\[408, 425, 429, 500, 502, 503, 504\]/);
  assert.match(source, /\[1000, 3000, 8000\]/);
  assert.match(configSource, /LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS", 60000/);
  assert.match(configSource, /LISTING_MEDIA_PUBLIC_SYNC_ATTEMPTS", 3/);
  assert.match(source, /LISTING_PUBLISH_BACKGROUND_CONCURRENCY/);
});

test("successful media reachability is cached and public media errors precede credential classification", () => {
  assert.match(source, /const listingMediaReachabilityCache = new Map\(\)/);
  assert.match(source, /listingMediaReachabilityCache\.get\(value\)/);
  assert.match(source, /LISTING_MEDIA_REACHABILITY_CACHE_MAX_ENTRIES = 2000/);
  assert.match(source, /cacheReachableListingMedia\(value, result\)/);
  assert.match(source, /public media is not fully downloadable/);
  assert.match(source, /\/\(\?:\^\|\\D\)\(401\|403\)\(\?:\\D\|\$\)\//);

  const mediaBranch = source.indexOf('includesAny(["public media is not fully downloadable"');
  const credentialBranch = source.indexOf('includesAny(["client-id", "api-key", "unauthorized"');
  assert.ok(mediaBranch >= 0);
  assert.ok(credentialBranch > mediaBranch);
});

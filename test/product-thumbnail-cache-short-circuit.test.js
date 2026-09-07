import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("remote product thumbnails use disk cache before downloading the source image", () => {
  const cacheLookup = source.indexOf("await readProductThumbnailCache(thumbnailCacheSeed, thumbnailWidth)");
  const remoteFetch = source.indexOf("await fetchRemoteImagePayload(String(image))", cacheLookup);
  assert.ok(cacheLookup > 0);
  assert.ok(remoteFetch > cacheLookup);
  assert.match(source, /"X-Product-Thumbnail-Cache": "hit"/);
});

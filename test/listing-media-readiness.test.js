import test from "node:test";
import assert from "node:assert/strict";

import {
  downloadRemoteImageForOzon,
  isLikelyRemoteImageUrl,
  verifyRemoteImagesReadyForOzon
} from "../src/services/listing-media-readiness.js";

test("listing media readiness recognizes image URLs without treating videos as images", () => {
  assert.equal(isLikelyRemoteImageUrl("https://erp.example/uploads/listing-media/main.png"), true);
  assert.equal(isLikelyRemoteImageUrl("https://erp.example/uploads/listing-media/main.JPG?v=1"), true);
  assert.equal(isLikelyRemoteImageUrl("https://erp.example/uploads/listing-media/demo.mp4"), false);
});

test("full image download rejects a truncated response body", async () => {
  const result = await downloadRemoteImageForOzon("https://erp.example/main.png", {
    fetchImpl: async () => new Response(new Uint8Array(10), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": "20"
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "incomplete_body");
  assert.equal(result.downloadedBytes, 10);
});

test("image readiness retries and requires two consecutive complete downloads", async () => {
  let calls = 0;
  const payload = new Uint8Array(2048);
  const result = await verifyRemoteImagesReadyForOzon(["https://erp.example/main.png"], {
    attempts: 3,
    requiredConsecutiveSuccesses: 2,
    retryDelayMs: 0,
    waitImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(payload.byteLength)
        }
      });
    }
  });

  assert.equal(calls, 3);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].consecutiveSuccesses, 2);
});

test("image readiness reports URLs that never become fully downloadable", async () => {
  const url = "https://erp.example/broken.png";
  const result = await verifyRemoteImagesReadyForOzon([url], {
    attempts: 3,
    requiredConsecutiveSuccesses: 2,
    retryDelayMs: 0,
    waitImpl: async () => {},
    fetchImpl: async () => new Response("error", { status: 502 })
  });

  assert.equal(result.ok, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failedUrls, [url]);
  assert.equal(result.results[0].attempts, 3);
});

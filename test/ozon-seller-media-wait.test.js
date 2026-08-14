import test from "node:test";
import assert from "node:assert/strict";

import { waitForOzonSellerMediaJobs } from "../src/services/ozon-seller-media-wait.js";

function job(status, url = "") {
  return {
    mediaJobId: "image-1",
    status,
    uploadedUrl: url
  };
}

test("seller media wait refreshes pending jobs until an Ozon URL is ready", async () => {
  const states = [
    [job("processing")],
    [job("uploaded", "https://ir.ozone.ru/s3/media/image.jpg")]
  ];
  let loads = 0;
  const result = await waitForOzonSellerMediaJobs([job("pending")], {
    loadJobs: async () => states[Math.min(loads++, states.length - 1)],
    waitImpl: async () => {},
    nowImpl: () => loads * 100
  });

  assert.equal(loads, 2);
  assert.equal(result[0].status, "uploaded");
  assert.match(result[0].uploadedUrl, /^https:\/\/ir\.ozone\.ru\//);
});

test("seller media wait blocks publish when an upload fails", async () => {
  await assert.rejects(
    waitForOzonSellerMediaJobs([job("pending")], {
      loadJobs: async () => [job("failed")],
      waitImpl: async () => {}
    }),
    (error) => error.code === "OZON_SELLER_MEDIA_UPLOAD_FAILED" && error.pending.length === 1
  );
});

test("seller media wait blocks publish when uploads stay pending past timeout", async () => {
  let now = 0;
  await assert.rejects(
    waitForOzonSellerMediaJobs([job("pending")], {
      loadJobs: async () => [job("processing")],
      timeoutMs: 1000,
      waitImpl: async () => { now += 1000; },
      nowImpl: () => now
    }),
    (error) => error.code === "OZON_SELLER_MEDIA_UPLOAD_TIMEOUT" && error.pending.length === 1
  );
});

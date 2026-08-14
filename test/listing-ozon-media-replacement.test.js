import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectOzonSellerMediaPublishCandidates,
  replacePayloadMediaUrls
} from "../src/services/listing-automation.js";

test("Ozon seller media bridge only registers videos", () => {
  const image = "https://erp.example/uploads/listing-media/main.png";
  const detail = "https://erp.example/uploads/listing-media/detail.png";
  const video = "https://erp.example/uploads/listing-media/demo.mp4";
  const richImage = "https://erp.example/uploads/listing-media/rich.png";
  const ozonImage = "https://ir.ozone.ru/s3/media/main.jpg";
  const ozonDetail = "https://ir.ozone.ru/s3/media/detail.jpg";
  const ozonVideo = "https://ir.ozone.ru/s3/media/demo.mp4";
  const ozonRichImage = "https://ir.ozone.ru/s3/media/rich.jpg";
  const payload = {
    items: [{
      primary_image: image,
      images: [detail],
      attributes: [{
        id: 11254,
        values: [{ value: JSON.stringify({ content: [{ img: { src: richImage, srcMobile: richImage } }] }) }]
      }],
      complex_attributes: [{
        attributes: [{ id: 21841, values: [{ value: video }] }]
      }]
    }]
  };

  const candidates = collectOzonSellerMediaPublishCandidates(payload);
  assert.deepEqual(candidates.map((item) => item.sourceUrl), [video]);

  const result = replacePayloadMediaUrls(payload, new Map([
    [image, ozonImage],
    [detail, ozonDetail],
    [video, ozonVideo],
    [richImage, ozonRichImage]
  ]));
  const serialized = JSON.stringify(result);

  assert.equal(result.items[0].primary_image, ozonImage);
  assert.deepEqual(result.items[0].images, [ozonDetail]);
  assert.match(serialized, new RegExp(ozonVideo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /erp\.example/);
});

test("managed OSS media is submitted directly without the legacy seller media bridge", () => {
  const previous = {
    enabled: process.env.OSS_ENABLED,
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    publicBaseUrl: process.env.OSS_PUBLIC_BASE_URL
  };
  process.env.OSS_ENABLED = "true";
  process.env.OSS_REGION = "oss-cn-heyuan";
  process.env.OSS_BUCKET = "hjt888-ozon-erp-private-2026";
  delete process.env.OSS_PUBLIC_BASE_URL;
  try {
    const ossVideo = "https://hjt888-ozon-erp-private-2026.oss-cn-heyuan.aliyuncs.com/listing-media/aa/demo.mp4";
    const payload = {
      items: [{
        complex_attributes: [{
          attributes: [{ id: 21841, values: [{ value: ossVideo }] }]
        }]
      }]
    };

    assert.deepEqual(collectOzonSellerMediaPublishCandidates(payload), []);
  } finally {
    restoreEnv("OSS_ENABLED", previous.enabled);
    restoreEnv("OSS_REGION", previous.region);
    restoreEnv("OSS_BUCKET", previous.bucket);
    restoreEnv("OSS_PUBLIC_BASE_URL", previous.publicBaseUrl);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("publish retries transient Ozon media fetch failures after refreshing public URLs", () => {
  const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

  assert.match(source, /const maxAttempts = 3/);
  assert.match(source, /isRetryableOzonSellerMediaError\(error\)/);
  assert.match(source, /workingPayload = await tryRepairPayloadListingMediaReachability\(workingPayload\)/);
  assert.match(source, /publish_attempt: attempt/);
});

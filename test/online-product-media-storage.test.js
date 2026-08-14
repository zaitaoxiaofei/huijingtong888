import assert from "node:assert/strict";
import test from "node:test";

import { archiveRemoteMediaObjectUrl } from "../src/services/object-storage.js";
import { compactOnlineProductRawJson, prepareOnlineProductMediaForStorage } from "../src/services/online-product-media-storage.js";

const ossEnv = {
  OSS_ENABLED: "true",
  OSS_REGION: "oss-cn-heyuan",
  OSS_BUCKET: "erp-test",
  OSS_ACCESS_KEY_ID: "test-id",
  OSS_ACCESS_KEY_SECRET: "test-secret"
};

test("remote product media is stored once by content hash", async () => {
  const puts = [];
  const storedKeys = new Set();
  const client = {
    head: async (key) => {
      if (storedKeys.has(key)) return { status: 200 };
      const error = new Error("missing");
      error.status = 404;
      throw error;
    },
    putStream: async (key, stream) => {
      storedKeys.add(key);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      puts.push({ key, buffer: Buffer.concat(chunks) });
    }
  };
  const fetchImpl = async () => new Response(Buffer.from("same-image"), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "10" }
  });
  const first = await archiveRemoteMediaObjectUrl("https://example.com/a.jpg", { env: ossEnv, client, fetchImpl });
  const second = await archiveRemoteMediaObjectUrl("https://example.com/b.jpg", { env: ossEnv, client, fetchImpl });
  assert.equal(first, second);
  assert.equal(puts.length, 1);
  assert.match(first, /^https:\/\/erp-test\.oss-cn-heyuan\.aliyuncs\.com\/product-media\//);
});

test("online product media uses OSS URLs and compacts duplicate raw media", async () => {
  const managed = "https://erp-test.oss-cn-heyuan.aliyuncs.com/product-media/aa/existing.jpg";
  const result = await prepareOnlineProductMediaForStorage({
    image_url: managed,
    primary_image: managed,
    images_json: JSON.stringify([managed, managed]),
    raw_json: JSON.stringify({ sku: "123", images: [managed], primary_image: managed, status: "online", nested: { videos: ["x"] } })
  }, { env: ossEnv });
  assert.equal(result.image_url, managed);
  assert.deepEqual(JSON.parse(result.images_json), [managed]);
  assert.deepEqual(JSON.parse(result.raw_json), { sku: "123", status: "online", nested: {} });
});

test("OSS-disabled development keeps remote URLs while still removing duplicate raw media", async () => {
  const url = "https://example.com/product.jpg";
  const result = await prepareOnlineProductMediaForStorage({
    image_url: url,
    images_json: JSON.stringify([url]),
    raw_json: JSON.stringify({ sku: "456", images: [url] })
  }, { env: { OSS_ENABLED: "false" } });
  assert.equal(result.image_url, url);
  assert.deepEqual(JSON.parse(result.images_json), [url]);
  assert.deepEqual(JSON.parse(result.raw_json), { sku: "456" });
});

test("media archival failure keeps the remote URL and does not abort product sync", async () => {
  const url = "https://cdn.example.com/restricted.jpg";
  const result = await prepareOnlineProductMediaForStorage({
    image_url: url,
    images_json: JSON.stringify([url])
  }, {
    env: ossEnv,
    fetchImpl: async () => new Response("forbidden", { status: 403 })
  });
  assert.equal(result.image_url, url);
  assert.deepEqual(JSON.parse(result.images_json), [url]);
});

test("raw JSON compaction tolerates invalid input", () => {
  assert.equal(compactOnlineProductRawJson("not-json"), "");
});

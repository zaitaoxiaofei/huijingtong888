import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContentAddressedObjectKey,
  isManagedOssObjectUrl,
  mediaObjectPrefixForRetention,
  ossStorageConfig,
  publicOssObjectUrl,
  readManagedOssObject,
  promoteManagedOssObjectUrl,
  putContentAddressedObject,
  putContentAddressedFile
} from "../src/services/object-storage.js";

test("private managed OSS objects are read with the configured server client", async () => {
  const requested = [];
  const result = await readManagedOssObject(
    "https://example-bucket.oss-cn-heyuan.aliyuncs.com/listing-media/ab/file.png",
    {
      env: {
        OSS_ENABLED: "true",
        OSS_REGION: "oss-cn-heyuan",
        OSS_BUCKET: "example-bucket",
        OSS_ACCESS_KEY_ID: "id",
        OSS_ACCESS_KEY_SECRET: "secret"
      },
      client: {
        async head(key) {
          requested.push(["head", key]);
          return { res: { headers: { "content-length": "5", "content-type": "image/png" } } };
        },
        async get(key) {
          requested.push(["get", key]);
          return { content: Buffer.from("image"), res: { headers: { "content-type": "image/png" } } };
        }
      }
    }
  );
  assert.deepEqual(requested, [["head", "listing-media/ab/file.png"], ["get", "listing-media/ab/file.png"]]);
  assert.equal(result.contentType, "image/png");
  assert.equal(result.buffer.toString(), "image");
});

test("temporary AI OSS images are promoted with a server-side copy", async () => {
  const calls = [];
  const missing = Object.assign(new Error("missing"), { status: 404 });
  const hash = "a".repeat(64);
  const result = await promoteManagedOssObjectUrl(
    `https://example-bucket.oss-cn-heyuan.aliyuncs.com/ai-unused/aa/${hash}.png`,
    {
      contentType: "image/png",
      env: {
        OSS_ENABLED: "true",
        OSS_REGION: "oss-cn-heyuan",
        OSS_BUCKET: "example-bucket",
        OSS_ACCESS_KEY_ID: "id",
        OSS_ACCESS_KEY_SECRET: "secret"
      },
      client: {
        async head(key) {
          if (key.startsWith("listing-media/")) throw missing;
          return { res: { headers: { "content-length": "123", "content-type": "image/png" } } };
        },
        async copy(target, source, options) { calls.push({ target, source, options }); }
      }
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, `ai-unused/aa/${hash}.png`);
  assert.equal(calls[0].target, `listing-media/aa/${hash}.png`);
  assert.equal(result.size, 123);
  assert.equal(result.copied, true);
});

test("content-addressed file uploads use streams instead of whole-file buffers", async () => {
  const filePath = new URL("./fixtures-stream-upload.tmp", import.meta.url);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, "streamed-image"));
  let receivedStream = null;
  try {
    const result = await putContentAddressedFile(filePath, {
      extension: ".png",
      contentType: "image/png",
      env: { OSS_ENABLED: "true", OSS_REGION: "oss-cn-test", OSS_BUCKET: "bucket", OSS_ACCESS_KEY_ID: "id", OSS_ACCESS_KEY_SECRET: "secret" },
      client: {
        async head() { throw Object.assign(new Error("missing"), { status: 404 }); },
        async putStream(key, stream) { receivedStream = stream; for await (const chunk of stream) assert.ok(chunk.length); }
      }
    });
    assert.ok(receivedStream);
    assert.equal(result.size, 14);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(filePath, { force: true }));
  }
});

test("content-addressed keys reuse the same OSS object for identical bytes", () => {
  const first = buildContentAddressedObjectKey(Buffer.from("same-image"), {
    prefix: "listing-media",
    extension: ".JPG"
  });
  const second = buildContentAddressedObjectKey(Buffer.from("same-image"), {
    prefix: "/listing-media/",
    extension: "jpg"
  });
  assert.deepEqual(first, second);
  assert.match(first.objectKey, /^listing-media\/[a-f0-9]{2}\/[a-f0-9]{64}\.jpg$/);
});

test("public OSS URLs encode object path segments", () => {
  assert.equal(publicOssObjectUrl({
    region: "oss-cn-heyuan",
    bucket: "example-bucket",
    objectKey: "listing-media/ab/a b.jpg"
  }), "https://example-bucket.oss-cn-heyuan.aliyuncs.com/listing-media/ab/a%20b.jpg");
});

test("managed temporary OSS URLs are recognized for permanent promotion", () => {
  const env = {
    OSS_ENABLED: "true",
    OSS_REGION: "oss-cn-heyuan",
    OSS_BUCKET: "example-bucket",
    OSS_ACCESS_KEY_ID: "id",
    OSS_ACCESS_KEY_SECRET: "secret"
  };
  assert.equal(isManagedOssObjectUrl(
    "https://example-bucket.oss-cn-heyuan.aliyuncs.com/ai-unused/ab/file.png",
    { prefix: "ai-unused", env }
  ), true);
  assert.equal(isManagedOssObjectUrl(
    "https://example-bucket.oss-cn-heyuan.aliyuncs.com/listing-media/ab/file.png",
    { prefix: "ai-unused", env }
  ), false);
});

test("retention routing keeps collector and video sources separate from final media", () => {
  assert.equal(mediaObjectPrefixForRetention({ sourceModule: "collector_box", contentType: "image/png" }), "collector-media");
  assert.equal(mediaObjectPrefixForRetention({ role: "source_video", contentType: "video/mp4" }), "video-source");
  assert.equal(mediaObjectPrefixForRetention({ role: "variant_1_video", contentType: "video/mp4" }), "listing-media");
  assert.equal(mediaObjectPrefixForRetention({ role: "draft_image", contentType: "image/png" }), "listing-media");
});

test("enabled OSS configuration fails fast when server credentials are missing", () => {
  assert.throws(() => ossStorageConfig({
    OSS_ENABLED: "true",
    OSS_REGION: "oss-cn-heyuan",
    OSS_BUCKET: "example-bucket"
  }), /OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET/);
});

test("OSS upload returns a stable public URL without exposing credentials", async () => {
  const calls = [];
  const client = {
    async head() {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    },
    async put(key, buffer, options) {
      calls.push({ key, buffer, options });
      return {};
    }
  };
  const result = await putContentAddressedObject(Buffer.from("image"), {
    extension: ".png",
    contentType: "image/png",
    env: {
      OSS_ENABLED: "true",
      OSS_REGION: "oss-cn-heyuan",
      OSS_BUCKET: "hjt888-ozon-erp-private-2026",
      OSS_ACCESS_KEY_ID: "server-only-id",
      OSS_ACCESS_KEY_SECRET: "server-only-secret"
    },
    client
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["Content-Type"], "image/png");
  assert.match(result.url, /^https:\/\/hjt888-ozon-erp-private-2026\.oss-cn-heyuan\.aliyuncs\.com\/listing-media\//);
  assert.doesNotMatch(JSON.stringify(result), /server-only/);
});

test("an existing content-addressed object is reused without creating a new version", async () => {
  let putCount = 0;
  const result = await putContentAddressedObject(Buffer.from("same-image"), {
    extension: ".jpg",
    contentType: "image/jpeg",
    env: {
      OSS_ENABLED: "true",
      OSS_REGION: "oss-cn-heyuan",
      OSS_BUCKET: "example-bucket",
      OSS_ACCESS_KEY_ID: "server-only-id",
      OSS_ACCESS_KEY_SECRET: "server-only-secret"
    },
    client: {
      async head() {
        return {};
      },
      async put() {
        putCount += 1;
      }
    }
  });
  assert.equal(putCount, 0);
  assert.equal(result.reused, true);
});

test("OSS clients receive a bounded request timeout", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("../src/services/object-storage.js", import.meta.url),
    "utf8"
  ));
  assert.match(source, /timeout: Math\.max\(1000, Number\(timeoutMs\)/);
  assert.match(source, /timeoutMs = DEFAULT_OSS_REQUEST_TIMEOUT_MS/);
});

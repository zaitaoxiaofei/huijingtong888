import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { prepareVisionImageTransfers } from "../src/services/vision-image-transfer.js";

const env = { OSS_INTERNAL_READ: "true", OSS_ENABLED: "true", OSS_BUCKET: "fixture-bucket", OSS_REGION: "oss-cn-heyuan",
  OSS_ACCESS_KEY_ID: "fixture-id", OSS_ACCESS_KEY_SECRET: "fixture-secret" };
const own = (suffix = "") => `https://fixture-bucket.oss-cn-heyuan.aliyuncs.com/listing-media/aa/${"a".repeat(64)}.png${suffix}`;
const messages = (...urls) => [{ role: "user", content: [{ type: "text", text: "Read the product text and geometry" },
  ...urls.map(url => ({ type: "image_url", image_url: { url } }))] }];
const urls = result => result[0].content.filter(item => item.type === "image_url").map(item => item.image_url.url);

test("managed vision PNGs keep pixels, dimensions and alpha while reducing actual base64 transfer", async () => {
  const raw = Buffer.from(Array.from({ length: 64 * 64 * 4 }, (_, i) => i % 4 === 3 ? (i % 3 ? 255 : 0) : i % 256));
  const source = await sharp(raw, { raw: { width: 64, height: 64, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const input = messages(own());
  let reads = 0, checks = 0;
  const result = await prepareVisionImageTransfers(input, { env, beforeRequest: async () => { checks++; }, readImage: async (url, options) => {
    reads++;
    assert.equal(url, own()); assert.equal(options.maxBytes, 20 * 1024 * 1024);
    return { buffer: source, contentType: "image/png" };
  } });
  const data = urls(result)[0];
  assert.match(data, /^data:image\/webp;base64,/);
  assert.ok(Buffer.byteLength(data) <= source.length * 0.25);
  const optimized = Buffer.from(data.split(",")[1], "base64");
  assert.deepEqual(await sharp(optimized).raw().toBuffer(), await sharp(source).raw().toBuffer());
  const metadata = await sharp(optimized).metadata();
  assert.equal(metadata.width, 64); assert.equal(metadata.height, 64); assert.equal(metadata.hasAlpha, true);
  assert.equal(reads, 1); assert.ok(checks >= 3);
  assert.equal(urls(input)[0], own(), "Do not mutate caller/provider retry input");
  assert.equal(result[0].content[0], input[0].content[0]);
});

test("insufficient savings, optional encoder failure and non-image encodings retain the original URL", async () => {
  for (const encodeImage of [async () => Buffer.alloc(1000), async () => null, async () => { throw Error("Encoding timeout"); }]) {
    const result = await prepareVisionImageTransfers(messages(own()), { env,
      readImage: async () => ({ buffer: Buffer.alloc(2000), contentType: "image/png" }), encodeImage });
    assert.equal(urls(result)[0], own());
  }
});

test("external, private, signed, transformed, non-PNG and malformed sources never gain SDK access", async () => {
  const values = ["https://outside.example/source.png", own("?Signature=original"), own("?x-oss-process=image/resize,w_10"),
    own("#fragment"), own().replace("listing-media", "ai-task-media"), own().replace("listing-media", "database-archives"),
    own().replace(/a{64}\.png/, "mutable.png"), own().replace(".png", ".jpg"),
    own().replace("https://", "https://user:password@"), own().replace("aliyuncs.com/", "aliyuncs.com:8443/"),
    "data:image/png;base64,AA==", "invalid-url"];
  const result = await prepareVisionImageTransfers(messages(...values), { env,
    readImage: async () => assert.fail("Excluded sources must retain the original URL boundary") });
  assert.deepEqual(urls(result), values);
});

test("local/public SDK mode does not add a public download before the provider reads the source", async () => {
  const input = messages(own());
  assert.equal(await prepareVisionImageTransfers(input, { env: { ...env, OSS_INTERNAL_READ: "false" },
    readImage: async () => assert.fail("No extra public download") }), input);
});

test("request-local reuse reads a source once but counts each repeated inline value against the wire budget", async () => {
  let reads = 0;
  const result = await prepareVisionImageTransfers(messages(...Array(12).fill(own())), { env,
    readImage: async () => { reads++; return { buffer: Buffer.alloc(2 * 1024 * 1024), contentType: "image/png" }; },
    encodeImage: async () => Buffer.alloc(250 * 1024) });
  const references = urls(result);
  assert.equal(reads, 1);
  const inline = references.filter(url => url.startsWith("data:"));
  assert.equal(inline.length, 6);
  assert.ok(inline.reduce((sum, url) => sum + Buffer.byteLength(url), 0) <= 2 * 1024 * 1024);
  assert.equal(references.at(-1), own());
});

test("permissions and cancellation are rechecked after reads and encoding; SDK failure never falls back", async () => {
  const denial = Object.assign(new Error("Membership revoked"), { statusCode: 403 });
  for (const stage of ["read", "encode"]) {
    let revoked = false;
    await assert.rejects(prepareVisionImageTransfers(messages(own()), { env,
      beforeRequest: async () => { if (revoked) throw denial; },
      readImage: async () => { if (stage === "read") revoked = true; return { buffer: Buffer.alloc(2000), contentType: "image/png" }; },
      encodeImage: async () => { revoked = true; return Buffer.alloc(10); }
    }), error => error === denial);
  }
  const offline = new Error("Internal OSS unavailable");
  await assert.rejects(prepareVisionImageTransfers(messages(own()), { env, readImage: async () => { throw offline; } }), error => error === offline);
  const controller = new AbortController(); controller.abort(denial);
  await assert.rejects(prepareVisionImageTransfers(messages(own()), { env, signal: controller.signal,
    readImage: async () => assert.fail("Cancelled before read") }), error => error === denial);
});

test("profiled PNGs remain unchanged instead of silently reducing colour fidelity", async () => {
  const source = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).withIccProfile("srgb").png().toBuffer();
  assert.ok((await sharp(source).metadata()).icc);
  assert.equal(urls(await prepareVisionImageTransfers(messages(own()), { env,
    readImage: async () => ({ buffer: source, contentType: "image/png" }) }))[0], own());
});

test("16-bit PNGs preserve their full original depth", async () => {
  const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } })
    .toColourspace("rgb16").png({ compressionLevel: 0 }).toBuffer();
  assert.equal((await sharp(source).metadata()).bitsPerSample, 16);
  assert.equal(urls(await prepareVisionImageTransfers(messages(own()), { env,
    readImage: async () => ({ buffer: source, contentType: "image/png" }) }))[0], own());
});

test("a valid JPEG using an old PNG extension retains its existing provider URL", async () => {
  const source = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).jpeg().toBuffer();
  assert.equal(urls(await prepareVisionImageTransfers(messages(own()), { env,
    readImage: async () => ({ buffer: source, contentType: "image/jpeg" }) }))[0], own());
});

test("concurrent vision requests keep the existing URL path while optional compression is busy", async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = prepareVisionImageTransfers(messages(own()), { env,
    readImage: async () => { entered(); await pending; return { buffer: Buffer.alloc(2000), contentType: "image/png" }; },
    encodeImage: async () => null });
  await started;
  try {
    const second = messages(own());
    assert.equal(await prepareVisionImageTransfers(second, { env,
      readImage: async () => assert.fail("A busy optimization must not add another OSS read or queue") }), second);
  } finally { release(); await first; }
  let reads = 0;
  await prepareVisionImageTransfers(messages(own()), { env,
    readImage: async () => { reads++; return { buffer: Buffer.alloc(2000), contentType: "image/png" }; }, encodeImage: async () => null });
  assert.equal(reads, 1, "The preprocessing slot is released after completion");
});

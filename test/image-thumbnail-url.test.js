import assert from "node:assert/strict";
import test from "node:test";
import { publicImageThumbnailUrl, productThumbnailUrl, originalProductImageUrl } from "../frontend/admin/utils/image-thumbnail-url.js";

const origin = "https://erp.example";
const image = `https://public-images.oss-cn-heyuan.aliyuncs.com/listing-media/aa/${"a".repeat(64)}.png`;

test("ordinary public OSS list images use a display-only derivative URL with the original preserved", () => {
  const result = publicImageThumbnailUrl(image, { origin });
  const parsed = new URL(result, origin);
  assert.equal(parsed.pathname, "/api/image-thumbnail"); assert.equal(parsed.searchParams.get("url"), image); assert.equal(parsed.searchParams.get("w"), "180");
  assert.equal(productThumbnailUrl(image, { origin }), result);
  assert.equal(originalProductImageUrl(image, { origin }), image);
  assert.equal(productThumbnailUrl(`/api/image-proxy?url=${encodeURIComponent(image)}&token=local-only`, { origin }), result);
});

test("local product thumbnails keep their auth-free blob key while preview always requests the original", () => {
  const value = "/api/products/123/image?thumb=1&w=180&v=revision&token=secret";
  assert.equal(productThumbnailUrl(value, { origin }), "/api/products/123/image?thumb=1&w=180&v=revision");
  assert.equal(originalProductImageUrl(value, { origin }), "/api/products/123/image?v=revision&token=secret");
  assert.equal(productThumbnailUrl("/api/products/123/image", { origin }), "");
});

test("private, signed, mutable, external, inline and strict-original inputs retain their previous path", () => {
  for (const value of [image.replace("listing-media", "ai-task-media"), image.replace("listing-media", "team-attachments"), image.replace("listing-media", "database-archives"),
    image + "?Signature=signed", image + "?x-oss-process=image/resize,w_100", image + "#fragment", image.replace("https://", "http://"),
    image.replace("oss-cn-heyuan.", "oss-cn-heyuan-internal."), image.replace(".aliyuncs.com", ".aliyuncs.com.attacker.test"),
    image.replace("https://", "https://user:password@"), "https://example.com/photo.png", "data:image/png;base64,AAAA", "/api/ai/file/task/generated/image.png",
    `/api/image-proxy?url=${encodeURIComponent(image)}&require_original=1`]) assert.equal(publicImageThumbnailUrl(value, { origin }), "", value);
});

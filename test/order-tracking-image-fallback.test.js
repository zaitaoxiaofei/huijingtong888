import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const trackingSource = fs.readFileSync(new URL("../src/services/sku-order-tracking.js", import.meta.url), "utf8");
const imagePreviewSource = fs.readFileSync(new URL("../frontend/admin/components/ProductImagePreview.vue", import.meta.url), "utf8");

test("remote image proxy reports a failed upstream as an image load error", () => {
  assert.match(serverSource, /function sendImageProxyUnavailable\(res\)/);
  assert.match(serverSource, /writeHead\(res, 502/);
  const proxyHandler = serverSource.slice(serverSource.indexOf("async function sendRemoteImage(req, res, url)"), serverSource.indexOf("const server = http.createServer"));
  assert.doesNotMatch(proxyHandler, /sendImagePlaceholder\(res\)/);
  assert.equal((proxyHandler.match(/sendImageProxyUnavailable\(res\)/g) || []).length, 2);
});

test("order tracking keeps online and inventory images as fallback candidates", () => {
  assert.match(trackingSource, /CONCAT_WS\('\|\|',[\s\S]*NULLIF\(p\.image_url,\s*''\)\) AS image_urls/);
  assert.match(trackingSource, /CONCAT_WS\('\|\|',[\s\S]*NULLIF\(p\.image_url,''\)\) image_urls/);
});

test("an already-proxied image advances to the next candidate after an error", () => {
  assert.match(imagePreviewSource, /&& !props\.proxyRemote && !useProxyFallback\.value/);
  assert.match(imagePreviewSource, /fallbackIndex\.value \+= 1/);
});

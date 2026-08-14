import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const apiSource = fs.readFileSync(new URL("../frontend/admin/api/tools/aiImageGenerator.js", import.meta.url), "utf8");
const browserSource = fs.readFileSync(new URL("../frontend/admin/utils/browser-product-video.js", import.meta.url), "utf8");
const engineSource = fs.readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");
const videoToolSource = fs.readFileSync(new URL("../frontend/admin/views/tools/ProductVideoGenerator.vue", import.meta.url), "utf8");
const variantLabSource = fs.readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");

test("listing video generation prefers browser canvas and keeps server fallback", () => {
  assert.match(apiSource, /browserProductVideoSupported\(\)/);
  assert.match(apiSource, /generateBrowserProductVideo\(payload, options\)/);
  assert.match(apiSource, /options\.serverFallback === false/);
  assert.match(apiSource, /fallback to server/);
  assert.match(apiSource, /apiClient\.post\("\/api\/ai-generation\/tasks"/);
});

test("AI variant batch videos use the browser-first generator with ten workers", () => {
  assert.match(variantLabSource, /generateAiVideo/);
  assert.match(variantLabSource, /BROWSER_VIDEO_CONCURRENCY = 10/);
  assert.match(variantLabSource, /runWithConcurrency\(rows, BROWSER_VIDEO_CONCURRENCY/);
  assert.match(variantLabSource, /BACKGROUND_DRAFT_PREPARATION_CONCURRENCY = 10/);
});

test("browser video generator records MP4 and uploads final media", () => {
  assert.match(browserSource, /canvas\.captureStream\(FPS\)/);
  assert.match(browserSource, /new MediaRecorder\(stream/);
  assert.match(browserSource, /video\/mp4/);
  assert.match(browserSource, /uploadListingMedia\(file/);
  assert.match(browserSource, /generated_by: "browser_canvas_media_recorder"/);
  assert.match(browserSource, /DEFAULT_DURATION_SECONDS = 10/);
  assert.match(browserSource, /durationSeconds = Math\.max\(3, Math\.min\(10/);
  assert.match(engineSource, /SERVER_VIDEO_DURATION_SECONDS = 10/);
  assert.match(videoToolSource, /VIDEO_DURATION = 10/);
});

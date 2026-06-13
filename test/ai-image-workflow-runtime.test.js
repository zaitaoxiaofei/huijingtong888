import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const workflowSource = readFileSync(new URL("../src/server/services/ai/aiWorkflowService.js", import.meta.url), "utf8");
const imageGenerationSource = readFileSync(new URL("../src/server/services/openai/imageGenerationService.js", import.meta.url), "utf8");

test("AI image workflow resolves relative source images from APP_BASE_URL", () => {
  assert.match(workflowSource, /import \{ config \} from "\.\.\/\.\.\/\.\.\/config\.js"/);
  assert.match(workflowSource, /process\.env\.APP_BASE_URL/);
  assert.match(workflowSource, /config\.appBaseUrl/);
  assert.match(workflowSource, /new URL\(source, localAppOrigin\(\)\)/);
});

test("AI image generation network calls have bounded timeouts", () => {
  assert.match(workflowSource, /const AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS = 20000/);
  assert.match(workflowSource, /AbortSignal\.timeout\(AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS\)/);
  assert.match(imageGenerationSource, /const AI_IMAGE_PROVIDER_TIMEOUT_MS/);
  assert.match(imageGenerationSource, /AbortSignal\.timeout\(AI_IMAGE_PROVIDER_TIMEOUT_MS\)/);
  assert.match(imageGenerationSource, /AbortSignal\.timeout\(AI_IMAGE_DOWNLOAD_TIMEOUT_MS\)/);
});

test("AI image source fetch retries draft images with browser-like headers", () => {
  assert.match(workflowSource, /function sourceImageFetchHeaders/);
  assert.match(workflowSource, /User-Agent/);
  assert.match(workflowSource, /Referer/);
  assert.match(workflowSource, /\[401, 403, 404\]\.includes\(response\.status\)/);
  assert.doesNotMatch(workflowSource, /falling back to text-to-image/);
});

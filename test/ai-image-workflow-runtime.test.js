import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const workflowSource = readFileSync(new URL("../src/server/services/ai/aiWorkflowService.js", import.meta.url), "utf8");
const imageGenerationSource = readFileSync(new URL("../src/server/services/openai/imageGenerationService.js", import.meta.url), "utf8");
const aiGenerationTaskSource = readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");
const imageRuntimeLimiterSource = readFileSync(new URL("../src/services/ai-image-runtime-limiter.js", import.meta.url), "utf8");
const aiVariantLabSource = readFileSync(new URL("../src/services/ai-variant-lab.js", import.meta.url), "utf8");
const listingAutomationSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("AI image workflow resolves relative source images from APP_BASE_URL", () => {
  assert.match(workflowSource, /import \{ config \} from "\.\.\/\.\.\/\.\.\/config\.js"/);
  assert.match(workflowSource, /process\.env\.APP_BASE_URL/);
  assert.match(workflowSource, /config\.appBaseUrl/);
  assert.match(workflowSource, /new URL\(source, localAppOrigin\(\)\)/);
});

test("AI image generation network calls have bounded timeouts", () => {
  assert.match(workflowSource, /const AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS = 20000/);
  assert.match(workflowSource, /AbortSignal\.timeout\(AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS\)/);
  assert.match(imageGenerationSource, /const AI_IMAGE_GENERATION_WAIT_MS = Math\.max\(15000, Number\(process\.env\.AI_IMAGE_GENERATION_WAIT_MS \|\| 300000\)\)/);
  assert.match(imageGenerationSource, /const AI_IMAGE_TRANSPORT_GRACE_MS = Math\.max\(0, Number\(process\.env\.AI_IMAGE_TRANSPORT_GRACE_MS \|\| 60000\)\)/);
  assert.match(imageGenerationSource, /const AI_IMAGE_PROVIDER_TIMEOUT_MS = AI_IMAGE_GENERATION_WAIT_MS \+ AI_IMAGE_TRANSPORT_GRACE_MS/);
  assert.match(imageGenerationSource, /AbortSignal\.timeout\(AI_IMAGE_PROVIDER_TIMEOUT_MS\)/);
  assert.match(imageGenerationSource, /Date\.now\(\) - started < AI_IMAGE_GENERATION_WAIT_MS/);
  assert.match(imageGenerationSource, /AbortSignal\.timeout\(AI_IMAGE_DOWNLOAD_TIMEOUT_MS\)/);
});

test("async image provider jobs survive timeout and server restart without resubmission", () => {
  assert.match(imageGenerationSource, /if \(providerJob\?\.jobId\)[\s\S]*?pollAsync65535ImageJob/);
  assert.match(imageGenerationSource, /await onProviderJob\?\.\(\{[\s\S]*?jobId: String\(data\.job_id\)/);
  assert.match(imageGenerationSource, /error\.code = "provider_pending"/);
  assert.match(aiGenerationTaskSource, /provider_job_json LONGTEXT NULL/);
  assert.match(aiGenerationTaskSource, /status IN \('running', 'provider_pending'\)/);
  assert.match(aiGenerationTaskSource, /providerJobState = parseJson\(row\.provider_job_json, null\)/);
});

test("provider image URLs stream to disk and OSS without arrayBuffer duplication", () => {
  assert.match(imageGenerationSource, /return \{ remoteUrl: String\(imageUrl\) \}/);
  assert.match(imageGenerationSource, /pipeline\(Readable\.fromWeb\(response\.body\)/);
  assert.doesNotMatch(imageGenerationSource, /return Buffer\.from\(await imageResponse\.arrayBuffer\(\)\)/);
  assert.match(workflowSource, /putContentAddressedFile\(filePath/);
  assert.doesNotMatch(workflowSource, /const buffer = await fs\.readFile\(filePath\)/);
});

test("reference images are streamed once into a shared file cache", () => {
  assert.match(workflowSource, /const sourceImageCache = new Map\(\)/);
  assert.match(workflowSource, /pipeline\(Readable\.fromWeb\(response\.body\)/);
  assert.match(workflowSource, /imageFilePath: sourceImage\.filePath/);
  assert.doesNotMatch(workflowSource, /Buffer\.from\(await response\.arrayBuffer\(\)\)/);
  assert.match(imageGenerationSource, /fsSync\.openAsBlob\(imageFilePath/);
});

test("all image workflows share adaptive memory and database backpressure", () => {
  assert.match(imageRuntimeLimiterSource, /AI_IMAGE_GLOBAL_CONCURRENCY_CAP \|\| 12/);
  assert.match(imageRuntimeLimiterSource, /process\.memoryUsage\(\)/);
  assert.match(imageRuntimeLimiterSource, /getMysqlPoolMetrics\(\)/);
  assert.match(imageGenerationSource, /withAiImageRuntimeSlot\(runtimeConfig/);
});

test("AI variant provider jobs can resume without source-image access or resubmission", () => {
  assert.match(workflowSource, /providerJobResumeSourceImage\(\)/);
  assert.match(imageGenerationSource, /if \(providerJob\?\.jobId\)[\s\S]*?requestImageFromEndpoints/);
  assert.match(aiVariantLabSource, /provider_job_json LONGTEXT/);
  assert.match(aiVariantLabSource, /aiVariantLabBatchResumeImages/);
  assert.match(aiVariantLabSource, /recoverAiVariantLabImageBatchesOnStartup/);
});

test("temporary AI OSS media is promoted without downloading through ECS", () => {
  assert.match(listingAutomationSource, /promoteManagedOssObjectUrl\(sourceUrl/);
  const promotionBranch = listingAutomationSource.match(/if \(isManagedOssObjectUrl\(sourceUrl, \{ prefix: "ai-unused"[\s\S]*?status: "promoted_oss_media"/)?.[0] || "";
  assert.doesNotMatch(promotionBranch, /readListingMediaBuffer/);
});

test("AI image generation can use Responses API providers", () => {
  assert.match(imageGenerationSource, /usesResponsesImage/);
  assert.match(imageGenerationSource, /responsesEndpoint/);
  assert.match(imageGenerationSource, /tools:\s*\[\{ type: "image_generation" \}\]/);
  assert.match(imageGenerationSource, /imageBase64FromResponsesOutput/);
});

test("Change2Pro image2 preset uses the official Images API mode", () => {
  const providerSettingsSource = readFileSync(new URL("../src/services/ai-provider-settings.js", import.meta.url), "utf8");
  assert.match(providerSettingsSource, /"change2pro-image2": \{[\s\S]*?baseUrl: "https:\/\/api\.change2pro\.com"/);
  assert.match(providerSettingsSource, /"change2pro-image2": \{[\s\S]*?imageModel: "gpt-image-2"/);
  assert.match(providerSettingsSource, /"change2pro-image2": \{[\s\S]*?apiMode: "images"/);
  assert.match(providerSettingsSource, /mode === "images"/);
  assert.match(providerSettingsSource, /return "https:\/\/api\.change2pro\.com"/);
  assert.doesNotMatch(providerSettingsSource, /api\.change2pro\.com\/v1/);
});

test("Change2Pro text and vision providers can retain Responses API mode", () => {
  const providerSettingsSource = readFileSync(new URL("../src/services/ai-provider-settings.js", import.meta.url), "utf8");
  const settingsViewSource = readFileSync(new URL("../frontend/admin/views/settings/AiProviderSettingsView.vue", import.meta.url), "utf8");
  assert.match(providerSettingsSource, /providerKey === "change2pro-image2"/);
  assert.match(settingsViewSource, /providerKey === "change2pro-image2"/);
  assert.doesNotMatch(providerSettingsSource, /haystack\.includes\("api\.change2pro\.com"\)/);
  assert.doesNotMatch(settingsViewSource, /text\.includes\("api\.change2pro\.com"\)/);
});

test("65535 image provider uses v1 async images endpoints", () => {
  assert.match(imageGenerationSource, /is65535ImageHost/);
  assert.match(imageGenerationSource, /img-cn\\\.65535\\\.space/);
  assert.match(imageGenerationSource, /candidates\.push\(`\$\{url\.origin\}\/v1\/images\/\$\{actionPath\}`\)/);
  assert.match(imageGenerationSource, /"X-Async-Mode": "true"/);
  assert.match(imageGenerationSource, /pollAsync65535ImageJob/);
  assert.match(imageGenerationSource, /\/images\/async-generations\//);
  assert.match(imageGenerationSource, /isTransientImagePollingError/);
  assert.match(imageGenerationSource, /response\.status === 429 \|\| response\.status >= 500/);
});

test("AI settings exposes a real image channel test endpoint", () => {
  const providerSettingsSource = readFileSync(new URL("../src/services/ai-provider-settings.js", import.meta.url), "utf8");
  assert.match(imageGenerationSource, /export async function testOpenAiImageProvider/);
  assert.match(providerSettingsSource, /export async function testAiImageProviderChannel/);
  assert.match(serverSource, /POST \/api\/ai-provider\/test-image-channel/);
});

test("AI image pool concurrency follows operator configuration without a fixed ceiling", () => {
  const providerSettingsSource = readFileSync(new URL("../src/services/ai-provider-settings.js", import.meta.url), "utf8");
  const aiSettingsViewSource = readFileSync(new URL("../frontend/admin/views/settings/AiProviderSettingsView.vue", import.meta.url), "utf8");

  assert.match(providerSettingsSource, /maxConcurrency: positiveInteger\(value\?\.maxConcurrency \?\? value\?\.max_concurrency, 20\)/);
  assert.match(providerSettingsSource, /maxConcurrency: positiveInteger\(value\.maxConcurrency \?\? value\.max_concurrency, 20\)/);
  assert.doesNotMatch(providerSettingsSource, /IMAGE_POOL_MAX_CONCURRENCY/);
  assert.match(aiSettingsViewSource, /function normalizeUiConcurrency/);
  assert.match(aiSettingsViewSource, /v-model="imageProviderPool\.maxConcurrency" :min="1" controls-position="right"/);
  assert.match(aiSettingsViewSource, /v-model="channel\.maxConcurrency" :min="1" controls-position="right"/);
  assert.doesNotMatch(aiSettingsViewSource, /IMAGE_POOL_MAX_CONCURRENCY/);
  assert.doesNotMatch(aiSettingsViewSource, /maxConcurrency, 1, 8, 1/);
});

test("AI image source fetch retries draft images with browser-like headers", () => {
  assert.match(workflowSource, /function sourceImageFetchHeaders/);
  assert.match(workflowSource, /User-Agent/);
  assert.match(workflowSource, /Referer/);
  assert.match(workflowSource, /\[401, 403, 404\]\.includes\(response\.status\)/);
  assert.doesNotMatch(workflowSource, /falling back to text-to-image/);
});

test("AI image workflow reads local generated references without HTTP site permissions", () => {
  assert.match(workflowSource, /async function readLocalAiTaskSourceImage/);
  assert.match(workflowSource, /getAiTaskFile\(taskId, scope, filename\)/);
  assert.match(workflowSource, /readLocalAiTaskSourceImage\(source\)/);
});

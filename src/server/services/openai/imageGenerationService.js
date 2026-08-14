import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { clampImageCount } from "./promptService.js";
import { aiImageRuntimeConfig } from "../../../services/ai-provider-settings.js";
import { withAiImageRuntimeSlot } from "../../../services/ai-image-runtime-limiter.js";

export const ROOT_DIR = process.cwd();
export const GENERATED_ROOT = path.resolve(ROOT_DIR, process.env.AI_IMAGE_OUTPUT_DIR || "uploads/ai-generated");

const SIZE_BY_RATIO = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  // gpt-image-1 accepts closest supported portrait size through the Images API.
  "4:5": "1024x1536"
};
const AI_IMAGE_GENERATION_WAIT_MS = Math.max(15000, Number(process.env.AI_IMAGE_GENERATION_WAIT_MS || 300000));
const AI_IMAGE_TRANSPORT_GRACE_MS = Math.max(0, Number(process.env.AI_IMAGE_TRANSPORT_GRACE_MS || 60000));
const AI_IMAGE_PROVIDER_TIMEOUT_MS = AI_IMAGE_GENERATION_WAIT_MS + AI_IMAGE_TRANSPORT_GRACE_MS;
const AI_IMAGE_DOWNLOAD_TIMEOUT_MS = Math.max(10000, Number(process.env.AI_IMAGE_DOWNLOAD_TIMEOUT_MS || 60000));
const AI_IMAGE_DOWNLOAD_ATTEMPTS = Math.max(1, Number(process.env.AI_IMAGE_DOWNLOAD_ATTEMPTS || 3));

export async function generateOpenAiImages({ taskId, finalPrompt, ratio = "3:4", imageCount = 1, runtimeConfig = null, providerJob = null, onProviderJob = null }) {
  const resolvedRuntimeConfig = runtimeConfig || await aiImageRuntimeConfig();
  const safeTaskId = validateTaskId(taskId);
  const count = clampImageCount(imageCount);
  const taskDir = resolveGeneratedTaskDir(safeTaskId);
  await fs.mkdir(taskDir, { recursive: true });

  const generatedImages = [];
  for (let index = 1; index <= count; index += 1) {
    const filename = `generated_${String(index).padStart(3, "0")}.png`;
    const filePath = path.join(taskDir, filename);
    const image = await requestCompatibleImage({
      runtimeConfig: resolvedRuntimeConfig,
      prompt: [String(finalPrompt || "").trim(), `Image ${index} of ${count}.`].filter(Boolean).join("\n"),
      size: SIZE_BY_RATIO[ratio] || SIZE_BY_RATIO["3:4"],
      providerJob: providerJob?.jobs?.[index - 1] || (index === 1 ? providerJob : null),
      onProviderJob: onProviderJob ? (job) => onProviderJob(job, index - 1) : null
    });
    if (image?.remoteUrl) await downloadGeneratedImageToFile(image.remoteUrl, filePath);
    else await fs.writeFile(filePath, image);
    generatedImages.push(createImageRecord(safeTaskId, "generated", filename, filePath));
  }

  return generatedImages;
}

export async function editOpenAiImage({ imageBuffer, imageFilePath = "", prompt, ratio = "3:4", filename = "source.png", contentType = "image/png", runtimeConfig = null, providerJob = null, onProviderJob = null }) {
  const resolvedRuntimeConfig = runtimeConfig || await aiImageRuntimeConfig();
  return requestCompatibleImageEdit({
    runtimeConfig: resolvedRuntimeConfig,
    imageBuffer,
    imageFilePath,
    filename,
    contentType,
    prompt,
    size: SIZE_BY_RATIO[ratio] || SIZE_BY_RATIO["3:4"],
    providerJob,
    onProviderJob
  });
}

export async function testOpenAiImageProvider({ runtimeConfig, mode = "generate" }) {
  const action = mode === "edit" ? "edits" : "generations";
  const endpoints = usesResponsesImage(runtimeConfig)
    ? [responsesEndpoint(runtimeConfig.baseUrl)]
    : usesChatCompletionsImage(runtimeConfig)
      ? [chatCompletionsEndpoint(runtimeConfig.baseUrl)]
      : imageEndpointCandidates(runtimeConfig.baseUrl, action);
  const endpoint = endpoints[0] || "";
  const prompt = "A simple clean ecommerce product photo of a black car center armrest organizer on a white background. No text, no logo.";
  try {
    const image = mode === "edit"
      ? await requestCompatibleImageEdit({
        runtimeConfig,
        imageBuffer: minimalPngBuffer(),
        filename: "test.png",
        contentType: "image/png",
        prompt: "Keep the product centered. Make a clean ecommerce product image on a white background. No text, no logo.",
        size: SIZE_BY_RATIO["1:1"]
      })
      : await requestCompatibleImage({
        runtimeConfig,
        prompt,
        size: SIZE_BY_RATIO["1:1"]
      });
    return {
      ok: true,
      endpoint,
      mode,
      bytes: Buffer.isBuffer(image) ? image.length : 0,
      remoteUrl: image?.remoteUrl || ""
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      mode,
      status: error?.status || 502,
      message: error?.message || "图片通道测试失败"
    };
  }
}

async function requestCompatibleImage({ runtimeConfig, prompt, size, providerJob = null, onProviderJob = null }) {
  if (usesResponsesImage(runtimeConfig)) {
    return withAiImageRuntimeSlot(runtimeConfig, async () => requestResponsesImage({
      runtimeConfig,
      prompt,
      size
    }));
  }
  if (usesChatCompletionsImage(runtimeConfig)) {
    return withAiImageRuntimeSlot(runtimeConfig, async () => requestChatCompletionImage({
      runtimeConfig,
      prompt,
      size
    }));
  }
  const body = {
    model: runtimeConfig.imageModel,
    prompt,
    n: 1,
    size
  };
  return requestImageFromEndpoints({
    runtimeConfig,
    endpoints: imageEndpointCandidates(runtimeConfig.baseUrl, "generations"),
    body,
    fallbackMessage: "Image generation failed",
    providerJob,
    onProviderJob
  });
}

async function requestCompatibleImageEdit({ runtimeConfig, imageBuffer, imageFilePath = "", filename, contentType, prompt, size, providerJob = null, onProviderJob = null }) {
  if (providerJob?.jobId) {
    return requestImageFromEndpoints({
      runtimeConfig,
      endpoints: imageEndpointCandidates(runtimeConfig.baseUrl, "edits"),
      body: null,
      fallbackMessage: "Image edit failed",
      providerJob,
      onProviderJob
    });
  }
  if (usesResponsesImage(runtimeConfig)) {
    return withAiImageRuntimeSlot(runtimeConfig, async () => requestResponsesImage({
      runtimeConfig,
      prompt,
      size,
      imageBuffer: imageBuffer || (imageFilePath ? await fs.readFile(imageFilePath) : null),
      contentType
    }));
  }
  if (usesChatCompletionsImage(runtimeConfig)) {
    return withAiImageRuntimeSlot(runtimeConfig, async () => requestChatCompletionImage({
      runtimeConfig,
      prompt,
      size,
      imageBuffer: imageBuffer || (imageFilePath ? await fs.readFile(imageFilePath) : null),
      filename,
      contentType
    }));
  }
  const form = new FormData();
  form.append("model", runtimeConfig.imageModel);
  const imageBlob = imageFilePath && fsSync.openAsBlob
    ? await fsSync.openAsBlob(imageFilePath, { type: contentType })
    : new Blob([imageBuffer], { type: contentType });
  form.append("image", imageBlob, filename);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  return requestImageFromEndpoints({
    runtimeConfig,
    endpoints: imageEndpointCandidates(runtimeConfig.baseUrl, "edits"),
    body: form,
    fallbackMessage: "Image edit failed",
    providerJob,
    onProviderJob
  });
}

async function requestResponsesImage({ runtimeConfig, prompt, size, imageBuffer = null, contentType = "image/png" }) {
  const endpoint = responsesEndpoint(runtimeConfig.baseUrl);
  const content = [{ type: "input_text", text: responsesImagePrompt(prompt, size) }];
  if (imageBuffer) {
    content.push({
      type: "input_image",
      image_url: `data:${contentType};base64,${Buffer.from(imageBuffer).toString("base64")}`
    });
  }
  const body = {
    model: runtimeConfig.imageModel,
    input: [{ role: "user", content }],
    tools: [{ type: "image_generation" }]
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtimeConfig.apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_IMAGE_PROVIDER_TIMEOUT_MS)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Responses image generation failed: ${response.status}`;
    const error = new Error(`${message} (${endpoint})`);
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }
  return imageBufferFromProviderResponse(data, endpoint);
}

function responsesImagePrompt(prompt, size) {
  return [
    String(prompt || "").trim(),
    `Output one ecommerce product image. Preferred size: ${size}.`,
    "Return the generated image through the image_generation tool result."
  ].filter(Boolean).join("\n");
}

async function requestChatCompletionImage({ runtimeConfig, prompt, size, imageBuffer = null, contentType = "image/png" }) {
  const endpoint = chatCompletionsEndpoint(runtimeConfig.baseUrl);
  const body = {
    model: runtimeConfig.imageModel,
    messages: [
      {
        role: "user",
        content: chatImageContent({ prompt, size, imageBuffer, contentType })
      }
    ]
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtimeConfig.apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_IMAGE_PROVIDER_TIMEOUT_MS)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Chat image generation failed: ${response.status}`;
    const error = new Error(`${message} (${endpoint})`);
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }
  return imageBufferFromProviderResponse(data, endpoint);
}

function chatImageContent({ prompt, size, imageBuffer, contentType }) {
  const text = [
    String(prompt || "").trim(),
    `Output one ecommerce product image. Preferred size: ${size}.`,
    "Return the generated image as an image URL or base64 image data; do not return only descriptive text."
  ].filter(Boolean).join("\n");
  const content = [{ type: "text", text }];
  if (imageBuffer) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${contentType};base64,${Buffer.from(imageBuffer).toString("base64")}`
      }
    });
  }
  return content;
}

async function requestImageFromEndpoints({ runtimeConfig, endpoints, body, fallbackMessage, providerJob = null, onProviderJob = null }) {
  if (providerJob?.jobId) {
    return pollAsync65535ImageJob({ runtimeConfig, endpoint: providerJob.endpoint || endpoints[0] || "", job: {
      job_id: providerJob.jobId,
      status_url: providerJob.statusUrl || ""
    } });
  }
  let lastError = null;
  for (const endpoint of endpoints) {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const useAsync65535 = usesAsync65535Image(runtimeConfig, endpoint);
    const { response, data, image } = await withAiImageRuntimeSlot(runtimeConfig, async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtimeConfig.apiKey}`,
          ...(useAsync65535 ? { "X-Async-Mode": "true" } : {}),
          ...(isForm ? {} : { "Content-Type": "application/json" })
        },
        body: isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(AI_IMAGE_PROVIDER_TIMEOUT_MS)
      });
      const data = await response.json().catch(() => ({}));
      const image = response.ok && !(useAsync65535 && response.status === 202 && data?.job_id)
        ? imageBufferFromProviderResponse(data, endpoint)
        : null;
      return { response, data, image };
    });
    if (useAsync65535 && response.status === 202 && data?.job_id) {
      await onProviderJob?.({
        provider: runtimeConfig.provider || "",
        channelId: runtimeConfig.channelId || "",
        channelName: runtimeConfig.channelName || runtimeConfig.name || "",
        jobId: String(data.job_id),
        statusUrl: async65535StatusUrl(runtimeConfig, endpoint, data),
        endpoint,
        submittedAt: new Date().toISOString()
      });
      return pollAsync65535ImageJob({ runtimeConfig, endpoint, job: data });
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `${fallbackMessage}: ${response.status}`;
      lastError = new Error(`${message} (${endpoint})`);
      lastError.status = response.status >= 400 && response.status < 500 ? 400 : 502;
      if (response.status === 404 && endpoints.length > 1) continue;
      throw lastError;
    }

    return image;
  }

  if (lastError) throw lastError;
  const error = new Error(`${fallbackMessage}: no endpoint available`);
  error.status = 502;
  throw error;
}

async function pollAsync65535ImageJob({ runtimeConfig, endpoint, job }) {
  const statusUrl = async65535StatusUrl(runtimeConfig, endpoint, job);
  const started = Date.now();
  let lastPayload = null;
  while (Date.now() - started < AI_IMAGE_GENERATION_WAIT_MS) {
    await delay(2000);
    let response;
    try {
      response = await fetch(statusUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${runtimeConfig.apiKey}`
        },
        signal: AbortSignal.timeout(AI_IMAGE_DOWNLOAD_TIMEOUT_MS)
      });
    } catch (error) {
      if (isTransientImagePollingError(error)) continue;
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    lastPayload = payload;
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) continue;
      const message = payload?.error?.message || payload?.message || `Async image status failed: ${response.status}`;
      const error = new Error(`${message} (${statusUrl})`);
      error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw error;
    }
    const data = payload?.data || payload;
    const status = String(data?.status || "").toLowerCase();
    if (status === "done" || status === "succeeded" || status === "success") {
      return imageBufferFromProviderResponse({
        data: (data.result_urls || data.urls || []).map((url) => ({ url })),
        url: data.result_urls?.[0] || data.url || ""
      }, statusUrl);
    }
    if (status === "failed" || status === "error") {
      const error = new Error(`${data.error_message || payload?.message || "Async image generation failed"} (${statusUrl})`);
      error.status = 502;
      throw error;
    }
  }
  const error = new Error(`Async image generation exceeded ${Math.ceil(AI_IMAGE_GENERATION_WAIT_MS / 1000)} seconds: ${lastPayload?.data?.status || lastPayload?.status || "pending"} (${statusUrl})`);
  error.status = 504;
  error.code = "provider_pending";
  throw error;
}

function isTransientImagePollingError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return error?.name === "TimeoutError"
    || error?.name === "AbortError"
    || /fetch failed|network|socket|econnreset|etimedout/.test(message);
}

function async65535StatusUrl(runtimeConfig = {}, endpoint = "", job = {}) {
  const statusUrl = String(job.status_url || "").trim();
  if (/^https?:\/\//i.test(statusUrl)) return statusUrl;
  const base = async65535ApiBase(runtimeConfig.baseUrl || endpoint);
  if (statusUrl.startsWith("/")) return `${base.origin}${statusUrl}`;
  return `${base.apiBase}/images/async-generations/${encodeURIComponent(job.job_id)}`;
}

function async65535ApiBase(value = "") {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    const origin = url.origin;
    const path = url.pathname.toLowerCase();
    const apiBase = path.includes("/v1") ? `${origin}/v1` : `${origin}/v1`;
    return { origin, apiBase };
  } catch {
    return { origin: "", apiBase: String(value || "").replace(/\/+$/, "") };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageBufferFromProviderResponse(data = {}, endpoint = "") {
  const first = data?.data?.[0] || data?.images?.[0] || data?.result?.[0] || data?.output?.[0] || data?.choices?.[0] || null;
  const message = first?.message || first?.delta || data?.message || null;
  const content = message?.content || first?.content || data?.content || "";
  const b64 = first?.b64_json
    || first?.base64
    || first?.image_base64
    || message?.image_base64
    || data?.b64_json
    || data?.base64
    || imageBase64FromResponsesOutput(data?.output)
    || imageBase64FromContent(content);
  if (b64) return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ""), "base64");
  const imageUrl = first?.url
    || first?.image_url
    || first?.imageUrl
    || message?.image_url
    || data?.url
    || data?.image_url
    || imageUrlFromContent(content);
  if (imageUrl) return { remoteUrl: String(imageUrl) };

  const error = new Error(`AI image provider did not return image data (${endpoint})`);
  error.status = 502;
  throw error;
}

export async function downloadGeneratedImageToFile(imageUrl, filePath) {
  let lastError = null;
  for (let attempt = 1; attempt <= AI_IMAGE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(imageUrl, { signal: AbortSignal.timeout(AI_IMAGE_DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok || !response.body) throw Object.assign(new Error(`Failed to stream generated image: ${response.status}`), { status: response.status >= 500 ? 502 : 400 });
      await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(filePath));
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(filePath, { force: true }).catch(() => {});
      if (attempt >= AI_IMAGE_DOWNLOAD_ATTEMPTS || !(isTransientImagePollingError(error) || Number(error?.status || 0) === 502)) break;
      await delay(1000 * attempt);
    }
  }
  throw lastError || new Error("Failed to stream generated image");
}

function imageBase64FromContent(content) {
  const values = contentValues(content);
  for (const value of values) {
    const match = String(value || "").match(/data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)/i);
    if (match?.[1]) return match[1];
  }
  return "";
}

function imageBase64FromResponsesOutput(output) {
  const items = Array.isArray(output) ? output : [];
  for (const item of items) {
    if (typeof item?.result === "string") return item.result;
    if (typeof item?.image_base64 === "string") return item.image_base64;
    if (typeof item?.b64_json === "string") return item.b64_json;
    const nested = imageBase64FromContent(item?.content);
    if (nested) return nested;
  }
  return "";
}

function imageUrlFromContent(content) {
  const values = contentValues(content);
  for (const value of values) {
    if (typeof value === "string") {
      const markdown = value.match(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i);
      if (markdown?.[1]) return markdown[1];
      const plain = value.match(/https?:\/\/\S+\.(?:png|jpe?g|webp)(?:\?\S*)?/i);
      if (plain?.[0]) return plain[0];
      try {
        const parsed = JSON.parse(value);
        const nested = imageUrlFromContent(parsed);
        if (nested) return nested;
      } catch {}
    } else if (value && typeof value === "object") {
      const url = value.url || value.image_url || value.imageUrl || value.src;
      if (url) return String(url);
    }
  }
  return "";
}

function contentValues(content) {
  if (!content) return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [content];
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    return [
      item.text,
      item.content,
      item.url,
      item.image_url,
      item.imageUrl,
      item.image_url?.url,
      item.imageUrl?.url,
      item.data,
      item.b64_json,
      item.base64,
      item.image_base64
    ].filter(Boolean);
  });
}

function usesChatCompletionsImage(runtimeConfig = {}) {
  const provider = String(runtimeConfig.provider || "").toLowerCase();
  const model = String(runtimeConfig.imageModel || "").trim().toLowerCase();
  const baseUrl = String(runtimeConfig.baseUrl || "").toLowerCase();
  const isCctqHost = /(^|\/\/|\.)(cctq\.ai|code\.b886\.top|api-cf\.b886\.top)(\/|$)/i.test(baseUrl);
  return model === "gpt-image-2" && (provider === "cctq-image2" || isCctqHost);
}

function usesResponsesImage(runtimeConfig = {}) {
  return String(runtimeConfig.apiMode || "").toLowerCase() === "responses";
}

function responsesEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base.toLowerCase().endsWith("/responses") ? base : `${base}/responses`;
}

function chatCompletionsEndpoint(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return base.toLowerCase().endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function imageEndpointCandidates(baseUrl, action) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return [];
  const lower = base.toLowerCase();
  const actionPath = action === "edits" ? "edits" : "generations";
  const candidates = [];
  if (is65535ImageHost(lower)) {
    const url = new URL(base);
    candidates.push(`${url.origin}/v1/images/${actionPath}`);
  }
  if (lower.includes("www.cctq.ai") || lower.includes("cctq.ai")) {
    candidates.push(`https://www.cctq.ai/v1/images/${actionPath}`);
  }
  if (lower.includes("code.b886.top") || lower.includes("api-cf.b886.top")) {
    const hostBase = lower.includes("api-cf.b886.top") ? "https://api-cf.b886.top" : "https://code.b886.top";
    candidates.push(`${hostBase}/v1/images/${actionPath}`);
  }
  if (lower.endsWith(`/images/${actionPath}`)) candidates.push(base);
  if (lower.endsWith("/images")) candidates.push(`${base}/${actionPath}`);
  candidates.push(`${base}/images/${actionPath}`);
  return Array.from(new Set(candidates));
}

function usesAsync65535Image(runtimeConfig = {}, endpoint = "") {
  return is65535ImageHost([runtimeConfig.baseUrl, endpoint].join(" "));
}

function is65535ImageHost(value = "") {
  return /(^|\/\/|\.)img-cn\.65535\.space(\/|$)/i.test(String(value || ""));
}

function minimalPngBuffer() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAWklEQVR4nO3PQQ3AIADAQMDK/5MZCEkTZZLsnl3vOQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4Gp7bQABZxAGvQAAAABJRU5ErkJggg==",
    "base64"
  );
}

export function createImageRecord(taskId, scope, filename, filePath) {
  return {
    filename,
    url: fileUrl(taskId, scope, filename),
    path: path.relative(ROOT_DIR, filePath).replace(/\\/g, "/")
  };
}

export function resolveGeneratedTaskDir(taskId) {
  return path.resolve(GENERATED_ROOT, validateTaskId(taskId));
}

export function resolveGeneratedImagePath(taskId, filename) {
  const root = resolveGeneratedTaskDir(taskId);
  const filePath = path.resolve(root, String(filename || "").replace(/\\/g, "/"));
  if (!filePath.startsWith(root)) {
    const error = new Error("Illegal generated image path");
    error.status = 400;
    throw error;
  }
  return filePath;
}

export function fileUrl(taskId, scope, filename) {
  return `/api/ai/file/${encodeURIComponent(taskId)}/${scope}/${String(filename).split("/").map(encodeURIComponent).join("/")}`;
}

export function validateTaskId(taskId) {
  const safeTaskId = String(taskId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(safeTaskId)) {
    const error = new Error("Invalid taskId");
    error.status = 400;
    throw error;
  }
  return safeTaskId;
}

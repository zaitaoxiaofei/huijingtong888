import fs from "node:fs/promises";
import path from "node:path";
import { clampImageCount } from "./promptService.js";
import { aiImageRuntimeConfig } from "../../../services/ai-provider-settings.js";

export const ROOT_DIR = process.cwd();
export const GENERATED_ROOT = path.resolve(ROOT_DIR, process.env.AI_IMAGE_OUTPUT_DIR || "uploads/ai-generated");

const SIZE_BY_RATIO = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  // gpt-image-1 accepts closest supported portrait size through the Images API.
  "4:5": "1024x1536"
};
const AI_IMAGE_PROVIDER_TIMEOUT_MS = Math.max(15000, Number(process.env.AI_IMAGE_PROVIDER_TIMEOUT_MS || 120000));
const AI_IMAGE_DOWNLOAD_TIMEOUT_MS = Math.max(10000, Number(process.env.AI_IMAGE_DOWNLOAD_TIMEOUT_MS || 30000));

export async function generateOpenAiImages({ taskId, finalPrompt, ratio = "3:4", imageCount = 1 }) {
  const runtimeConfig = await aiImageRuntimeConfig();
  const safeTaskId = validateTaskId(taskId);
  const count = clampImageCount(imageCount);
  const taskDir = resolveGeneratedTaskDir(safeTaskId);
  await fs.mkdir(taskDir, { recursive: true });

  const generatedImages = [];
  for (let index = 1; index <= count; index += 1) {
    const filename = `generated_${String(index).padStart(3, "0")}.png`;
    const filePath = path.join(taskDir, filename);
    const image = await requestCompatibleImage({
      runtimeConfig,
      prompt: [String(finalPrompt || "").trim(), `Image ${index} of ${count}.`].filter(Boolean).join("\n"),
      size: SIZE_BY_RATIO[ratio] || SIZE_BY_RATIO["3:4"]
    });
    await fs.writeFile(filePath, image);
    generatedImages.push(createImageRecord(safeTaskId, "generated", filename, filePath));
  }

  return generatedImages;
}

export async function editOpenAiImage({ imageBuffer, prompt, ratio = "3:4", filename = "source.png", contentType = "image/png" }) {
  const runtimeConfig = await aiImageRuntimeConfig();
  return requestCompatibleImageEdit({
    runtimeConfig,
    imageBuffer,
    filename,
    contentType,
    prompt,
    size: SIZE_BY_RATIO[ratio] || SIZE_BY_RATIO["3:4"]
  });
}

async function requestCompatibleImage({ runtimeConfig, prompt, size }) {
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
    fallbackMessage: "Image generation failed"
  });
}

async function requestCompatibleImageEdit({ runtimeConfig, imageBuffer, filename, contentType, prompt, size }) {
  const form = new FormData();
  form.append("model", runtimeConfig.imageModel);
  form.append("image", new Blob([imageBuffer], { type: contentType }), filename);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  return requestImageFromEndpoints({
    runtimeConfig,
    endpoints: imageEndpointCandidates(runtimeConfig.baseUrl, "edits"),
    body: form,
    fallbackMessage: "Image edit failed"
  });
}

async function requestImageFromEndpoints({ runtimeConfig, endpoints, body, fallbackMessage }) {
  let lastError = null;
  for (const endpoint of endpoints) {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeConfig.apiKey}`,
        ...(isForm ? {} : { "Content-Type": "application/json" })
      },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(AI_IMAGE_PROVIDER_TIMEOUT_MS)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `${fallbackMessage}: ${response.status}`;
      lastError = new Error(`${message} (${endpoint})`);
      lastError.status = response.status >= 400 && response.status < 500 ? 400 : 502;
      if (response.status === 404 && endpoints.length > 1) continue;
      throw lastError;
    }

    const first = data?.data?.[0] || data?.images?.[0] || data?.result?.[0] || data?.output?.[0];
    const b64 = first?.b64_json || first?.base64 || first?.image_base64 || data?.b64_json || data?.base64;
    if (b64) return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ""), "base64");
    const imageUrl = first?.url || first?.image_url || first?.imageUrl || data?.url || data?.image_url;
    if (imageUrl) {
      const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(AI_IMAGE_DOWNLOAD_TIMEOUT_MS) });
      if (!imageResponse.ok) {
        const error = new Error(`Failed to download generated image: ${imageResponse.status}`);
        error.status = 502;
        throw error;
      }
      return Buffer.from(await imageResponse.arrayBuffer());
    }

    const error = new Error("AI image provider did not return image data");
    error.status = 502;
    throw error;
  }

  if (lastError) throw lastError;
  const error = new Error(`${fallbackMessage}: no endpoint available`);
  error.status = 502;
  throw error;
}

function imageEndpointCandidates(baseUrl, action) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return [];
  const lower = base.toLowerCase();
  const actionPath = action === "edits" ? "edits" : "generations";
  const candidates = [];
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

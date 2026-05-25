import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { buildZip, runPythonCropper } from "./imageCropperService.js";

const ROOT_DIR = process.cwd();
const GENERATED_ROOT = path.resolve(ROOT_DIR, "uploads", "ai-generated");
const CROPPED_ROOT = path.resolve(ROOT_DIR, "uploads", "ai-cropped");
const MAX_GENERATE_COUNT = 4;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const STYLE_PROMPTS = {
  ozon_click_main: "Ozon marketplace high-click main image, clean commercial layout, strong product focus, high contrast, persuasive e-commerce composition",
  premium_main: "premium high-end product main image, refined lighting, realistic material texture, luxury commercial photography style",
  white_background: "white background product image, studio lighting, clean edges, marketplace-ready catalog photo",
  detail_scene: "e-commerce detail page scene image, realistic usage scenario, product benefits clearly visualized, professional commercial composition"
};

const SIZE_BY_RATIO = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  "4:5": "1024x1536"
};

export async function generateAiImages(payload = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("OPENAI_API_KEY is not configured on the backend");
    error.status = 500;
    throw error;
  }

  const taskId = crypto.randomUUID();
  const count = clampInteger(payload.count, 1, MAX_GENERATE_COUNT);
  const ratio = normalizeChoice(payload.ratio, ["3:4", "1:1", "4:5"], "1:1");
  const style = normalizeChoice(payload.style, Object.keys(STYLE_PROMPTS), "ozon_click_main");
  const prompt = buildGenerationPrompt({ ...payload, ratio, style });

  const taskDir = resolveGeneratedTaskDir(taskId);
  await fs.mkdir(taskDir, { recursive: true });

  const savedImages = [];
  for (let index = 1; index <= count; index += 1) {
    const buffer = await requestOpenAiImage({
      apiKey,
      prompt: `${prompt}\nImage ${index} of ${count}.`,
      size: SIZE_BY_RATIO[ratio] || "1024x1024"
    });
    if (buffer.length > MAX_IMAGE_BYTES) {
      const error = new Error("Generated image exceeds 25MB limit");
      error.status = 413;
      throw error;
    }
    const filename = `generated_${String(index).padStart(3, "0")}.png`;
    const filePath = path.join(taskDir, filename);
    await fs.writeFile(filePath, buffer);
    savedImages.push(imageRecord(taskId, filename, filePath, index));
  }

  return {
    taskId,
    prompt,
    ratio,
    style,
    images: savedImages,
    zipUrl: `/api/tools/ai-image-generator/download-zip/${encodeURIComponent(taskId)}`
  };
}

export async function cropAiImages({ taskId, imagePaths }) {
  const safeTaskId = validateTaskId(taskId);
  const generatedTaskDir = resolveGeneratedTaskDir(safeTaskId);
  const croppedTaskDir = resolveCroppedTaskDir(safeTaskId);
  await fs.mkdir(croppedTaskDir, { recursive: true });

  const sources = normalizeImagePaths(imagePaths);
  const crops = [];
  let imageIndex = 0;

  for (const relativePath of sources) {
    imageIndex += 1;
    const sourcePath = resolveGeneratedPath(relativePath);
    if (!sourcePath.startsWith(generatedTaskDir)) {
      const error = new Error("Image path does not belong to this task");
      error.status = 400;
      throw error;
    }

    const perImageOutput = path.join(croppedTaskDir, `image_${String(imageIndex).padStart(3, "0")}`);
    await fs.mkdir(perImageOutput, { recursive: true });
    const result = await runPythonCropper(sourcePath, perImageOutput, safeTaskId);
    for (const crop of result.crops || []) {
      const storedFilename = path.join(path.basename(perImageOutput), crop.filename).replace(/\\/g, "/");
      crops.push({
        ...crop,
        sourceImage: path.basename(sourcePath),
        filename: storedFilename,
        url: fileUrl(safeTaskId, "cropped", storedFilename),
        downloadUrl: `/api/tools/ai-image-generator/file/${encodeURIComponent(safeTaskId)}/cropped/${storedFilename.split("/").map(encodeURIComponent).join("/")}`
      });
    }
  }

  return {
    taskId: safeTaskId,
    crops,
    zipUrl: `/api/tools/ai-image-generator/download-zip/${encodeURIComponent(safeTaskId)}`
  };
}

export async function getAiTaskFile(taskId, scope, filename) {
  const safeTaskId = validateTaskId(taskId);
  const root = scope === "generated" ? resolveGeneratedTaskDir(safeTaskId) : resolveCroppedTaskDir(safeTaskId);
  const filePath = path.resolve(root, String(filename || "").replace(/\\/g, "/"));
  if (!filePath.startsWith(root)) {
    const error = new Error("Illegal file path");
    error.status = 400;
    throw error;
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    const error = new Error("File not found");
    error.status = 404;
    throw error;
  }
  return {
    filePath,
    filename: path.basename(filePath),
    size: stat.size,
    contentType: contentTypeFor(filePath)
  };
}

export async function createAiTaskZip(taskId) {
  const safeTaskId = validateTaskId(taskId);
  const generatedFiles = await collectImageFiles(resolveGeneratedTaskDir(safeTaskId), "generated");
  const croppedFiles = await collectImageFiles(resolveCroppedTaskDir(safeTaskId), "cropped");
  const files = [...generatedFiles, ...croppedFiles];
  if (!files.length) {
    const error = new Error("No images available for download");
    error.status = 404;
    throw error;
  }
  return {
    filename: `ai-image-generator-${safeTaskId}.zip`,
    buffer: buildZip(files)
  };
}

export function streamAiFile(filePath) {
  return createReadStream(filePath);
}

export function buildOptimizedPrompt(payload = {}) {
  return buildGenerationPrompt(payload);
}

function buildGenerationPrompt({ productName, carModel, sellingPoints, style, ratio, prompt }) {
  const lines = [
    "Create a professional e-commerce product image set for Ozon marketplace.",
    `Product: ${cleanText(productName) || "auto accessory product"}.`,
    cleanText(carModel) ? `Compatible car model: ${cleanText(carModel)}.` : "",
    cleanText(sellingPoints) ? `Key selling points: ${cleanText(sellingPoints)}.` : "",
    STYLE_PROMPTS[style] || STYLE_PROMPTS.ozon_click_main,
    cleanText(prompt) ? `User creative direction: ${cleanText(prompt)}.` : "",
    `Aspect ratio: ${ratio || "1:1"}.`,
    "Use realistic product rendering, readable commercial composition, no fake platform logos, no misleading brand marks, no watermarks."
  ];
  return lines.filter(Boolean).join("\n");
}

async function requestOpenAiImage({ apiKey, prompt, size }) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
      prompt,
      n: 1,
      size
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI image generation failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }

  const first = data?.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
  if (first?.url) {
    const imageResponse = await fetch(first.url);
    if (!imageResponse.ok) throw new Error(`Failed to download generated image: ${imageResponse.status}`);
    return Buffer.from(await imageResponse.arrayBuffer());
  }

  throw new Error("OpenAI did not return image data");
}

async function collectImageFiles(root, prefix) {
  const files = [];
  await walk(root, async (filePath) => {
    if (!ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
    const relativeName = path.relative(root, filePath).replace(/\\/g, "/");
    files.push({
      name: `${prefix}/${relativeName}`,
      data: await fs.readFile(filePath)
    });
  });
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

async function walk(dir, visitor) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(filePath, visitor);
    if (entry.isFile()) await visitor(filePath);
  }
}

function normalizeImagePaths(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  const clean = list.map((item) => String(item || "").trim()).filter(Boolean);
  if (!clean.length) {
    const error = new Error("No generated image path provided");
    error.status = 400;
    throw error;
  }
  return clean.slice(0, MAX_GENERATE_COUNT);
}

function imageRecord(taskId, filename, filePath, index) {
  return {
    id: `generated-${String(index).padStart(3, "0")}`,
    filename,
    imagePath: `${taskId}/${filename}`,
    url: fileUrl(taskId, "generated", filename),
    downloadUrl: fileUrl(taskId, "generated", filename)
  };
}

function fileUrl(taskId, scope, filename) {
  return `/api/tools/ai-image-generator/file/${encodeURIComponent(taskId)}/${scope}/${filename.split("/").map(encodeURIComponent).join("/")}`;
}

function resolveGeneratedTaskDir(taskId) {
  return path.resolve(GENERATED_ROOT, validateTaskId(taskId));
}

function resolveCroppedTaskDir(taskId) {
  return path.resolve(CROPPED_ROOT, validateTaskId(taskId));
}

function resolveGeneratedPath(relativePath) {
  const clean = String(relativePath || "").replace(/\\/g, "/");
  const absolutePath = path.resolve(GENERATED_ROOT, clean);
  if (!absolutePath.startsWith(GENERATED_ROOT)) {
    const error = new Error("Illegal generated image path");
    error.status = 400;
    throw error;
  }
  return absolutePath;
}

function validateTaskId(taskId) {
  const safeTaskId = String(taskId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(safeTaskId)) {
    const error = new Error("Invalid taskId");
    error.status = 400;
    throw error;
  }
  return safeTaskId;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeChoice(value, allowed, fallback) {
  const normalized = String(value || "").trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

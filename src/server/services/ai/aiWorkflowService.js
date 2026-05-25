import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { buildZip, runPythonCropper } from "../tools/imageCropperService.js";
import { getOpenAiConfigStatus } from "../openai/openaiClient.js";
import { buildFallbackPrompt, clampImageCount, optimizeImagePrompt } from "../openai/promptService.js";
import {
  GENERATED_ROOT,
  ROOT_DIR,
  createImageRecord,
  generateOpenAiImages,
  resolveGeneratedImagePath,
  resolveGeneratedTaskDir,
  validateTaskId
} from "../openai/imageGenerationService.js";

const CROPPED_ROOT = path.resolve(ROOT_DIR, process.env.AI_CROP_OUTPUT_DIR || "uploads/ai-cropped");
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function getAiStatus() {
  return getOpenAiConfigStatus();
}

export async function optimizePrompt(payload = {}) {
  try {
    return await optimizeImagePrompt(payload);
  } catch (error) {
    if (error.status === 503) throw error;
    console.error("AI prompt optimization failed", error);
    const publicError = new Error("提示词优化失败，请稍后重试");
    publicError.status = error.status || 502;
    throw publicError;
  }
}

export async function generateImages(payload = {}) {
  const taskId = crypto.randomUUID();
  const ratio = normalizeRatio(payload.ratio);
  const imageCount = clampImageCount(payload.imageCount ?? payload.count);
  const finalPrompt = String(payload.finalPrompt || payload.prompt || "").trim();
  if (!finalPrompt) {
    const error = new Error("finalPrompt 不能为空");
    error.status = 400;
    throw error;
  }

  try {
    const generatedImages = await generateOpenAiImages({ taskId, finalPrompt, ratio, imageCount });
    const crop = payload.autoCrop === false
      ? { croppedImages: [], cropStatus: "skipped" }
      : await cropGeneratedImages({ taskId, generatedImages, cropMode: payload.cropMode || "auto" });
    return {
      taskId,
      generatedImages,
      croppedImages: crop.croppedImages,
      cropStatus: crop.cropStatus,
      cropMessage: crop.cropMessage,
      zipUrl: zipUrl(taskId)
    };
  } catch (error) {
    console.error("AI image generation failed", error);
    const publicError = new Error(error.status === 503 ? error.message : "图片生成失败，请检查提示词或稍后重试");
    publicError.status = error.status || 502;
    throw publicError;
  }
}

export async function generateWorkflow(payload = {}) {
  const promptResult = await optimizePrompt(payload).catch((error) => {
    if (error.status === 503) throw error;
    console.error("Workflow prompt optimization failed, using fallback prompt", error);
    return buildFallbackPrompt(payload);
  });
  const imageResult = await generateImages({
    finalPrompt: promptResult.finalPrompt,
    ratio: payload.ratio,
    imageCount: payload.imageCount ?? payload.count,
    autoCrop: payload.autoCrop,
    cropMode: payload.cropMode || "auto"
  });

  return {
    taskId: imageResult.taskId,
    finalPrompt: promptResult.finalPrompt,
    negativePrompt: promptResult.negativePrompt,
    titleSuggestion: promptResult.titleSuggestion,
    detailPagePlan: promptResult.detailPagePlan,
    generatedImages: imageResult.generatedImages,
    croppedImages: imageResult.croppedImages,
    cropStatus: imageResult.cropStatus,
    cropMessage: imageResult.cropMessage,
    zipUrl: imageResult.zipUrl
  };
}

export async function cropGeneratedImages({ taskId, generatedImages = [], cropMode = "auto" }) {
  const safeTaskId = validateTaskId(taskId);
  const croppedTaskDir = resolveCroppedTaskDir(safeTaskId);
  await fs.mkdir(croppedTaskDir, { recursive: true });

  try {
    const croppedImages = [];
    let cropIndex = 0;
    for (const image of generatedImages) {
      const sourceFilename = image.filename || path.basename(image.path || "");
      const sourcePath = resolveGeneratedImagePath(safeTaskId, sourceFilename);
      const tempOutputDir = path.join(croppedTaskDir, `.source_${String(cropIndex + 1).padStart(3, "0")}`);
      await fs.mkdir(tempOutputDir, { recursive: true });
      const result = await runPythonCropper(sourcePath, tempOutputDir, safeTaskId, { mode: cropMode || "auto" });
      for (const crop of result.crops || []) {
        cropIndex += 1;
        const filename = `crop_${String(cropIndex).padStart(3, "0")}.png`;
        const targetPath = path.join(croppedTaskDir, filename);
        await fs.copyFile(path.join(tempOutputDir, crop.filename), targetPath);
        croppedImages.push({
          ...createImageRecord(safeTaskId, "cropped", filename, targetPath),
          sourceImage: sourceFilename,
          x: crop.x,
          y: crop.y,
          width: crop.width,
          height: crop.height
        });
      }
      await fs.rm(tempOutputDir, { recursive: true, force: true });
    }

    return { croppedImages, cropStatus: "success" };
  } catch (error) {
    console.error("AI auto crop failed", error);
    return {
      croppedImages: [],
      cropStatus: "failed",
      cropMessage: "自动裁切失败，可手动进入拆分器处理"
    };
  }
}

export async function getAiTaskFile(taskId, scope, filename) {
  const safeTaskId = validateTaskId(taskId);
  const root = scope === "cropped" ? resolveCroppedTaskDir(safeTaskId) : resolveGeneratedTaskDir(safeTaskId);
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
  return { filePath, size: stat.size, contentType: contentTypeFor(filePath) };
}

export async function createAiTaskZip(taskId) {
  const safeTaskId = validateTaskId(taskId);
  const generatedFiles = await collectImageFiles(path.resolve(GENERATED_ROOT, safeTaskId), "generated");
  const croppedFiles = await collectImageFiles(resolveCroppedTaskDir(safeTaskId), "cropped");
  const files = [...generatedFiles, ...croppedFiles];
  if (!files.length) {
    const error = new Error("No images available for download");
    error.status = 404;
    throw error;
  }
  return {
    filename: `ai-generated-${safeTaskId}.zip`,
    buffer: buildZip(files)
  };
}

export function streamAiFile(filePath) {
  return createReadStream(filePath);
}

function resolveCroppedTaskDir(taskId) {
  return path.resolve(CROPPED_ROOT, validateTaskId(taskId));
}

async function collectImageFiles(root, prefix) {
  const files = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const filePath = path.join(root, entry.name);
    files.push({ name: `${prefix}/${entry.name}`, data: await fs.readFile(filePath) });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
}

function normalizeRatio(value) {
  const ratio = String(value || "").trim();
  return ["3:4", "1:1", "4:5"].includes(ratio) ? ratio : "3:4";
}

function zipUrl(taskId) {
  return `/api/ai/download-zip/${encodeURIComponent(taskId)}`;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

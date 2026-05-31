import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { buildZip, runPythonCropper } from "../tools/imageCropperService.js";
import { aiProviderConfig, chatWithAiProvider } from "../../../services/ai-provider-settings.js";
import { buildFallbackPrompt, clampImageCount, optimizeImagePrompt } from "../openai/promptService.js";
import {
  GENERATED_ROOT,
  ROOT_DIR,
  createImageRecord,
  editOpenAiImage,
  generateOpenAiImages,
  resolveGeneratedImagePath,
  resolveGeneratedTaskDir,
  validateTaskId
} from "../openai/imageGenerationService.js";

const CROPPED_ROOT = path.resolve(ROOT_DIR, process.env.AI_CROP_OUTPUT_DIR || "uploads/ai-cropped");
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export async function getAiStatus() {
  return aiProviderConfig().then((providerConfig) => ({
    configured: Boolean(providerConfig.enabled && providerConfig.hasApiKey && providerConfig.imageModel),
    provider: providerConfig.provider,
    name: providerConfig.name,
    textModel: providerConfig.textModel,
    imageModel: providerConfig.imageModel
  }));
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
    const sourceImage = await resolveSourceImage(payload);
    const generatedImages = sourceImage
      ? await generateImageEdits({ taskId, finalPrompt, ratio, imageCount, sourceImage })
      : await generateOpenAiImages({ taskId, finalPrompt, ratio, imageCount });
    const crop = payload.autoCrop === false
      ? { croppedImages: [], cropStatus: "skipped" }
      : await cropGeneratedImages({ taskId, generatedImages, cropMode: payload.cropMode || "auto" });
    return {
      taskId,
      generationMode: sourceImage ? "image_to_image" : "text_to_image",
      generatedImages,
      croppedImages: crop.croppedImages,
      cropStatus: crop.cropStatus,
      cropMessage: crop.cropMessage,
      zipUrl: zipUrl(taskId)
    };
  } catch (error) {
    console.error("AI image generation failed", error);
    const detail = error?.message ? `：${error.message}` : "";
    const isSourceImageError = String(error?.message || "").includes("参考图");
    const publicError = new Error(
      error.status === 503
        ? error.message
        : isSourceImageError
          ? `图片生成失败，请检查参考图是否可访问、格式是否为 PNG/JPG/WEBP${detail}`
          : `图片生成失败，请检查提示词、图生图服务配置或服务商返回结果${detail}`
    );
    publicError.status = error.status || 502;
    throw publicError;
  }
}

async function generateImageEdits({ taskId, finalPrompt, ratio, imageCount, sourceImage }) {
  const safeTaskId = validateTaskId(taskId);
  const count = clampImageCount(imageCount);
  const taskDir = resolveGeneratedTaskDir(safeTaskId);
  await fs.mkdir(taskDir, { recursive: true });

  const generatedImages = [];
  for (let index = 1; index <= count; index += 1) {
    const filename = `generated_${String(index).padStart(3, "0")}.png`;
    const filePath = path.join(taskDir, filename);
    const image = await editOpenAiImage({
      imageBuffer: sourceImage.buffer,
      contentType: sourceImage.contentType,
      filename: sourceImage.filename,
      prompt: [String(finalPrompt || "").trim(), `Image ${index} of ${count}.`].filter(Boolean).join("\n"),
      ratio
    });
    await fs.writeFile(filePath, image);
    generatedImages.push({
      ...createImageRecord(safeTaskId, "generated", filename, filePath),
      sourceImage: sourceImage.source
    });
  }

  return generatedImages;
}

async function resolveSourceImage(payload = {}) {
  const source = String(payload.sourceImageUrl || payload.referenceImageUrl || payload.sourceImage || "").trim();
  if (!source) return null;
  if (source.startsWith("data:")) return parseDataImageUrl(source);
  if (/^https?:\/\//i.test(source) || source.startsWith("/")) return fetchSourceImage(source);

  const error = new Error("参考图仅支持 data URL、http(s) URL 或本站相对 URL");
  error.status = 400;
  throw error;
}

function parseDataImageUrl(value) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value);
  if (!match) {
    const error = new Error("参考图 data URL 格式不正确");
    error.status = 400;
    throw error;
  }
  const contentType = normalizeImageContentType(match[1]);
  return {
    buffer: Buffer.from(match[2], "base64"),
    contentType,
    filename: `reference.${extensionForContentType(contentType)}`,
    source: "uploaded-reference"
  };
}

async function fetchSourceImage(source) {
  const url = normalizeFetchableSourceUrl(source);
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`参考图读取失败，HTTP ${response.status}`);
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }
  const contentType = normalizeImageContentType(response.headers.get("content-type") || "image/png");
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType,
    filename: `reference.${extensionForContentType(contentType)}`,
    source
  };
}

function normalizeFetchableSourceUrl(source) {
  if (source.startsWith("/")) {
    return new URL(source, localAppOrigin()).toString();
  }
  const url = new URL(source);
  const appHosts = new Set([
    "localhost",
    "127.0.0.1",
    "erp.hjt888.xyz"
  ]);
  if (appHosts.has(url.hostname) && url.pathname.startsWith("/api/")) {
    return new URL(`${url.pathname}${url.search}`, localAppOrigin()).toString();
  }
  return url.toString();
}

function localAppOrigin() {
  return process.env.APP_ORIGIN || process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
}

function normalizeImageContentType(contentType) {
  const value = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(value)) {
    return value === "image/jpg" ? "image/jpeg" : value;
  }
  const error = new Error("参考图格式仅支持 PNG、JPG、WEBP");
  error.status = 400;
  throw error;
}

function extensionForContentType(contentType) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
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
    cropMode: payload.cropMode || "auto",
    sourceImageUrl: payload.sourceImageUrl || payload.referenceImageUrl || payload.sourceImage
  });

  return {
    taskId: imageResult.taskId,
    generationMode: imageResult.generationMode,
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

export async function generateCommerceCopy(payload = {}) {
  const context = normalizeCommerceCopyInput(payload);
  if (!context.productName && !context.categoryName && !context.targetModel) {
    const error = new Error("请先填写商品名称、类目或目标车型");
    error.status = 400;
    throw error;
  }

  const result = await chatWithAiProvider({
    temperature: 0.35,
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content: [
          "你是俄罗斯 Ozon 汽车用品运营文案专家。",
          "你只返回 JSON，不要 Markdown，不要解释。",
          "根据商品信息生成可用于素材包回写的中文标题、标签和描述。",
          "不要编造认证、官方授权、销量、质保、尺寸或不存在的配件。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputShape: {
            titles: ["4个中文标题方案，每个不超过30字"],
            tags: ["8-14个中文或英文搜索标签"],
            description: "120-220字中文商品描述"
          },
          rules: [
            "标题突出品牌、车型、材质、产品类型和核心功能",
            "标签覆盖品牌词、车型词、材质词、功能词和类目词",
            "描述保留商品真实结构，只做电商表达优化"
          ],
          input: context
        })
      }
    ]
  });

  return {
    provider: result.provider,
    model: result.model,
    ...normalizeCommerceCopyResult(result.content, context)
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

function normalizeCommerceCopyInput(payload = {}) {
  return {
    productName: cleanCommerceText(payload.productName),
    categoryName: cleanCommerceText(payload.categoryName),
    brand: cleanCommerceText(payload.brand),
    targetModel: cleanCommerceText(payload.targetModel || payload.vehicleModel),
    material: cleanCommerceText(payload.material),
    color: cleanCommerceText(payload.color),
    productType: cleanCommerceText(payload.productType),
    sellingPoints: cleanCommerceText(payload.sellingPoints),
    tags: Array.isArray(payload.tags) ? payload.tags.map(cleanCommerceText).filter(Boolean).slice(0, 20) : cleanCommerceText(payload.tags),
    optimizationTarget: cleanCommerceText(payload.optimizationTarget),
    strategies: Array.isArray(payload.strategies) ? payload.strategies.map(cleanCommerceText).filter(Boolean).slice(0, 12) : []
  };
}

function normalizeCommerceCopyResult(rawContent, context) {
  try {
    const parsed = JSON.parse(String(rawContent || "{}"));
    const titles = normalizeCopyList(parsed.titles || parsed.titleSuggestions || parsed.title, 4);
    const tags = normalizeCopyList(parsed.tags || parsed.keywords, 14);
    const description = cleanCommerceText(parsed.description || parsed.summary || "");
    if (titles.length || tags.length || description) {
      return {
        titles: titles.length ? titles : fallbackCommerceTitles(context),
        tags: tags.length ? tags : fallbackCommerceTags(context),
        description: description || fallbackCommerceDescription(context)
      };
    }
  } catch (error) {
    console.error("Commerce copy JSON parse failed", { error, rawContent });
  }
  return {
    titles: fallbackCommerceTitles(context),
    tags: fallbackCommerceTags(context),
    description: fallbackCommerceDescription(context)
  };
}

function normalizeCopyList(value, limit) {
  if (Array.isArray(value)) return value.map(cleanCommerceText).filter(Boolean).slice(0, limit);
  const text = cleanCommerceText(value);
  if (!text) return [];
  return text.split(/[\n,，、]+/).map(cleanCommerceText).filter(Boolean).slice(0, limit);
}

function fallbackCommerceTitles(context) {
  const target = context.targetModel || context.brand || "通用车型";
  const base = `${target} ${context.material || ""}${context.productType || context.productName || "汽车配件"}`.replace(/\s+/g, " ").trim();
  return [
    `${base} 高端防刮保护配件`,
    `${base} 专车适配易安装套装`,
    `${context.brand || target} ${context.productType || "汽车配件"} 耐磨升级款`,
    `${target} ${context.productType || context.productName || "汽车配件"} Ozon热卖款`
  ];
}

function fallbackCommerceTags(context) {
  return Array.from(new Set([
    context.brand,
    context.targetModel,
    context.material,
    context.color,
    context.productType,
    context.categoryName,
    "汽车配件",
    "防刮耐磨",
    "易安装",
    "Ozon"
  ].filter(Boolean))).slice(0, 12);
}

function fallbackCommerceDescription(context) {
  const target = context.targetModel || context.brand || "通用车型";
  const base = `${target} ${context.material || ""}${context.productType || context.productName || "汽车配件"}`.replace(/\s+/g, " ").trim();
  return `${base}，适合日常汽车用品场景。突出${context.sellingPoints || "耐磨、防刮、安装便捷"}，可用于主图、详情图和上架描述优化。`;
}

function cleanCommerceText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1200);
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

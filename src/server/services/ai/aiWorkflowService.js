import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync, { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { config } from "../../../config.js";
import { mysqlQuery } from "../../../mysql-pool.js";
import { buildZip, runPythonCropper } from "../tools/imageCropperService.js";
import { aiProviderConfig, chatWithAiProvider } from "../../../services/ai-provider-settings.js";
import { buildFallbackPrompt, clampImageCount, optimizeImagePrompt } from "../openai/promptService.js";
import { buildCopyBundlePrompt, buildCopyFactsContract } from "./copyFactsContract.js";
import { parseCopyBundleResponse, validateCopyBundle } from "./copyQualityValidator.js";
import { putContentAddressedFile } from "../../../services/object-storage.js";
import {
  GENERATED_ROOT,
  ROOT_DIR,
  createImageRecord,
  downloadGeneratedImageToFile,
  editOpenAiImage,
  generateOpenAiImages,
  resolveGeneratedImagePath,
  resolveGeneratedTaskDir,
  validateTaskId
} from "../openai/imageGenerationService.js";

const CROPPED_ROOT = path.resolve(ROOT_DIR, process.env.AI_CROP_OUTPUT_DIR || "uploads/ai-cropped");
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS = 20000;
const AI_SOURCE_IMAGE_CACHE_TTL_MS = Math.max(30000, Number(process.env.AI_SOURCE_IMAGE_CACHE_TTL_MS || 900000));
const AI_SOURCE_IMAGE_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.AI_SOURCE_IMAGE_CACHE_MAX_ENTRIES || 32));
const AI_SOURCE_IMAGE_CACHE_ROOT = path.resolve(ROOT_DIR, process.env.AI_SOURCE_IMAGE_CACHE_DIR || "uploads/temp/ai-source-cache");
const sourceImageCache = new Map();

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
  const imageRuntimeConfig = payload.imageRuntimeConfig || payload.runtimeConfig || null;
  const finalPrompt = String(payload.finalPrompt || payload.prompt || buildImagePromptFallback(payload)).trim();
  if (!finalPrompt) {
    const error = new Error("finalPrompt 不能为空");
    error.status = 400;
    throw error;
  }

  try {
    const resumeProviderJob = firstProviderJob(payload.providerJob);
    const sourceImage = resumeProviderJob?.jobId && hasSourceImageInput(payload)
      ? providerJobResumeSourceImage()
      : await resolveSourceImagesWithFallback(payload);
    const generatedImages = sourceImage
      ? await generateImageEdits({ taskId, finalPrompt, ratio, imageCount, sourceImage, runtimeConfig: imageRuntimeConfig, providerJob: payload.providerJob, onProviderJob: payload.onProviderJob })
      : await generateOpenAiImages({ taskId, finalPrompt, ratio, imageCount, runtimeConfig: imageRuntimeConfig, providerJob: payload.providerJob, onProviderJob: payload.onProviderJob });
    const crop = payload.autoCrop === false
      ? { croppedImages: [], cropStatus: "skipped" }
      : await cropGeneratedImages({ taskId, generatedImages, cropMode: payload.cropMode || "auto" });
    const storedGeneratedImages = await storeUnusedAiImages(generatedImages);
    const storedCroppedImages = await storeUnusedAiImages(crop.croppedImages);
    return {
      taskId,
      generationMode: sourceImage ? "image_to_image" : "text_to_image",
      generatedImages: storedGeneratedImages,
      croppedImages: storedCroppedImages,
      cropStatus: crop.cropStatus,
      cropMessage: crop.cropMessage,
      zipUrl: zipUrl(taskId),
      provider: imageRuntimeConfig?.provider || "",
      model: imageRuntimeConfig?.imageModel || "",
      channelId: imageRuntimeConfig?.channelId || "",
      channelName: imageRuntimeConfig?.channelName || imageRuntimeConfig?.name || ""
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
    publicError.code = error.code || "";
    throw publicError;
  }
}

async function storeUnusedAiImages(images = []) {
  return Promise.all((Array.isArray(images) ? images : []).map(async (item) => {
    const relativePath = String(item?.path || "").trim();
    if (!relativePath) return item;
    const filePath = path.resolve(ROOT_DIR, relativePath);
    const extension = path.extname(filePath).toLowerCase() || ".png";
    const contentType = extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".webp"
        ? "image/webp"
        : "image/png";
    const stored = await putContentAddressedFile(filePath, {
      prefix: "ai-unused",
      extension,
      contentType
    });
    return stored ? { ...item, url: stored.url, oss_object_key: stored.objectKey } : item;
  }));
}

async function resolveSourceImageWithFallback(payload = {}) {
  try {
    return await resolveSourceImage(payload);
  } catch (error) {
    const fallbackSource = String(payload.fallbackSourceImageUrl || payload.fallbackReferenceImageUrl || "").trim();
    if (!fallbackSource || !String(error?.message || "").includes("参考图")) throw error;
    console.warn("Primary AI reference image is unavailable; using fallback reference image", error.message);
    return resolveSourceImage({ sourceImageUrl: fallbackSource });
  }
}

async function resolveSourceImagesWithFallback(payload = {}) {
  const urls = Array.from(new Set([
    ...(Array.isArray(payload.sourceImageUrls) ? payload.sourceImageUrls : []),
    payload.sourceImageUrl
  ].map((item) => String(item || "").trim()).filter(Boolean))).slice(0, 8);
  if (urls.length <= 1) return resolveSourceImageWithFallback({ ...payload, sourceImageUrl: urls[0] || "" });
  const resolved = [];
  for (const sourceImageUrl of urls) {
    try {
      const image = await resolveSourceImage({ sourceImageUrl });
      if (image) resolved.push(image);
    } catch (error) {
      console.warn("Skipping unavailable AI source image", sourceImageUrl, error?.message || error);
    }
  }
  if (!resolved.length) return resolveSourceImageWithFallback(payload);
  if (resolved.length === 1) return resolved[0];
  return buildServerReferenceBoard(resolved, Number(payload.productImageCount || 0));
}

async function buildServerReferenceBoard(images = [], productImageCount = 0) {
  const canvasWidth = 1536;
  const canvasHeight = 1024;
  const safeProductCount = Math.max(1, Math.min(images.length, productImageCount || 1));
  const productImages = images.slice(0, safeProductCount);
  const styleImages = images.slice(safeProductCount);
  const columns = [];
  const productWidth = styleImages.length ? 960 : canvasWidth;
  const productTileWidth = Math.floor(productWidth / productImages.length);
  productImages.forEach((image, index) => columns.push({ image, left: index * productTileWidth, width: productTileWidth }));
  if (styleImages.length) {
    const styleWidth = canvasWidth - productWidth;
    const styleTileHeight = Math.floor(canvasHeight / styleImages.length);
    styleImages.forEach((image, index) => columns.push({ image, left: productWidth, top: index * styleTileHeight, width: styleWidth, height: styleTileHeight }));
  }
  const composites = await Promise.all(columns.map(async (item) => ({
    input: await sharp(item.image.filePath || item.image.buffer).rotate().resize(item.width, item.height || canvasHeight, {
      fit: "contain",
      background: { r: 245, g: 246, b: 248, alpha: 1 }
    }).png().toBuffer(),
    left: item.left,
    top: item.top || 0
  })));
  const buffer = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 245, g: 246, b: 248, alpha: 1 } } })
    .composite(composites)
    .png()
    .toBuffer();
  return { buffer, contentType: "image/png", filename: "multi-reference-board.png", source: `server-board:${images.length}` };
}

function buildImagePromptFallback(payload = {}) {
  const row = payload.row || payload.product || payload.source || {};
  const facts = [
    payload.title,
    payload.productName,
    payload.product_name,
    payload.variantTarget,
    payload.variant_target,
    payload.categoryName,
    payload.category_name,
    payload.description,
    payload.summary,
    payload.material,
    payload.color,
    row?.title,
    row?.name,
    row?.productName,
    row?.product_name,
    row?.variantTarget,
    row?.variant_target,
    row?.description,
    row?.material,
    row?.color
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const sourceFacts = Array.from(new Set(facts)).join(", ");
  if (!sourceFacts) return "";
  return [
    "Create a clean ecommerce product image for the exact source product.",
    "Keep the original product identity, material, color, shape, quantity, and compatibility facts.",
    "Do not add unrelated vehicle models, brand logos, platform logos, watermarks, certifications, or extra accessories.",
    `Source product facts: ${sourceFacts}`
  ].join("\n");
}

async function generateImageEdits({ taskId, finalPrompt, ratio, imageCount, sourceImage, runtimeConfig = null, providerJob = null, onProviderJob = null }) {
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
      imageFilePath: sourceImage.filePath,
      contentType: sourceImage.contentType,
      filename: sourceImage.filename,
      prompt: [String(finalPrompt || "").trim(), `Image ${index} of ${count}.`].filter(Boolean).join("\n"),
      ratio,
      runtimeConfig,
      providerJob: providerJob?.jobs?.[index - 1] || (index === 1 ? providerJob : null),
      onProviderJob: onProviderJob ? (job) => onProviderJob(job, index - 1) : null
    });
    if (image?.remoteUrl) await downloadGeneratedImageToFile(image.remoteUrl, filePath);
    else await fs.writeFile(filePath, image);
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
  if (/^https?:\/\//i.test(source) || source.startsWith("/")) return cachedSourceImage(source);

  const error = new Error("参考图仅支持 data URL、http(s) URL 或本站相对 URL");
  error.status = 400;
  throw error;
}

async function cachedSourceImage(source) {
  const now = Date.now();
  for (const [key, entry] of sourceImageCache) {
    if (entry.expiresAt > now) continue;
    sourceImageCache.delete(key);
  }
  const cached = sourceImageCache.get(source);
  if (cached) return cached.promise;
  const promise = fetchSourceImage(source).catch((error) => {
    sourceImageCache.delete(source);
    throw error;
  });
  sourceImageCache.set(source, { promise, expiresAt: now + AI_SOURCE_IMAGE_CACHE_TTL_MS });
  while (sourceImageCache.size > AI_SOURCE_IMAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = sourceImageCache.keys().next().value;
    if (!oldestKey || oldestKey === source) break;
    sourceImageCache.delete(oldestKey);
  }
  return promise;
}

function firstProviderJob(providerJob = null) {
  return Array.isArray(providerJob?.jobs) ? providerJob.jobs.find((job) => job?.jobId) : providerJob;
}

function hasSourceImageInput(payload = {}) {
  return Boolean(
    String(payload.sourceImageUrl || payload.referenceImageUrl || payload.sourceImage || "").trim()
    || (Array.isArray(payload.sourceImageUrls) && payload.sourceImageUrls.some((item) => String(item || "").trim()))
  );
}

function providerJobResumeSourceImage() {
  return {
    buffer: Buffer.alloc(0),
    contentType: "image/png",
    filename: "provider-job-resume.png",
    source: "provider-job-resume"
  };
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
  const localTaskImage = await readLocalAiTaskSourceImage(source);
  if (localTaskImage) return localTaskImage;
  const url = normalizeFetchableSourceUrl(source);
  const response = await fetchSourceImageResponse(url);
  if (!response.ok) {
    const error = new Error(`参考图读取失败，HTTP ${response.status}`);
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }
  const contentType = normalizeImageContentType(response.headers.get("content-type") || "image/png");
  if (!response.body) throw Object.assign(new Error("参考图响应没有可读取的内容"), { status: 502 });
  await fs.mkdir(AI_SOURCE_IMAGE_CACHE_ROOT, { recursive: true });
  const cacheKey = crypto.createHash("sha256").update(String(source)).digest("hex");
  const filePath = path.join(AI_SOURCE_IMAGE_CACHE_ROOT, `${cacheKey}.${extensionForContentType(contentType)}`);
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(temporaryPath));
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    filePath,
    contentType,
    filename: `reference.${extensionForContentType(contentType)}`,
    source,
    cachedRemote: true
  };
}

async function readLocalAiTaskSourceImage(source = "") {
  const value = String(source || "").trim();
  if (!value) return null;
  let pathname = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      pathname = new URL(value).pathname;
    } catch {
      return null;
    }
  } else {
    pathname = value.split(/[?#]/, 1)[0];
  }
  const localPublicImage = resolveLocalPublicSourceImage(value, pathname);
  if (localPublicImage) return localPublicImage;
  const match = /^\/api\/ai\/(?:file|preview-file)\/([^/]+)\/([^/]+)\/(.+)$/i.exec(pathname);
  const legacyMatch = match ? null : /^\/api\/ai\/(?:file|preview-file)\/([^/]+)\/(.+)$/i.exec(pathname);
  if (!match && !legacyMatch) return null;
  const taskId = decodeURIComponent((match || legacyMatch)[1]);
  const scope = match ? decodeURIComponent(match[2]) : "generated";
  const filename = (match ? match[3] : legacyMatch[2]).split("/").map(decodeURIComponent).join("/");
  const file = await getAiTaskFile(taskId, scope, filename).catch(() => null);
  if (!file) return null;
  return {
    filePath: file.filePath,
    contentType: normalizeImageContentType(file.contentType || "image/png"),
    filename: path.basename(file.filePath),
    source: value
  };
}

function resolveLocalPublicSourceImage(value = "", pathname = "") {
  try {
    const hostname = /^https?:\/\//i.test(value) ? new URL(value).hostname.toLowerCase() : "localhost";
    if (!new Set(["erp.hjt888.xyz", "localhost", "127.0.0.1"]).has(hostname)) return null;
    const relative = decodeURIComponent(String(pathname || "")).replace(/^\/+/, "");
    if (!relative.startsWith("uploads/listing-media/")) return null;
    const publicRoot = path.resolve("public");
    const filePath = path.resolve(publicRoot, relative);
    if (!filePath.startsWith(`${publicRoot}${path.sep}`) || !fsSync.existsSync(filePath)) return null;
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
    return { filePath, contentType, filename: path.basename(filePath), source: value };
  } catch {
    return null;
  }
}

async function fetchSourceImageResponse(url) {
  const response = await fetch(url, {
    headers: sourceImageFetchHeaders(url),
    signal: AbortSignal.timeout(AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS)
  });
  if (response.ok || ![401, 403, 404].includes(response.status)) return response;
  return fetch(url, {
    headers: sourceImageFetchHeaders(url, { retry: true }),
    signal: AbortSignal.timeout(AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS)
  });
}

function sourceImageFetchHeaders(url, { retry = false } = {}) {
  const headers = {
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
  };
  if (!retry) return headers;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    headers.Referer = host.includes("ozon") ? "https://www.ozon.ru/" : `${parsed.origin}/`;
    headers.Origin = host.includes("ozon") ? "https://www.ozon.ru" : parsed.origin;
  } catch {}
  return headers;
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
  return process.env.APP_ORIGIN
    || process.env.PUBLIC_BASE_URL
    || process.env.APP_BASE_URL
    || config.appBaseUrl
    || `http://127.0.0.1:${process.env.PORT || 8788}`;
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
    maxTokens: 1800,
    timeoutMs: Math.max(60_000, Math.min(300_000, Number(payload.aiTimeoutMs || payload.ai_timeout_ms || 60_000))),
    messages: [
      {
        role: "system",
        content: [
          "你是俄罗斯 Ozon 汽车用品运营文案专家。",
          "你只返回 JSON，不要 Markdown，不要解释。",
          "根据商品信息生成可直接回写的俄语标题、标签和描述，并同时提供准确中文审核翻译。",
          "俄语字段 titles、tags、description 不允许包含任何中文字符；中文翻译字段允许并必须使用简体中文。",
          "必须保留导入来源里的商品主体，不允许把明确商品退化成泛类目。",
          "不要编造认证、官方授权、销量、质保、尺寸或不存在的配件。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          outputShape: {
            titles: ["2个俄语标题方案：第1个高点击标题，第2个高搜索标题"],
            tags: ["15-20个俄语标签，全部带 #，每个少于30字符"],
            description: "150-250个俄语词的自然商品描述",
            titleZh: "当前首选俄语标题的准确简体中文翻译",
            tagsZh: ["与俄语标签顺序对应的简体中文释义"],
            descriptionZh: "俄语描述的完整简体中文翻译",
            imageHeadline: "适合主图使用的简短俄语标题，最多8个词",
            imageSellingPoints: ["2-4条适合图片排版的简短俄语卖点，每条最多7个词"],
            imageHeadlineZh: "图片俄语标题的简体中文翻译",
            imageSellingPointsZh: ["图片俄语卖点对应的简体中文翻译"],
            detailImageTexts: [{ role: "详情图角色", title: "简短俄语标题", titleZh: "中文翻译", points: ["俄语卖点"], pointsZh: ["中文翻译"] }]
          },
          rules: [
            "标题必须是俄语，并保留原始商品主体词，不得改成泛类目。",
            "第1个标题偏点击转化，第2个标题偏搜索覆盖。",
            "标签必须全部是俄语标签，至少15个，全部带 #，单个标签少于30字符，避免重复。",
            "描述必须是150-250个俄语词，自然、连贯、适合Ozon，不得关键词堆砌。",
            "中文只能出现在 titleZh、tagsZh、descriptionZh，俄语上架字段禁止中文。",
            "imageHeadline 和 imageSellingPoints 必须短、准确、适合移动端图片排版，不得照抄长标题或编造卖点。",
            "信息不足时保守生成，不得臆造车型、材质、数量、认证或配件。"
          ],
          titleModes: context.titleModes,
          sourceContext: context.sourceContext,
          additionalRules: context.rules,
          input: context
        })
      }
    ]
  });

  const normalized = normalizeCommerceCopyResult(result.content, context);
  const completed = await completeCommerceCopyTranslations(normalized);
  return {
    provider: result.provider,
    model: result.model,
    ...completed
  };
}

async function completeCommerceCopyTranslations(copy = {}) {
  const tags = Array.isArray(copy.tags) ? copy.tags : [];
  const tagsZh = Array.isArray(copy.tagsZh) ? copy.tagsZh : [];
  const hasTitleZh = /[\u3400-\u9fff]/u.test(copy.titleZh || "");
  const hasDescriptionZh = /[\u3400-\u9fff]/u.test(copy.descriptionZh || "");
  const hasTagsZh = tags.length > 0 && tagsZh.length >= tags.length && tagsZh.every((item) => /[\u3400-\u9fff]/u.test(item || ""));
  if (hasTitleZh && hasDescriptionZh && hasTagsZh) return copy;

  try {
    const translated = await chatWithAiProvider({
      temperature: 0.1,
      maxTokens: 1600,
      timeoutMs: 120_000,
      messages: [
        {
          role: "system",
          content: "你是俄语电商文案翻译员。只返回有效 JSON，必须把俄语完整翻译为自然、准确的简体中文，不得省略、概括或保留俄语作为中文结果。"
        },
        {
          role: "user",
          content: JSON.stringify({
            outputShape: { titleZh: "中文标题", tagsZh: ["与标签逐一对应的中文释义"], descriptionZh: "完整中文描述" },
            russian: { title: copy.titles?.[0] || "", tags, description: copy.description || "" }
          })
        }
      ]
    });
    const raw = String(translated.content || "").trim();
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonText);
    const translatedTags = normalizeCopyList(parsed.tagsZh || parsed.tags_zh, 25);
    return {
      ...copy,
      titleZh: cleanCommerceText(parsed.titleZh || parsed.title_zh) || copy.titleZh,
      tagsZh: translatedTags.length ? translatedTags : copy.tagsZh,
      descriptionZh: cleanCommerceText(parsed.descriptionZh || parsed.description_zh) || copy.descriptionZh
    };
  } catch (error) {
    console.error("Commerce copy translation completion failed", error);
    return copy;
  }
}

export async function testCopyGeneration(payload = {}) {
  const draftId = Number(payload.draftId || payload.draft_id || 0);
  if (!draftId && !payload.draft) {
    const error = new Error("请提供草稿 ID 或草稿对象");
    error.status = 400;
    throw error;
  }

  const draft = payload.draft || await loadListingDraftForCopyTest(draftId);
  if (!draft) {
    const error = new Error(`未找到上架草稿 ${draftId}`);
    error.status = 404;
    throw error;
  }

  const contract = buildCopyFactsContract({
    draft,
    targetModel: payload.targetModel || payload.target_model || payload.variantTarget || payload.variant_target,
    material: payload.material,
    color: payload.color,
    quantity: payload.quantity
  });
  const existingBundle = {
    title: contract.source.title,
    tags: contract.source.sourceTags,
    description: contract.source.originalDescription
  };
  const existingQuality = validateCopyBundle(existingBundle, contract);
  const strategy = cleanCommerceText(payload.strategy || "precision_fit");
  const prompt = buildCopyBundlePrompt(contract, { strategy });
  const runAi = payload.runAi !== false && payload.run_ai !== false && payload.noAi !== true && payload.no_ai !== true;
  const response = {
    ok: true,
    draftId: draft.id || draftId,
    strategy,
    factsContract: contract,
    existing: {
      bundle: existingBundle,
      quality: existingQuality
    },
    prompt,
    ai: null
  };

  if (!runAi) return response;

  const startedAt = Date.now();
  const result = await chatWithAiProvider({
    temperature: 0.2,
    maxTokens: 1800,
    messages: [
      {
        role: "system",
        content: "You are an Ozon Russia automotive listing copy specialist. Return valid JSON only."
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });
  const raw = String(result.content || "");
  const bundle = parseCopyBundleResponse(raw);
  const quality = validateCopyBundle(bundle, contract);
  response.ai = {
    provider: result.provider,
    model: result.model,
    elapsedMs: Date.now() - startedAt,
    raw,
    bundle,
    quality
  };
  return response;
}

async function loadListingDraftForCopyTest(draftId = 0) {
  const id = Number(draftId || 0);
  if (!id) return null;
  const rows = await mysqlQuery("SELECT * FROM listing_drafts WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
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
  const sourceContext = payload.sourceContext && typeof payload.sourceContext === "object" ? payload.sourceContext : null;
  const operatorFacts = sourceContext?.operatorFacts && typeof sourceContext.operatorFacts === "object"
    ? sourceContext.operatorFacts
    : {};
  const compatibility = Array.isArray(operatorFacts.compatibility_zh) ? operatorFacts.compatibility_zh.filter(Boolean) : [];
  const factText = [operatorFacts.product_title_zh, operatorFacts.description_zh, ...(operatorFacts.selling_points_zh || [])]
    .filter(Boolean)
    .join(" ");
  return {
    productName: cleanCommerceText(payload.productName || operatorFacts.product_title_zh),
    categoryName: cleanCommerceText(payload.categoryName),
    brand: cleanCommerceText(payload.brand),
    targetModel: cleanCommerceText(payload.targetModel || payload.vehicleModel || compatibility[0]),
    material: cleanCommerceText(payload.material || (/ABS/i.test(factText) && /硅胶/.test(factText) ? "ABS и силикон" : "")),
    color: cleanCommerceText(payload.color),
    productType: cleanCommerceText(payload.productType),
    title: cleanCommerceText(payload.title),
    summary: cleanCommerceText(payload.summary),
    richContent: cleanCommerceText(payload.richContent),
    sellingPoints: cleanCommerceText(payload.sellingPoints),
    tags: Array.isArray(payload.tags) ? payload.tags.map(cleanCommerceText).filter(Boolean).slice(0, 20) : cleanCommerceText(payload.tags),
    optimizationTarget: cleanCommerceText(payload.optimizationTarget),
    strategies: Array.isArray(payload.strategies) ? payload.strategies.map(cleanCommerceText).filter(Boolean).slice(0, 12) : [],
    titleModes: Array.isArray(payload.titleModes) ? payload.titleModes.map(cleanCommerceText).filter(Boolean).slice(0, 4) : [],
    rules: Array.isArray(payload.rules) ? payload.rules.map(cleanCommerceText).filter(Boolean).slice(0, 20) : [],
    exactProductIdentity: cleanCommerceText(payload.exactProductIdentity || JSON.stringify(operatorFacts)),
    sourceContext
  };
}

function normalizeCommerceCopyResult(rawContent, context) {
  try {
    const parsed = JSON.parse(String(rawContent || "{}"));
    const titles = normalizeRussianTitleList(parsed.titles || parsed.titleSuggestions || parsed.title, context);
    const tags = normalizeRussianTagList(parsed.tags || parsed.keywords, context);
    const description = normalizeRussianDescriptionText(parsed.description || parsed.summary || "", context);
    const titleZh = cleanCommerceText(parsed.titleZh || parsed.title_zh || parsed.translations?.title || context.productName || context.title);
    const tagsZh = normalizeCopyList(parsed.tagsZh || parsed.tags_zh || parsed.translations?.tags, 25);
    const descriptionZh = cleanCommerceText(parsed.descriptionZh || parsed.description_zh || parsed.translations?.description || context.summary);
    const imageHeadline = cleanCommerceText(parsed.imageHeadline || parsed.image_headline || titles[0] || "");
    const imageSellingPoints = normalizeCopyList(parsed.imageSellingPoints || parsed.image_selling_points, 4);
    const imageHeadlineZh = cleanCommerceText(parsed.imageHeadlineZh || parsed.image_headline_zh || titleZh);
    const imageSellingPointsZh = normalizeCopyList(parsed.imageSellingPointsZh || parsed.image_selling_points_zh, 4);
    const detailImageTexts = normalizeDetailImageTexts(parsed.detailImageTexts || parsed.detail_image_texts);
    if (titles.length || tags.length || description) {
      return {
        titles: titles.length ? titles : fallbackCommerceTitles(context),
        tags: tags.length ? tags : fallbackCommerceTags(context),
        description: description || fallbackCommerceDescription(context),
        titleZh,
        tagsZh,
        descriptionZh,
        imageHeadline,
        imageSellingPoints,
        imageHeadlineZh,
        imageSellingPointsZh,
        detailImageTexts
      };
    }
  } catch (error) {
    console.error("Commerce copy JSON parse failed", { error, rawContent });
  }
  return {
    titles: fallbackCommerceTitles(context),
    tags: fallbackCommerceTags(context),
    description: fallbackCommerceDescription(context),
    titleZh: context.productName || context.title || "",
    tagsZh: [],
    descriptionZh: context.summary || "",
    imageHeadline: fallbackCommerceTitles(context)[0] || "",
    imageSellingPoints: [],
    imageHeadlineZh: context.productName || context.title || "",
    imageSellingPointsZh: [],
    detailImageTexts: []
  };
}

function normalizeDetailImageTexts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item = {}) => ({
    role: cleanCommerceText(item.role),
    title: cleanCommerceText(item.title),
    titleZh: cleanCommerceText(item.titleZh || item.title_zh),
    points: normalizeCopyList(item.points, 4),
    pointsZh: normalizeCopyList(item.pointsZh || item.points_zh, 4)
  })).filter((item) => item.title || item.points.length);
}

function normalizeCopyList(value, limit) {
  if (Array.isArray(value)) return value.map(cleanCommerceText).filter(Boolean).slice(0, limit);
  const text = cleanCommerceText(value);
  if (!text) return [];
  return text.split(/[\n,，、]+/).map(cleanCommerceText).filter(Boolean).slice(0, limit);
}

function containsChineseText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function hasRussianText(value) {
  return /[А-Яа-яЁё]/.test(String(value || ""));
}

function normalizeRussianTitleList(value, context) {
  const list = normalizeCopyList(value, 6)
    .filter((item) => !containsChineseText(item))
    .filter((item) => hasRussianText(item))
    .filter((item) => titleMatchesCommerceFocus(item, context));
  const fallback = fallbackCommerceTitles(context);
  return uniqueCommerceValues([...list, ...fallback])
    .filter((item) => !containsChineseText(item))
    .filter((item) => hasRussianText(item))
    .slice(0, 2);
}

function normalizeRussianTagList(value, context) {
  const list = Array.isArray(value) ? value : normalizeCopyList(value, 40);
  const normalized = list
    .flatMap((item) => String(item || "").split(/[\n,，、]+/))
    .map((item) => formatRussianCommerceTag(item))
    .filter(Boolean);
  return uniqueCommerceValues([...normalized, ...fallbackCommerceTags(context)]).slice(0, 20);
}

function normalizeRussianDescriptionText(value, context) {
  const text = cleanCommerceText(value);
  if (!text || containsChineseText(text) || !hasRussianText(text)) return fallbackCommerceDescription(context);
  const words = countCommerceWords(text);
  return words >= 150 && words <= 250 ? text : fallbackCommerceDescription(context);
}

function countCommerceWords(value) {
  return (String(value || "").match(/[A-Za-zА-Яа-яЁё0-9-]+/g) || []).length;
}

function normalizeBrandForRussianText(value) {
  const text = cleanCommerceText(value);
  if (!text || /^(no brand|без бренда|нет бренда|无品牌)$/i.test(text)) return "";
  return containsChineseText(text) ? "" : text;
}

function normalizeRussianOnlyText(value, fallback = "") {
  const text = cleanCommerceText(value);
  if (!text || containsChineseText(text) || !hasRussianText(text)) return fallback;
  return text;
}

function uniqueCommerceValues(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const text = cleanCommerceText(item).toLowerCase();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function productTypeRuFallback(context = {}) {
  const text = `${context.title || ""} ${context.productType || ""} ${context.productName || ""}`.toLowerCase();
  if (text.includes("收纳盒") || text.includes("收纳") || text.includes("储物盒")) return "органайзер за центральным экраном";
  if (text.includes("门槛")) return "накладки на порог";
  if (text.includes("钥匙")) return "чехол для ключа";
  if (text.includes("脚垫") || text.includes("垫")) return "коврики";
  if (text.includes("保护壳")) return "защитный чехол";
  return "автоаксессуар";
}

function titleMatchesCommerceFocus(value, context = {}) {
  const text = String(value || "").toLowerCase();
  const signals = primaryCommerceSignals(context);
  return !signals.length || signals.some((item) => text.includes(item));
}

function primaryCommerceSignals(context = {}) {
  const text = `${context.title || ""} ${context.productName || ""} ${context.productType || ""}`.toLowerCase();
  if (text.includes("收纳盒") || text.includes("收纳") || text.includes("储物盒")) return ["органайзер", "хранен"];
  if (text.includes("门槛")) return ["порог", "наклад"];
  if (text.includes("钥匙")) return ["ключ", "чех"];
  if (text.includes("脚垫") || text.includes("垫")) return ["ковр"];
  const fallback = productTypeRuFallback(context);
  return fallback.split(/\s+/).map((item) => item.toLowerCase()).filter((item) => item.length > 4).slice(0, 2);
}

function formatRussianCommerceTag(value) {
  const text = cleanCommerceText(value)
    .replace(/^#+/, "")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .trim();
  if (!text) return "";
  const tag = `#${text}`;
  if (tag.length >= 30) return "";
  if (containsChineseText(tag) || !hasRussianText(tag)) return "";
  return tag;
}

function fallbackCommerceTitles(context) {
  const target = context.targetModel || context.brand || "автомобиля";
  const baseType = productTypeRuFallback(context);
  const material = cleanCommerceText(context.material);
  const brand = normalizeBrandForRussianText(context.brand);
  return [
    `${baseType} для ${brand || target}, ${material || "прочный материал"}, защита и стиль салона`,
    `${baseType} ${brand || ""} ${target}, аксессуар для защиты и аккуратного внешнего вида`
  ].map((item) => item.replace(/\s+/g, " ").trim());
}

function fallbackCommerceTags(context) {
  const focus = `${context.title || ""} ${context.productName || ""} ${context.productType || ""}`.toLowerCase();
  if (focus.includes("收纳盒") || focus.includes("收纳") || focus.includes("储物盒")) {
    return uniqueCommerceValues([
      "органайзер_для_авто", "органайзер_за_экраном", "Geely_EX5", "Geely_EM-i",
      "хранение_в_авто", "лоток_для_авто", "полка_для_авто", "аксессуары_Geely",
      "органайзер_в_салон", "место_для_телефона", "место_для_ключей", "ABS_пластик",
      "силиконовая_вставка", "порядок_в_салоне", "автоаксессуары"
    ].map(formatRussianCommerceTag).filter(Boolean)).slice(0, 20);
  }
  const base = [
    normalizeBrandForRussianText(context.brand),
    context.targetModel,
    productTypeRuFallback(context),
    context.material,
    normalizeRussianOnlyText(context.color),
    "автоаксессуары",
    "накладки_на_порог",
    "защита_порога",
    "защита_автомобиля",
    "аксессуары_для_авто",
    "легкая_установка",
    "прочный_материал",
    "защита_от_царапин",
    "внутренний_тюнинг",
    "декор_салона",
    "стильный_аксессуар",
    "защитная_накладка",
    "тюнинг_авто",
    "комплект_для_авто",
    "ozon"
  ];
  return uniqueCommerceValues(base.map(formatRussianCommerceTag).filter(Boolean)).slice(0, 20);
}

function fallbackCommerceDescription(context) {
  const target = cleanCommerceText(context.targetModel || normalizeBrandForRussianText(context.brand) || "автомобиля");
  const type = productTypeRuFallback(context);
  const material = cleanCommerceText(context.material || "прочный материал");
  const color = normalizeRussianOnlyText(context.color);
  const selling = normalizeRussianOnlyText(context.sellingPoints, "Аккуратный внешний вид, защита от царапин и простая установка без сложного инструмента.");
  const text = [
    `${type} для ${target} подходит для ежедневного использования и помогает сохранить аккуратный вид автомобиля. Аксессуар закрывает зону, которая чаще всего сталкивается с обувью, пылью, песком и регулярной эксплуатационной нагрузкой.`,
    `Материал ${material}${color ? `, цвет ${color},` : ","} выглядит аккуратно и хорошо сочетается с интерьером автомобиля. Поверхность помогает снизить риск появления царапин, потертостей и следов постоянного использования, сохраняя более ухоженный вид салона.`,
    `Изделие подходит для тех, кто хочет совместить защитную функцию с более аккуратной подачей автомобиля. Его удобно использовать в повседневной эксплуатации, а внешний вид остается спокойным и понятным для покупателя без перегруженных декоративных элементов.`,
    `Такой аксессуар можно выбрать как для обновления внешнего вида, так и для дополнительной защиты зоны порога от износа. ${selling} Описание ориентировано на покупателя Ozon и объясняет практическую пользу товара естественным русским языком без неестественного набора ключевых слов.`
  ].join(" ");
  return countCommerceWords(text) >= 150
    ? text
    : `${text} Такой формат помогает покупателю быстрее понять назначение товара, его преимущества, сценарий использования и ожидаемый эффект в повседневной эксплуатации.`;
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

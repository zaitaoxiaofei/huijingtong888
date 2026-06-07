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
          "根据商品信息生成可直接回写的俄语标题、标签和描述。",
          "标题、标签、描述、富内容文本都不允许包含任何中文字符。",
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
            description: "150-250个俄语词的自然商品描述"
          },
          rules: [
            "标题必须是俄语，并保留原始商品主体词，不得改成泛类目。",
            "第1个标题偏点击转化，第2个标题偏搜索覆盖。",
            "标签必须全部是俄语标签，至少15个，全部带 #，单个标签少于30字符，避免重复。",
            "描述必须是150-250个俄语词，自然、连贯、适合Ozon，不得关键词堆砌。",
            "返回结果中不允许出现任何中文字符。",
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
    title: cleanCommerceText(payload.title),
    summary: cleanCommerceText(payload.summary),
    richContent: cleanCommerceText(payload.richContent),
    sellingPoints: cleanCommerceText(payload.sellingPoints),
    tags: Array.isArray(payload.tags) ? payload.tags.map(cleanCommerceText).filter(Boolean).slice(0, 20) : cleanCommerceText(payload.tags),
    optimizationTarget: cleanCommerceText(payload.optimizationTarget),
    strategies: Array.isArray(payload.strategies) ? payload.strategies.map(cleanCommerceText).filter(Boolean).slice(0, 12) : [],
    titleModes: Array.isArray(payload.titleModes) ? payload.titleModes.map(cleanCommerceText).filter(Boolean).slice(0, 4) : [],
    rules: Array.isArray(payload.rules) ? payload.rules.map(cleanCommerceText).filter(Boolean).slice(0, 20) : [],
    sourceContext: payload.sourceContext && typeof payload.sourceContext === "object" ? payload.sourceContext : null
  };
}

function normalizeCommerceCopyResult(rawContent, context) {
  try {
    const parsed = JSON.parse(String(rawContent || "{}"));
    const titles = normalizeRussianTitleList(parsed.titles || parsed.titleSuggestions || parsed.title, context);
    const tags = normalizeRussianTagList(parsed.tags || parsed.keywords, context);
    const description = normalizeRussianDescriptionText(parsed.description || parsed.summary || "", context);
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

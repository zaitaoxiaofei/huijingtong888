import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import sharp from "sharp";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { fetchOzonDescriptionCategoryTree } from "../ozonClient.js";
import { chatWithAiProvider } from "./ai-provider-settings.js";
import { editOpenAiImage } from "../server/services/openai/imageGenerationService.js";
import {
  ensureListingAutomationSchema,
  listingCategoryTemplateDetail,
  publishListingTemplateToOzon,
  registerListingMediaAssetFromFile,
  validateListingTemplatePublish
} from "./listing-automation.js";

const ROOT_DIR = process.cwd();
const VARIANT_ROOT = path.resolve(ROOT_DIR, "uploads", "shop-variants");
const TAIL_TEMPLATE_ROOT = path.resolve(ROOT_DIR, "public", "uploads", "asset-tail-templates");
const LISTING_MEDIA_ROOT = path.resolve(ROOT_DIR, "public", "uploads", "listing-media");
const ASSET_SHOP_CONCURRENCY = envInt("ASSET_SHOP_CONCURRENCY", 2, 1, 4);
const ASSET_IMAGE_CONCURRENCY = envInt("ASSET_IMAGE_CONCURRENCY", 3, 1, 6);
const ASSET_VIDEO_CONCURRENCY = envInt("ASSET_VIDEO_CONCURRENCY", 1, 1, 2);
const OZON_SUBMIT_CONCURRENCY = envInt("OZON_SUBMIT_CONCURRENCY", 2, 1, 3);
const ASSET_FAST_VIDEO = String(process.env.ASSET_FAST_VIDEO || "1").trim() !== "0";
const SERVER_VIDEO_WIDTH = 900;
const SERVER_VIDEO_HEIGHT = 1200;
const SERVER_VIDEO_FPS = 24;
const SERVER_VIDEO_DURATION_SECONDS = 6;
const assetVideoLimiter = createConcurrencyLimiter(ASSET_VIDEO_CONCURRENCY);
const TITLE_STYLES = ["traffic", "material", "scenario", "value", "premium"];
const TAG_STYLES = ["traffic", "vehicle", "material", "compact", "scenario", "value", "premium"];
const TAG_STYLE_LABELS = {
  traffic: "搜索流量型",
  vehicle: "精准车型型",
  material: "材质卖点型",
  compact: "简洁防跟卖型",
  scenario: "场景适配型",
  value: "性价比型",
  premium: "高端质感型"
};
const TITLE_STYLE_LABELS = {
  traffic: "搜索流量型",
  material: "材质卖点型",
  scenario: "场景适配型",
  value: "性价比型",
  premium: "高端质感型"
};
const MAIN_IMAGE_PLANS = [
  { value: "original", label: "原图方案" },
  { value: "watermarked", label: "水印方案" },
  { value: "ai_similar", label: "AI 相似图方案" }
];
const DEFAULT_TAIL_CATEGORY = "Auto accessories";
const DEFAULT_TAIL_MODEL = "Generic model";
const AUTO_CATEGORY_KEYWORDS = [
  "auto", "car", "vehicle", "accessory", "key", "case", "cover",
  "interior", "lighting", "mat", "film", "protector"
];
const CATEGORY_ZH_HINTS = [
  ["Auto accessories", "Auto accessories"],
  ["Key case", "Key case"],
  ["Interior accessories", "Interior accessories"],
  ["Protective film", "Protective film"],
  ["Lighting", "Lighting"]
];
const REAL_RUSSIA_VEHICLE_MODELS = [
  vehicleSeed("Haval", "Haval", "Jolion", "Jolion", "Haval Jolion", "Haval Jolion", 2021, null, 1),
  vehicleSeed("Haval", "Haval", "F7", "F7", "Haval F7", "Haval F7", 2019, null, 2),
  vehicleSeed("Haval", "Haval", "M6", "M6", "Haval M6", "Haval M6", 2023, null, 3),
  vehicleSeed("Haval", "Haval", "Dargo", "Dargo", "Haval Dargo", "Haval Dargo", 2022, null, 4),
  vehicleSeed("Chery", "Chery", "Tiggo 4 Pro", "Tiggo 4 Pro", "Chery Tiggo 4 Pro", "Chery Tiggo 4 Pro", 2022, null, 5),
  vehicleSeed("Chery", "Chery", "Tiggo 7 Pro Max", "Tiggo 7 Pro Max", "Chery Tiggo 7 Pro Max", "Chery Tiggo 7 Pro Max", 2022, null, 6),
  vehicleSeed("Chery", "Chery", "Tiggo 8 Pro Max", "Tiggo 8 Pro Max", "Chery Tiggo 8 Pro Max", "Chery Tiggo 8 Pro Max", 2022, null, 7),
  vehicleSeed("Chery", "Chery", "Arrizo 8", "Arrizo 8", "Chery Arrizo 8", "Chery Arrizo 8", 2023, null, 8),
  vehicleSeed("Geely", "Geely", "Coolray", "Coolray", "Geely Coolray", "Geely Coolray", 2020, null, 9),
  vehicleSeed("Geely", "Geely", "Monjaro", "Monjaro", "Geely Monjaro", "Geely Monjaro", 2023, null, 10),
  vehicleSeed("Geely", "Geely", "Atlas Pro", "Atlas Pro", "Geely Atlas Pro", "Geely Atlas Pro", 2021, null, 11),
  vehicleSeed("Geely", "Geely", "Tugella", "Tugella", "Geely Tugella", "Geely Tugella", 2020, null, 12),
  vehicleSeed("Belgee", "Belgee", "X50", "X50", "Belgee X50", "Belgee X50", 2023, null, 13),
  vehicleSeed("Belgee", "Belgee", "X70", "X70", "Belgee X70", "Belgee X70", 2024, null, 14),
  vehicleSeed("Changan", "Changan", "CS35 Plus", "CS35 Plus", "Changan CS35 Plus", "Changan CS35 Plus", 2019, null, 15),
  vehicleSeed("Changan", "Changan", "CS55 Plus", "CS55 Plus", "Changan CS55 Plus", "Changan CS55 Plus", 2022, null, 16),
  vehicleSeed("Changan", "Changan", "CS75 Plus", "CS75 Plus", "Changan CS75 Plus", "Changan CS75 Plus", 2022, null, 17),
  vehicleSeed("Changan", "Changan", "UNI-K", "UNI-K", "Changan UNI-K", "Changan UNI-K", 2022, null, 18),
  vehicleSeed("Omoda", "Omoda", "C5", "C5", "Omoda C5", "Omoda C5", 2022, null, 19),
  vehicleSeed("Jaecoo", "Jaecoo", "J7", "J7", "Jaecoo J7", "Jaecoo J7", 2023, null, 20),
  vehicleSeed("Jaecoo", "Jaecoo", "J8", "J8", "Jaecoo J8", "Jaecoo J8", 2024, null, 21),
  vehicleSeed("Exeed", "Exeed", "TXL", "TXL", "Exeed TXL", "Exeed TXL", 2020, null, 22),
  vehicleSeed("Exeed", "Exeed", "VX", "VX", "Exeed VX", "Exeed VX", 2021, null, 23),
  vehicleSeed("Exeed", "Exeed", "LX", "LX", "Exeed LX", "Exeed LX", 2021, null, 24),
  vehicleSeed("Exeed", "Exeed", "RX", "RX", "Exeed RX", "Exeed RX", 2023, null, 25),
  vehicleSeed("TENET", "TENET", "T4", "T4", "TENET T4", "TENET T4", 2025, null, 26),
  vehicleSeed("TENET", "TENET", "T7", "T7", "TENET T7", "TENET T7", 2025, null, 27),
  vehicleSeed("TENET", "TENET", "T8", "T8", "TENET T8", "TENET T8", 2025, null, 28)
];
let schemaReady = false;
const assetVariantJobQueue = [];
let assetVariantJobRunning = false;

function envInt(name, fallback, min = 1, max = 10) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

class AssetVariantJobCancelledError extends Error {
  constructor(message = "Asset variant job cancelled") {
    super(message);
    this.name = "AssetVariantJobCancelledError";
  }
}

function isAssetVariantJobCancelledError(error) {
  return error instanceof AssetVariantJobCancelledError || error?.name === "AssetVariantJobCancelledError";
}

function vehicleSeed(brand, brandRu, model, modelRu, labelZh, labelRu, yearFrom, yearTo, rank, aliases = []) {
  return { brand, brandRu, model, modelRu, labelZh, labelRu, yearFrom, yearTo, popularityRank: rank, aliases };
}

export async function assetVariantBootstrap() {
  await ensureAssetVariantSchema();
  const shops = await mysqlQuery(`
    SELECT s.id, s.name, s.status, s.legal_entity, s.watermark_path,
      s.watermark_position, s.watermark_x_percent, s.watermark_y_percent, s.watermark_scale_percent, s.watermark_opacity_percent,
      r.title_style, r.tag_style, r.price_index, r.price_role, r.watermark_template_id, r.tail_image_url, r.main_image_plan,
      r.tail_category, r.vehicle_model, r.tail_template_id, r.updated_at AS rule_updated_at
    FROM shops s
    LEFT JOIN shop_variant_rules r ON r.shop_id = s.id
    WHERE s.status <> 'deleted'
    ORDER BY s.id DESC
  `);
  const templates = await mysqlQuery(`
    SELECT id, name, logo_url, logo_path, position, opacity, size_percent, margin_px, status
    FROM shop_watermark_templates
    WHERE status <> 'deleted'
    ORDER BY updated_at DESC, id DESC
  `).catch(() => []);
  const tailTemplates = await assetTailTemplates();
  await ensureVehicleSeedData();
  const vehicleModels = await assetVehicleModels();
  const ozonCategories = await assetOzonCategoryMappings();

  return {
    shops: shops.map((row, index) => normalizeShopRuleRow(row, index)),
    watermarkTemplates: [
      ...templates.map(normalizeWatermarkTemplate),
      ...shops.filter((shop) => shop.watermark_path).map((shop) => ({
        id: `shop-${shop.id}`,
        name: shop.name,
        logo_url: normalizeUrl(shop.watermark_path),
        logoUrl: normalizeUrl(shop.watermark_path),
        logoPath: resolveLocalAssetPath(shop.watermark_path),
        position: shop.watermark_position || "bottom-right",
        x_percent: Number(shop.watermark_x_percent ?? 75),
        y_percent: Number(shop.watermark_y_percent ?? 75),
        opacity: Number(shop.watermark_opacity_percent ?? 82) / 100,
        size_percent: Number(shop.watermark_scale_percent ?? 22),
        sizePercent: Number(shop.watermark_scale_percent ?? 22),
        margin_px: 24,
        margin: 24,
        status: "active"
      }))
    ],
    titleStyles: TITLE_STYLES.map((value) => ({ value, label: TITLE_STYLE_LABELS[value] })),
    tagStyles: TAG_STYLES.map((value) => ({ value, label: TAG_STYLE_LABELS[value] || value })),
    mainImagePlans: MAIN_IMAGE_PLANS,
    tailCategories: uniqueValues([
      ...ozonCategories.filter((item) => item.isAuto).map((item) => item.nameZh || item.nameRu || item.pathZh),
      ...tailTemplates.map((item) => item.category)
    ]),
    vehicleModels: uniqueValues([
      ...vehicleModels.map((item) => item.labelZh),
      ...tailTemplates.map((item) => item.vehicleModel)
    ]),
    ozonCategories,
    vehicleModelOptions: vehicleModels,
    tailTemplates
  };
}

export async function saveShopVariantRule(body = {}, session = null) {
  await ensureAssetVariantSchema();
  const shopId = Number(body.shopId || body.shop_id || 0);
  if (!shopId) throw new Error("请选择店铺");
  const existing = await mysqlQuery("SELECT updated_at FROM shop_variant_rules WHERE shop_id = ? LIMIT 1", [shopId]).then((rows) => rows[0]);
  const expectedUpdatedAt = body.updated_at || body.updatedAt || body.ruleUpdatedAt || body.rule_updated_at || "";
  if (expectedUpdatedAt && existing?.updated_at && normalizeSecond(expectedUpdatedAt) !== normalizeSecond(existing.updated_at)) {
    const error = new Error("店铺素材规则已被其他用户保存，请刷新后再继续编辑");
    error.status = 409;
    throw error;
  }
  await mysqlExecute(`
    INSERT INTO shop_variant_rules
    (shop_id, title_style, tag_style, price_index, price_role, watermark_template_id, tail_image_url, main_image_plan,
     tail_category, vehicle_model, tail_template_id, updated_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title_style = VALUES(title_style),
      tag_style = VALUES(tag_style),
      price_index = VALUES(price_index),
      price_role = VALUES(price_role),
      watermark_template_id = VALUES(watermark_template_id),
      tail_image_url = VALUES(tail_image_url),
      main_image_plan = VALUES(main_image_plan),
      tail_category = VALUES(tail_category),
      vehicle_model = VALUES(vehicle_model),
      tail_template_id = VALUES(tail_template_id),
      updated_by_person_id = VALUES(updated_by_person_id),
      updated_at = CURRENT_TIMESTAMP
  `, [
    shopId,
    normalizeTitleStyle(body.titleStyle || body.title_style),
    normalizeTagStyle(body.tagStyle || body.tag_style || body.titleStyle || body.title_style),
    normalizePriceIndex(body.priceIndex || body.price_index),
    normalizePriceRole(body.priceRole || body.price_role),
    String(body.watermarkTemplateId || body.watermark_template_id || ""),
    String(body.tailImageUrl || body.tail_image_url || ""),
    String(body.mainImagePlan || body.main_image_plan || "watermarked"),
    cleanText(body.tailCategory || body.tail_category || DEFAULT_TAIL_CATEGORY, 128),
    cleanText(body.vehicleModel || body.vehicle_model || DEFAULT_TAIL_MODEL, 128),
    Number(body.tailTemplateId || body.tail_template_id || 0) || null,
    personId(session)
  ]);
  const updated = await mysqlQuery("SELECT updated_at FROM shop_variant_rules WHERE shop_id = ? LIMIT 1", [shopId]).then((rows) => rows[0]);
  return { ok: true, shopId, updated_at: updated?.updated_at || "" };
}

export async function generateAssetVariants(body = {}, session = null, context = {}) {
  await ensureAssetVariantSchema();
  await context.throwIfCancelled?.();
  const material = normalizeMaterialPayload(body.material || body);
  const shopIds = uniqueNumbers(body.shopIds || body.shop_ids);
  const rulesInput = Array.isArray(body.rules) ? body.rules : [];
  if (!material.title) throw new Error("Missing source title");
  if (!material.mainImage) throw new Error("Missing main image");
  if (!shopIds.length) throw new Error("Please select shops");

  const bootstrap = await assetVariantBootstrap();
  const shops = bootstrap.shops.filter((shop) => shopIds.includes(Number(shop.id)));
  if (!shops.length) throw new Error("No available shops");

  const templateMap = new Map(bootstrap.watermarkTemplates.map((template) => [String(template.id), template]));
  const tailTemplateMap = new Map(bootstrap.tailTemplates.map((template) => [Number(template.id), template]));
  const ruleMap = new Map(rulesInput.map((rule) => [Number(rule.shopId || rule.shop_id), rule]));
  const batchId = `variant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const batchDir = path.join(VARIANT_ROOT, batchId);
  await fs.mkdir(batchDir, { recursive: true });

  const variants = await mapWithConcurrency(shops, ASSET_SHOP_CONCURRENCY, async (shop, shopIndex) => {
    await context.markStage?.("generate_assets", { current: shopIndex + 1, total: shops.length, shopId: shop.id, step: "shop_start" });
    const mergedRule = normalizeRule({ ...shop.rule, ...(ruleMap.get(Number(shop.id)) || {}) });
    await context.throwIfCancelled?.();
    const titleCandidates = await generateTitleCandidates(material, shop);
    await context.throwIfCancelled?.();
    const selectedTitle = titleCandidates[mergedRule.titleStyle] || fallbackTitle(material, mergedRule.titleStyle, shop);
    const title = selectedTitle.ru;
    const titleZh = selectedTitle.zh;
    const priceIndex = resolveShopPriceIndex(mergedRule.priceIndex || mergedRule.price_index, material, { ...shop, rule: mergedRule });
    const internalPrice = roundMoney(material.basePriceRmb * priceIndex);
    const ozonPrice = roundMoney(internalPrice * 2);
    const ozonOldPrice = roundMoney(internalPrice * 4);
    const shopTags = generateShopTags(material, shop, mergedRule, title);
    const shopSlug = sanitizeFilename(`shop-${shop.id}-${shop.name}`);
    const shopDir = path.join(batchDir, shopSlug);
    const infoDir = path.join(shopDir, "product-info");
    await fs.mkdir(infoDir, { recursive: true });

    const watermark = templateMap.get(String(mergedRule.watermarkTemplateId)) || defaultShopWatermark(shop);
    const tailTemplate = resolveTailTemplate(mergedRule, shop, bootstrap.tailTemplates, tailTemplateMap);
    const generatedImages = await generateVariantImages({
      material,
      shopDir,
      watermark,
      tailImageUrl: tailTemplate?.imagePath || mergedRule.tailImageUrl,
      mainImagePlan: mergedRule.mainImagePlan,
      batchId,
      shopId: shop.id,
      sourceTitle: material.title,
      variantTitle: title,
      throwIfCancelled: context.throwIfCancelled
    });
    await context.throwIfCancelled?.();

    const productInfo = buildProductInfo({ shop, title, titleZh, material: { ...material, tags: shopTags }, images: generatedImages, rule: { ...mergedRule, priceIndex, internalPrice, ozonPrice, ozonOldPrice }, tailTemplate });
    await writeText(path.join(infoDir, "title.txt"), title);
    await writeText(path.join(infoDir, "tags.txt"), shopTags.join(" "));
    await writeText(path.join(infoDir, "description.txt"), material.description);
    await writeText(path.join(infoDir, "product-info.json"), JSON.stringify(productInfo, null, 2));
    await fs.writeFile(path.join(infoDir, "product-info.xlsx"), buildProductInfoWorkbook(productInfo));
    await fs.writeFile(path.join(shopDir, "listing.xlsx"), buildListingWorkbook({ shop, title, titleZh, material: { ...material, tags: shopTags }, images: generatedImages, rule: { ...mergedRule, priceIndex, internalPrice, ozonPrice, ozonOldPrice }, tailTemplate }));
    await writeText(path.join(shopDir, "listing.json"), JSON.stringify(buildListingJson({ shop, title, titleZh, material: { ...material, tags: shopTags }, images: generatedImages, rule: { ...mergedRule, priceIndex, internalPrice, ozonPrice, ozonOldPrice }, tailTemplate }), null, 2));

    const outputDir = path.relative(ROOT_DIR, shopDir).replace(/\\/g, "/");
    const localOutputDir = shopDir;
    const insertResult = await mysqlExecute(`
      INSERT INTO asset_variants
      (batch_id, shop_id, source_title, variant_title, variant_title_zh, title_style, tag_style, price_index, internal_price, ozon_price, ozon_old_price, tags_json, description_text, images_json,
       source_product_id, ozon_category_id, ozon_description_category_id, ozon_type_id, ozon_category_name,
       length_cm, width_cm, height_cm, weight_g, color, vehicle_brand, material_text, quantity_text,
       output_dir, status, created_by_person_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?)
    `, [
      batchId,
      shop.id,
      material.title,
      title,
      titleZh,
      mergedRule.titleStyle,
      mergedRule.tagStyle,
      priceIndex,
      internalPrice,
      ozonPrice,
      ozonOldPrice,
      JSON.stringify(shopTags),
      material.description,
      JSON.stringify(generatedImages),
      Number(material.sourceProductId || material.source_product_id || 0) || null,
      material.ozonCategoryId || material.ozon_category_id || "",
      Number(material.ozonDescriptionCategoryId || material.ozon_description_category_id || 0) || 0,
      Number(material.ozonTypeId || material.ozon_type_id || 0) || 0,
      material.ozonCategoryName || material.ozon_category_name || "",
      Number(material.lengthCm || 0),
      Number(material.widthCm || 0),
      Number(material.heightCm || 0),
      Number(material.weightG || 0),
      material.color || "",
      material.vehicleBrand || "",
      material.material || "",
      material.quantity || "",
      outputDir,
      personId(session)
    ]);

    const variantId = Number(insertResult.insertId || 0);
    await insertGeneratedTitleCandidates(variantId, shop.id, titleCandidates);
    await context.throwIfCancelled?.();
    let videos = [];
    const storedVariant = {
      id: variantId,
      batch_id: batchId,
      shop_id: shop.id,
      output_dir: outputDir,
      images_json: JSON.stringify(generatedImages)
    };
    const generatedVideo = await ensureAssetVariantVideoFromImages(null, storedVariant, generatedImages, { throwIfCancelled: context.throwIfCancelled }).catch((error) => {
      console.warn("server asset video generation failed:", error.message || error);
      return null;
    });
    await context.throwIfCancelled?.();
    if (generatedVideo) videos = [normalizeGeneratedVideoForResponse(generatedVideo)];
    return {
      id: variantId,
      batchId,
      shopId: shop.id,
      shopName: shop.name,
      title,
      titleZh,
      titleStyle: mergedRule.titleStyle,
      tagStyle: mergedRule.tagStyle,
      priceIndex,
      internalPrice,
      ozonPrice,
      ozonOldPrice,
      titleCandidates,
      tags: shopTags,
      description: material.description,
      productInfo,
      images: generatedImages,
      videos,
      tailTemplate,
      previewUrl: generatedImages[0]?.previewUrl || "",
      outputDir,
      localOutputDir,
      listingUrl: fileUrl(batchId, `${shopSlug}/listing.xlsx`),
      listingJsonUrl: fileUrl(batchId, `${shopSlug}/listing.json`),
      productInfoUrl: fileUrl(batchId, `${shopSlug}/product-info/product-info.json`),
      productInfoXlsxUrl: fileUrl(batchId, `${shopSlug}/product-info/product-info.xlsx`),
      status: "generated"
    };
  });

  return {
    ok: true,
    batchId,
    createdAt: new Date().toISOString(),
    outputDir: path.relative(ROOT_DIR, batchDir).replace(/\\/g, "/"),
    localOutputDir: batchDir,
    variants
  };
}

export async function deleteAssetVariantMediaGroup(body = {}, session = null) {
  await ensureAssetVariantSchema();
  await ensureListingAutomationSchema();
  const batchId = String(body.batchId || body.batch_id || "").trim();
  const shopId = Number(body.shopId || body.shop_id || 0) || null;
  const assetIds = uniqueNumbers(body.assetIds || body.asset_ids);
  if (!batchId && !assetIds.length) throw new Error("Missing batchId or assetIds");

  let mediaAssets = [];
  let variants = [];
  let deleteMediaSql = "";
  let deleteMediaParams = [];
  let deleteVariantSql = "";
  let deleteVariantParams = [];
  if (batchId) {
    const params = [batchId];
    let shopWhere = "";
    if (shopId) {
      shopWhere = " AND shop_id = ?";
      params.push(shopId);
    }
    mediaAssets = await mysqlQuery(`
      SELECT id, local_path, source_path
      FROM listing_media_assets
      WHERE status <> 'deleted' AND batch_id = ?${shopWhere}
    `, params);
    variants = await mysqlQuery(`
      SELECT id, output_dir
      FROM asset_variants
      WHERE batch_id = ?${shopWhere}
    `, params);
    deleteMediaSql = `DELETE FROM listing_media_assets WHERE batch_id = ?${shopWhere}`;
    deleteMediaParams = params;
    deleteVariantSql = `DELETE FROM asset_variants WHERE batch_id = ?${shopWhere}`;
    deleteVariantParams = params;
  } else {
    const placeholders = assetIds.map(() => "?").join(",");
    mediaAssets = await mysqlQuery(`
      SELECT id, local_path, source_path
      FROM listing_media_assets
      WHERE status <> 'deleted' AND id IN (${placeholders})
    `, assetIds);
    deleteMediaSql = `DELETE FROM listing_media_assets WHERE id IN (${placeholders})`;
    deleteMediaParams = assetIds;
  }

  const files = new Set();
  const dirs = new Set();
  for (const asset of mediaAssets) {
    if (asset.local_path) files.add(asset.local_path);
    if (asset.source_path) files.add(asset.source_path);
  }
  for (const variant of variants) {
    if (variant.output_dir) dirs.add(variant.output_dir);
  }
  if (batchId && !shopId) dirs.add(path.relative(ROOT_DIR, path.join(VARIANT_ROOT, sanitizeFilename(batchId))).replace(/\\/g, "/"));

  let deletedFiles = 0;
  let deletedDirs = 0;
  for (const filePath of files) {
    if (await removeLocalAssetPath(filePath, { recursive: false })) deletedFiles += 1;
  }
  for (const dirPath of dirs) {
    if (await removeLocalAssetPath(dirPath, { recursive: true })) deletedDirs += 1;
  }

  if (variants.length) {
    const placeholders = variants.map(() => "?").join(",");
    await mysqlExecute(`DELETE FROM generated_titles WHERE asset_variant_id IN (${placeholders})`, variants.map((row) => Number(row.id)));
  }
  if (deleteMediaSql) await mysqlExecute(deleteMediaSql, deleteMediaParams);
  if (deleteVariantSql) await mysqlExecute(deleteVariantSql, deleteVariantParams);

  return {
    ok: true,
    batchId,
    shopId,
    assetIds,
    deletedMediaAssets: mediaAssets.length,
    deletedVariants: variants.length,
    deletedFiles,
    deletedDirs
  };
}

export async function generateAssetVariantTitlePreview(body = {}, session = null) {
  await ensureAssetVariantSchema();
  const material = normalizeMaterialPayload(body.material || body);
  const shopId = Number(body.shopId || body.shop_id || 0);
  if (!material.title) throw new Error("Missing material title");
  if (!shopId) throw new Error("请选择店铺");
  const bootstrap = await assetVariantBootstrap();
  const shop = bootstrap.shops.find((item) => Number(item.id) === shopId);
  if (!shop) throw new Error("Shop not found");
  const rule = normalizeRule({ ...shop.rule, ...(body.rule || {}) });
  const candidates = await generateTitleCandidates(material, shop);
  const selected = candidates[rule.titleStyle] || fallbackTitle(material, rule.titleStyle, shop);
  return {
    ok: true,
    shopId,
    titleStyle: rule.titleStyle,
    title: selected.ru,
    titleRu: selected.ru,
    titleZh: selected.zh,
    candidates
  };
}

export async function importAssetVariantToListingAutomation(body = {}, session = null) {
  await ensureAssetVariantSchema();
  await ensureListingAutomationSchema();
  const variantIds = uniqueNumbers(body.variantIds || body.variant_ids);
  if (!variantIds.length) return { ok: true, imported: 0, drafts: [], note: "No variants selected" };

  const variants = await mysqlQuery(`
    SELECT v.*, s.name AS shop_name, s.watermark_path
    FROM asset_variants v
    LEFT JOIN shops s ON s.id = v.shop_id
    WHERE v.id IN (${variantIds.map(() => "?").join(",")})
    ORDER BY v.id ASC
  `, variantIds);
  if (!variants.length) return { ok: true, imported: 0, drafts: [], note: "No variant rows found" };

  const drafts = [];
  const descriptionCache = new Map();
  await withMysqlTransaction(async (connection) => {
    for (const variant of variants) {
      const mediaRows = await loadAssetVariantMediaRows(connection, variant);
      const images = assetVariantImageItems(variant, mediaRows);
      let videos = assetVariantVideoItems(mediaRows);
      if (!videos.length) {
        const generatedVideo = await ensureAssetVariantVideoFromImages(connection, variant, images).catch((error) => {
          console.warn("asset variant video generation failed:", error.message || error);
          return null;
        });
        if (generatedVideo) videos = [generatedVideo];
      }
      const templateId = await ensureAssetVariantListingTemplateFromPackage(connection, variant, images, videos, session, descriptionCache);
      const draftId = await insertListingDraftFromPackage(connection, templateId, variant, images, videos, session);
      await insertListingShopCopyFromPackage(connection, draftId, variant, images, videos, session);
      await connection.execute(`
        UPDATE asset_variants
        SET imported_to_listing = 1, imported_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [variant.id]);
      drafts.push({ variantId: Number(variant.id), templateId, draftId, shopId: Number(variant.shop_id), shopName: variant.shop_name });
    }
  });

  return {
    ok: true,
    imported: drafts.length,
    drafts,
    note: `已导入 ${drafts.length} 个素材包到编辑上架`
  };
}

export async function publishAssetVariantsToOzon(body = {}, session = null, context = {}) {
  await ensureAssetVariantSchema();
  await ensureListingAutomationSchema();
  await context.throwIfCancelled?.();
  const variantIds = uniqueNumbers(body.variantIds || body.variant_ids);
  if (!variantIds.length) return { ok: false, imported: 0, published: 0, results: [], note: "No variants selected" };

  await context.markStage?.("import_listing", { variantCount: variantIds.length });
  await context.throwIfCancelled?.();
  const importResult = await importAssetVariantToListingAutomation({ variantIds }, session);
  await context.throwIfCancelled?.();
  const drafts = Array.isArray(importResult.drafts) ? importResult.drafts : [];
  const results = await mapWithConcurrency(drafts, OZON_SUBMIT_CONCURRENCY, async (item, index) => {
    await context.throwIfCancelled?.();
    const variantId = Number(item.variantId || 0);
    const draftId = Number(item.draftId || 0);
    const shopId = Number(item.shopId || 0);
    try {
      await context.markStage?.("submit_ozon", {
        current: index + 1,
        total: drafts.length,
        shopId,
        variantId
      });
      await context.throwIfCancelled?.();
      const draftRows = await mysqlQuery("SELECT template_id FROM listing_drafts WHERE id = ? LIMIT 1", [draftId]);
      const templateId = Number(draftRows[0]?.template_id || 0);
      if (!templateId || !shopId) throw new Error("Missing templateId or shopId");

      const template = await listingCategoryTemplateDetail(templateId, session);
      await context.throwIfCancelled?.();
      const precheck = await validateAssetVariantPublishPrecheck({ template, shopId, variantId, draftId }, session);
      await context.markStage?.("submit_precheck", {
        current: index + 1,
        total: drafts.length,
        shopId,
        variantId,
        ok: precheck.ok,
        errors: precheck.errors,
        warnings: precheck.warnings
      });
      if (!precheck.ok) {
        await updateAssetVariantPublishState({
          variantId,
          draftId,
          shopId,
          status: "precheck_failed",
          publishResult: { precheck }
        });
        return {
          variantId,
          draftId,
          shopId,
          shopName: item.shopName || "",
          ok: false,
          status: "precheck_failed",
          error: precheck.errors[0] || "Publish precheck failed",
          precheck
        };
      }

      await context.throwIfCancelled?.();
      await updateAssetVariantPublishState({ variantId, draftId, shopId, status: "submitting" });
      const publishResult = await publishListingTemplateToOzon({ template, shop_ids: [shopId] }, session);
      const shopResult = (publishResult.results || []).find((row) => Number(row.shop_id) === shopId) || publishResult.results?.[0] || null;
      const success = Boolean(shopResult?.ok);
      const nextStatus = success ? statusFromOzonPublishResult(shopResult) : "failed";
      await updateAssetVariantPublishState({
        variantId,
        draftId,
        shopId,
        status: nextStatus,
        publishResult: shopResult || publishResult
      });
      return {
        variantId,
        draftId,
        shopId,
        shopName: item.shopName || shopResult?.shop_name || "",
        ok: success,
        status: nextStatus,
        taskId: shopResult?.task_id || "",
        recordId: shopResult?.record_id || null,
        ozonProductId: firstOzonProductId(shopResult?.import_info || shopResult?.response),
        precheck
      };
    } catch (error) {
      await updateAssetVariantPublishState({
        variantId,
        draftId,
        shopId,
        status: "failed",
        publishResult: { error: error.message || String(error) }
      }).catch(() => null);
      return {
        variantId,
        draftId,
        shopId,
        shopName: item.shopName || "",
        ok: false,
        status: "failed",
        error: error.message || String(error)
      };
    }
  });

  const published = results.filter((item) => item.ok).length;
  return {
    ok: published > 0,
    imported: importResult.imported || 0,
    published,
    failed: results.length - published,
    importResult,
    results,
    note: published
      ? `Published ${published} item(s) to Ozon${results.length - published ? `, failed ${results.length - published}` : ""}`
      : "Create listing draft from asset variant"
  };
}

async function validateAssetVariantPublishPrecheck({ template, shopId = 0, variantId = 0, draftId = 0 } = {}, session = null) {
  const validation = await validateListingTemplatePublish(template, session);
  const payload = validation.payload || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const firstItem = items[0] || {};
  const media = firstItem.images || payload.images || [];
  const videos = firstItem.video_urls || firstItem.videos || payload.video_urls || [];
  const richContent = firstItem.rich_content_json || firstItem.rich_content || payload.rich_content_json || "";
  const errors = [...(validation.errors || [])];
  const warnings = [...(validation.warnings || [])];

  const title = String(firstItem.name || payload.name || template?.title || template?.template_name || "").trim();
  if (hasReplacementMarks(title)) errors.push("Title contains unreadable replacement marks");
  if (containsCjk(title)) warnings.push("Title still contains Chinese characters");
  if (!media.length) errors.push("No product images prepared for Ozon");
  if (!videos.length) warnings.push("No product video prepared");
  if (!richContent) warnings.push("Rich content JSON is empty");
  if (richContent && !isValidRichContentJson(richContent)) errors.push("Rich content JSON is not valid JSON");

  const dimensions = firstItem.dimension || firstItem.dimensions || payload.dimensions || {};
  const length = Number(dimensions.depth || dimensions.length || dimensions.length_cm || 0);
  const width = Number(dimensions.width || dimensions.width_cm || 0);
  const height = Number(dimensions.height || dimensions.height_cm || 0);
  if ([length, width, height].some((value) => value > 0 && value < 10)) {
    warnings.push("Package size looks too small; check cm to mm conversion before submit");
  }

  return {
    ok: errors.length === 0 && Boolean(validation.ok),
    shopId: Number(shopId || 0),
    variantId: Number(variantId || 0),
    draftId: Number(draftId || 0),
    errors: uniqueValues(errors),
    warnings: uniqueValues(warnings),
    qualityEstimate: validation.quality_estimate || null,
    checkedAt: new Date().toISOString()
  };
}

export async function publishSelectionProductToOzon(body = {}, session = null, context = {}) {
  await ensureAssetVariantSchema();
  await ensureListingAutomationSchema();
  const productId = Number(body.productId || body.product_id || body.selectionId || body.selection_id || 0);
  if (!productId) throw new Error("缺少选品 ID");

  await context.markStage?.("load_product", { productId });
  const productRows = await mysqlQuery("SELECT * FROM products WHERE id = ? AND active = 1 LIMIT 1", [productId]);
  const product = productRows[0];
  if (!product) throw new Error("Product not found");
  if (!Number(product.package_weight_g || product.weight_g || 0)) throw new Error("请先填写包装克重后再一键上架");
  const publisherName = await personNameForSession(session);

  await context.markStage?.("bootstrap", { productId });
  const bootstrap = await assetVariantBootstrap();
  const requestedShopIds = uniqueNumbers(body.shopIds || body.shop_ids);
  const shopIds = (requestedShopIds.length ? requestedShopIds : bootstrap.shops.map((shop) => shop.id))
    .map(Number)
    .filter(Boolean);
  if (!shopIds.length) throw new Error("Please select shops");

  const mainImage = product.image_url || product.primary_image || `/api/products/${product.id}/image`;
  const detailImages = normalizeProductImageList(product.detail_image_urls || product.detailImageUrls);
  await context.markStage?.("generate_assets", { productId, shopCount: shopIds.length });
  const generateResult = await generateAssetVariants({
    material: {
      title: product.name || product.product_name || product.selection_id || `Product ${product.id}`,
      tags: product.tags || product.keywords || "",
      description: product.selling_points || product.supplier_note || "",
      ownerName: publisherName,
      publisherName,
      sourceProductId: product.id,
      ozonCategoryId: product.ozon_category_id || "",
      ozonDescriptionCategoryId: product.ozon_description_category_id || 0,
      ozonTypeId: product.ozon_type_id || 0,
      ozonCategoryName: product.ozon_category_name || "",
      vehicleBrand: product.vehicle_brand || "",
      vehicleModel: product.vehicle_model || "",
      basePriceRmb: Number(product.air_sale_price_rmb || product.sale_price_rmb || product.listing_price_rub / (product.exchange_rate || 11.32) || 0),
      quantity: product.purchase_quantity ? `${product.purchase_quantity} pcs` : "",
      color: product.color || "",
      material: product.material || "",
      lengthCm: Number(product.length_cm || 0),
      widthCm: Number(product.width_cm || 0),
      heightCm: Number(product.height_cm || 0),
      weightG: Number(product.package_weight_g || product.weight_g || 0),
      mainImage,
      detailImages
    },
    shopIds,
    rules: bootstrap.shops
      .filter((shop) => shopIds.includes(Number(shop.id)))
      .map((shop) => ({ shopId: shop.id, ...(shop.rule || {}) }))
  }, session, context);

  const variantIds = (generateResult.variants || []).map((variant) => Number(variant.id || 0)).filter(Boolean);
  await context.throwIfCancelled?.();
  await context.markStage?.("publish_assets", { productId, variantCount: variantIds.length });
  const publishResult = await publishAssetVariantsToOzon({ variantIds }, session, context);
  await context.markStage?.("done", { productId, variantCount: variantIds.length, published: publishResult.published || 0 });
  return {
    ok: publishResult.ok,
    productId,
    selectionId: product.selection_id || "",
    batchId: generateResult.batchId,
    generated: variantIds.length,
    ...publishResult
  };
}

export async function enqueuePublishSelectionProductToOzon(body = {}, session = null) {
  await ensureAssetVariantSchema();
  const productId = Number(body.productId || body.product_id || body.selectionId || body.selection_id || 0);
  if (!productId) throw new Error("Missing productId");
  const jobNo = `AVJ-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36).toUpperCase()}`;
  const insertResult = await mysqlExecute(`
    INSERT INTO asset_variant_jobs
    (job_no, job_type, status, product_id, request_json, created_by_person_id)
    VALUES (?, 'publish_selection', 'queued', ?, ?, ?)
  `, [
    jobNo,
    productId,
    JSON.stringify(body || {}),
    personId(session)
  ]);
  const jobId = Number(insertResult.insertId || 0);
  enqueueAssetVariantJob({ id: jobId, session: { personId: personId(session) } });
  return {
    ok: true,
    accepted: true,
    jobId,
    jobNo,
    productId,
    status: "queued",
    note: `后台一键上架任务已创建：${jobNo}`
  };
}

export async function assetVariantJobs(query = {}) {
  await ensureAssetVariantSchema();
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 200);
  const rows = await mysqlQuery(`
    SELECT j.*, p.name AS product_name, p.selection_id
    FROM asset_variant_jobs j
    LEFT JOIN products p ON p.id = j.product_id
    ORDER BY j.id DESC
    LIMIT ?
  `, [limit]);
  return rows.map(normalizeAssetVariantJobRow);
}

export async function assetVariantJobDetail(id) {
  await ensureAssetVariantSchema();
  const rows = await mysqlQuery(`
    SELECT j.*, p.name AS product_name, p.selection_id
    FROM asset_variant_jobs j
    LEFT JOIN products p ON p.id = j.product_id
    WHERE j.id = ?
    LIMIT 1
  `, [Number(id)]);
  return rows[0] ? normalizeAssetVariantJobRow(rows[0]) : null;
}

export async function cancelAssetVariantJob(id, session = null) {
  await ensureAssetVariantSchema();
  const jobId = Number(id || 0);
  if (!jobId) throw new Error("Missing jobId");
  const rows = await mysqlQuery("SELECT * FROM asset_variant_jobs WHERE id = ? LIMIT 1", [jobId]);
  const job = rows[0];
  if (!job) throw new Error("Asset variant job not found");
  if (!["queued", "running"].includes(String(job.status || ""))) {
    return {
      ok: true,
      cancelled: false,
      jobId,
      status: job.status || "",
      note: "Asset variant job is not running"
    };
  }
  const beforeLength = assetVariantJobQueue.length;
  for (let index = assetVariantJobQueue.length - 1; index >= 0; index -= 1) {
    if (Number(assetVariantJobQueue[index]?.id || 0) === jobId) assetVariantJobQueue.splice(index, 1);
  }
  await mysqlExecute(`
    UPDATE asset_variant_jobs
    SET status = 'cancelled',
      current_stage = 'cancelled',
      progress_json = JSON_OBJECT('currentStage', 'cancelled', 'cancelledAt', UTC_TIMESTAMP()),
      error_json = ?,
      finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('queued', 'running')
  `, [JSON.stringify({ message: "Cancelled by user", personId: personId(session) || null }), jobId]);
  return {
    ok: true,
    cancelled: true,
    removedFromQueue: beforeLength !== assetVariantJobQueue.length,
    jobId,
    status: "cancelled",
    note: "Asset variant job cancelled"
  };
}

export async function retryAssetVariantJobFailures(id, session = null) {
  await ensureAssetVariantSchema();
  await ensureListingAutomationSchema();
  const jobId = Number(id || 0);
  if (!jobId) throw new Error("Missing jobId");
  const jobRows = await mysqlQuery("SELECT * FROM asset_variant_jobs WHERE id = ? LIMIT 1", [jobId]);
  const job = jobRows[0];
  if (!job) throw new Error("Asset variant job not found");
  const result = parseJson(job.result_json, {});
  const failedVariantIds = uniqueNumbers((result.results || [])
    .filter((item) => !item.ok)
    .map((item) => item.variantId || item.variant_id));
  if (!failedVariantIds.length) {
    return { ok: true, retried: 0, note: "No failed asset variants to retry" };
  }
  const retryResult = await publishAssetVariantsToOzon({ variantIds: failedVariantIds }, session, {
    markStage: async () => {}
  });
  return {
    ok: retryResult.ok,
    retried: failedVariantIds.length,
    sourceJobId: jobId,
    ...retryResult
  };
}

function enqueueAssetVariantJob(job) {
  if (assetVariantJobQueue.some((item) => Number(item.id) === Number(job.id))) return;
  assetVariantJobQueue.push(job);
  setTimeout(processNextAssetVariantJob, 0);
}

export async function recoverAssetVariantJobsOnStartup() {
  await ensureAssetVariantSchema();
  await mysqlExecute(`
    UPDATE asset_variant_jobs
    SET status = 'queued',
      current_stage = 'recovered',
      progress_json = JSON_OBJECT('currentStage', 'recovered', 'recoveredAt', UTC_TIMESTAMP()),
      started_at = NULL,
      finished_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'running' AND finished_at IS NULL
  `);
  const rows = await mysqlQuery(`
    SELECT id, created_by_person_id
    FROM asset_variant_jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC, id ASC
    LIMIT 50
  `);
  for (const row of rows) {
    enqueueAssetVariantJob({ id: Number(row.id), session: { personId: Number(row.created_by_person_id || 0) || null } });
  }
  return { ok: true, queued: rows.length };
}

async function processNextAssetVariantJob() {
  if (assetVariantJobRunning) return;
  const job = assetVariantJobQueue.shift();
  if (!job) return;
  assetVariantJobRunning = true;
  try {
    await runAssetVariantJob(job);
  } finally {
    assetVariantJobRunning = false;
    if (assetVariantJobQueue.length) setTimeout(processNextAssetVariantJob, 0);
  }
}

async function runAssetVariantJob(job) {
  const rows = await mysqlQuery("SELECT * FROM asset_variant_jobs WHERE id = ? LIMIT 1", [Number(job.id)]);
  const row = rows[0];
  if (!row || row.status !== "queued") return;
  const request = parseJson(row.request_json, {});
  const progress = createAssetVariantJobProgress(row.id);
  await mysqlExecute(`
    UPDATE asset_variant_jobs
    SET status = 'running', current_stage = 'starting', progress_json = ?,
      started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [JSON.stringify(progress.snapshot("starting")), row.id]);
  try {
    let result;
    if (row.job_type === "publish_selection") {
      result = await publishSelectionProductToOzon(request, job.session || null, {
        jobId: row.id,
        markStage: (stage, detail = {}) => updateAssetVariantJobStage(row.id, progress, stage, detail),
        throwIfCancelled: () => throwIfAssetVariantJobCancelled(row.id)
      });
    } else {
      throw new Error(`不支持的素材裂变任务类型：${row.job_type}`);
    }
    const status = result?.ok ? "success" : "failed";
    const finalProgress = progress.finish(status);
    await mysqlExecute(`
      UPDATE asset_variant_jobs
      SET status = ?, batch_id = ?, total_count = ?, success_count = ?, failed_count = ?,
        result_json = ?, error_json = NULL, current_stage = ?, progress_json = ?,
        finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `, [
      status,
      result?.batchId || "",
      Number(result?.generated || result?.results?.length || 0),
      Number(result?.published || 0),
      Number(result?.failed || 0),
      JSON.stringify(result || {}),
      status,
      JSON.stringify(finalProgress),
      row.id
    ]);
  } catch (error) {
    if (isAssetVariantJobCancelledError(error)) {
      await mysqlExecute(`
        UPDATE asset_variant_jobs
        SET status = 'cancelled',
          current_stage = 'cancelled',
          error_json = ?,
          finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('queued', 'running')
      `, [JSON.stringify({ message: error.message || "Asset variant job cancelled" }), row.id]);
      return;
    }
    const finalProgress = progress.finish("failed", { error: error.message || String(error) });
    await mysqlExecute(`
      UPDATE asset_variant_jobs
      SET status = 'failed', failed_count = GREATEST(failed_count, 1), error_json = ?,
        current_stage = 'failed', progress_json = ?,
        finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `, [JSON.stringify({ message: error.message || String(error), stack: error.stack || "" }), JSON.stringify(finalProgress), row.id]);
  }
}

function createAssetVariantJobProgress(jobId) {
  const startedAt = Date.now();
  const phases = [];
  let current = null;
  return {
    snapshot(stage, detail = {}) {
      const now = Date.now();
      if (current && current.stage !== stage) {
        current.endedAt = new Date(now).toISOString();
        current.durationMs = now - current.startedMs;
      }
      if (!current || current.stage !== stage) {
        current = {
          stage,
          detail,
          startedAt: new Date(now).toISOString(),
          startedMs: now
        };
        phases.push(current);
      } else {
        current.detail = { ...(current.detail || {}), ...detail };
      }
      return {
        jobId: Number(jobId || 0),
        currentStage: stage,
        elapsedMs: now - startedAt,
        phases: phases.map(({ startedMs, ...phase }) => phase)
      };
    },
    finish(stage, detail = {}) {
      return this.snapshot(stage, detail);
    }
  };
}

async function updateAssetVariantJobStage(jobId, progress, stage, detail = {}) {
  await throwIfAssetVariantJobCancelled(jobId);
  const snapshot = progress.snapshot(stage, detail);
  await mysqlExecute(`
    UPDATE asset_variant_jobs
    SET current_stage = ?, progress_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'running'
  `, [stage, JSON.stringify(snapshot), Number(jobId)]);
}

async function throwIfAssetVariantJobCancelled(jobId) {
  const rows = await mysqlQuery("SELECT status FROM asset_variant_jobs WHERE id = ? LIMIT 1", [Number(jobId)]);
  if (String(rows[0]?.status || "") === "cancelled") throw new AssetVariantJobCancelledError();
}

function normalizeAssetVariantJobRow(row = {}) {
  return {
    id: Number(row.id || 0),
    jobId: Number(row.id || 0),
    jobNo: row.job_no || "",
    jobType: row.job_type || "",
    status: row.status || "",
    productId: Number(row.product_id || 0) || null,
    productName: row.product_name || "",
    selectionId: row.selection_id || "",
    batchId: row.batch_id || "",
    totalCount: Number(row.total_count || 0),
    successCount: Number(row.success_count || 0),
    failedCount: Number(row.failed_count || 0),
    request: parseJson(row.request_json, null),
    result: parseJson(row.result_json, null),
    error: parseJson(row.error_json, null),
    currentStage: row.current_stage || "",
    progress: parseJson(row.progress_json, null),
    createdByPersonId: Number(row.created_by_person_id || 0) || null,
    startedAt: row.started_at || "",
    finishedAt: row.finished_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

export async function assetTailTemplates(query = {}) {
  await ensureAssetVariantSchema();
  const rows = await mysqlQuery(`
    SELECT t.*, s.name AS shop_name
    FROM asset_tail_templates t
    LEFT JOIN shops s ON s.id = t.shop_id
    WHERE t.status <> 'deleted'
    ORDER BY t.is_default DESC, t.shop_id DESC, t.category ASC, t.vehicle_model ASC, t.sort_order ASC, t.id DESC
  `);
  return rows.map(normalizeTailTemplate).filter((item) => {
    if (query.shopId && Number(item.shopId || 0) !== Number(query.shopId) && Number(item.shopId || 0) !== 0) return false;
    if (query.category && item.category !== String(query.category)) return false;
    if (query.vehicleModel && item.vehicleModel !== String(query.vehicleModel)) return false;
    return true;
  });
}

export async function syncAssetOzonCategories(body = {}) {
  await ensureAssetVariantSchema();
  const shopId = Number(body.shopId || body.shop_id || 0);
  const shops = await mysqlQuery(`
    SELECT id, name, ozon_client_id, api_key_hint
    FROM shops
    WHERE status <> 'deleted'
      AND ozon_client_id IS NOT NULL AND ozon_client_id <> ''
      AND api_key_hint IS NOT NULL AND api_key_hint <> ''
      AND api_key_hint NOT LIKE 'demo%'
      ${shopId ? "AND id = ?" : ""}
    ORDER BY id DESC
    LIMIT 1
  `, shopId ? [shopId] : []);
  const shop = shops[0];
  if (!shop) throw new Error("Shop not found or missing Ozon API config");
  const tree = await fetchOzonDescriptionCategoryTree(shop, { language: body.language || "DEFAULT" });
  const rows = flattenOzonCategoryTree(tree);
  let saved = 0;
  for (const row of rows) {
    if (!row.descriptionCategoryId && !row.typeId) continue;
    await mysqlExecute(`
      INSERT INTO ozon_category_mappings
      (description_category_id, type_id, name_ru, name_zh, path_ru, path_zh, parent_description_category_id,
       is_auto, source_shop_id, source, raw_json, status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ozon_api', ?, 'active', CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        name_ru = VALUES(name_ru),
        name_zh = VALUES(name_zh),
        path_ru = VALUES(path_ru),
        path_zh = VALUES(path_zh),
        parent_description_category_id = VALUES(parent_description_category_id),
        is_auto = VALUES(is_auto),
        source_shop_id = VALUES(source_shop_id),
        raw_json = VALUES(raw_json),
        status = 'active',
        synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `, [
      row.descriptionCategoryId,
      row.typeId,
      row.nameRu,
      row.nameZh,
      row.pathRu,
      row.pathZh,
      row.parentDescriptionCategoryId,
      row.isAuto ? 1 : 0,
      shop.id,
      JSON.stringify(row.raw || {})
    ]);
    saved += 1;
  }
  return { ok: true, shopId: Number(shop.id), shopName: shop.name, saved };
}

export async function createAssetTailTemplate(body = {}, session = null) {
  await ensureAssetVariantSchema();
  const shopId = Number(body.shopId || body.shop_id || 0) || null;
  const category = cleanText(body.category || DEFAULT_TAIL_CATEGORY, 128);
  const vehicleModel = cleanText(body.vehicleModel || body.vehicle_model || DEFAULT_TAIL_MODEL, 128);
  const name = cleanText(body.name || `${category}-${vehicleModel}-image`, 255);
  const isDefault = Boolean(body.isDefault ?? body.is_default);
  const imagePath = await storeTailTemplateImage(body.image || body.imageData || body.image_data || body.imagePath || body.image_path, name);
  if (!imagePath) throw new Error("Missing image path");

  if (isDefault) {
    await mysqlExecute(`
      UPDATE asset_tail_templates
      SET is_default = 0
      WHERE status <> 'deleted'
        AND COALESCE(shop_id, 0) = COALESCE(?, 0)
        AND category = ?
        AND vehicle_model = ?
    `, [shopId, category, vehicleModel]);
  }

  const result = await mysqlExecute(`
    INSERT INTO asset_tail_templates
    (shop_id, category, vehicle_model, name, image_path, purpose, is_default, sort_order, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, 'anti_hijack', ?, ?, ?)
  `, [
    shopId,
    category,
    vehicleModel,
    name,
    imagePath,
    isDefault ? 1 : 0,
    Number(body.sortOrder || body.sort_order || 0),
    personId(session)
  ]);
  return (await assetTailTemplates()).find((item) => Number(item.id) === Number(result.insertId));
}

export async function resolveAssetTailTemplateFile(id) {
  await ensureAssetVariantSchema();
  const template = (await assetTailTemplates()).find((item) => Number(item.id) === Number(id));
  if (!template?.imagePath) return null;
  const candidates = [
    resolveLocalAssetPath(template.imagePath),
    path.resolve(TAIL_TEMPLATE_ROOT, path.basename(String(template.imagePath || ""))),
    path.resolve(ROOT_DIR, String(template.imagePath || "").replace(/^\/+/, ""))
  ].filter(Boolean);
  for (const filePath of uniqueValues(candidates)) {
    try {
      const buffer = await fs.readFile(filePath);
      return { buffer, mime: mimeForPath(filePath) };
    } catch {
      // Try the next storage location; older templates have moved between roots.
    }
  }
  return null;
}

export async function resolveAssetVariantFile(batchId, filename) {
  const safeBatch = sanitizeFilename(batchId);
  const cleanName = String(filename || "").replace(/\\/g, "/").split("/").filter(Boolean).map(sanitizeFilename).join("/");
  const filePath = path.resolve(VARIANT_ROOT, safeBatch, cleanName);
  const batchDir = path.resolve(VARIANT_ROOT, safeBatch);
  if (!filePath.startsWith(batchDir)) return null;
  try {
    const buffer = await fs.readFile(filePath);
    return { buffer, mime: mimeForPath(filePath) };
  } catch {
    return null;
  }
}

async function ensureAssetVariantSchema() {
  if (config.dbClient !== "mysql") throw new Error("MySQL database is required");
  if (schemaReady) return;
  await ensureShopWatermarkDefaultColumns();
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS shop_variant_rules (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      shop_id BIGINT NOT NULL,
      title_style VARCHAR(32) NOT NULL DEFAULT 'functional',
      watermark_template_id VARCHAR(128) NOT NULL DEFAULT '',
      tail_image_url TEXT NULL,
      tail_category VARCHAR(128) NOT NULL DEFAULT '',
      vehicle_model VARCHAR(128) NOT NULL DEFAULT '',
      tail_template_id BIGINT NULL,
      main_image_plan VARCHAR(32) NOT NULL DEFAULT 'watermarked',
      updated_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_shop_variant_rules_shop (shop_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await ensureMysqlColumn("shop_variant_rules", "tail_category", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("shop_variant_rules", "vehicle_model", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("shop_variant_rules", "tail_template_id", "BIGINT NULL");
  await ensureMysqlColumn("shop_variant_rules", "tag_style", "VARCHAR(32) NOT NULL DEFAULT 'traffic'");
  await ensureMysqlColumn("shop_variant_rules", "price_index", "DECIMAL(10,4) NOT NULL DEFAULT 1.0000");
  await ensureMysqlColumn("shop_variant_rules", "price_role", "VARCHAR(32) NOT NULL DEFAULT ''");
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS asset_tail_templates (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      shop_id BIGINT NULL,
      category VARCHAR(128) NOT NULL DEFAULT '',
      vehicle_model VARCHAR(128) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      image_path TEXT NOT NULL,
      purpose VARCHAR(64) NOT NULL DEFAULT 'anti_hijack',
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_asset_tail_templates_scope (shop_id, category, vehicle_model, status),
      INDEX idx_asset_tail_templates_default (is_default, status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS asset_variants (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      batch_id VARCHAR(128) NOT NULL,
      shop_id BIGINT NOT NULL,
      source_title VARCHAR(500) NOT NULL DEFAULT '',
      variant_title VARCHAR(500) NOT NULL DEFAULT '',
      variant_title_zh VARCHAR(500) NOT NULL DEFAULT '',
      title_style VARCHAR(32) NOT NULL DEFAULT 'functional',
      tags_json LONGTEXT NULL,
      description_text LONGTEXT NULL,
      source_product_id BIGINT NULL,
      ozon_category_id VARCHAR(128) NOT NULL DEFAULT '',
      ozon_description_category_id BIGINT NOT NULL DEFAULT 0,
      ozon_type_id BIGINT NOT NULL DEFAULT 0,
      ozon_category_name VARCHAR(500) NOT NULL DEFAULT '',
      length_cm DECIMAL(10,2) NOT NULL DEFAULT 0,
      width_cm DECIMAL(10,2) NOT NULL DEFAULT 0,
      height_cm DECIMAL(10,2) NOT NULL DEFAULT 0,
      weight_g DECIMAL(10,2) NOT NULL DEFAULT 0,
      color VARCHAR(128) NOT NULL DEFAULT '',
      vehicle_brand VARCHAR(128) NOT NULL DEFAULT '',
      material_text VARCHAR(128) NOT NULL DEFAULT '',
      quantity_text VARCHAR(64) NOT NULL DEFAULT '',
      images_json LONGTEXT NULL,
      output_dir TEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      imported_to_listing TINYINT(1) NOT NULL DEFAULT 0,
      imported_at TIMESTAMP NULL,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_asset_variants_batch (batch_id, shop_id),
      INDEX idx_asset_variants_shop (shop_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await ensureMysqlColumn("asset_variants", "source_product_id", "BIGINT NULL");
  await ensureMysqlColumn("asset_variants", "variant_title_zh", "VARCHAR(500) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "ozon_category_id", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "ozon_description_category_id", "BIGINT NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "ozon_type_id", "BIGINT NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "ozon_category_name", "VARCHAR(500) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "length_cm", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "width_cm", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "height_cm", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "weight_g", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "color", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "vehicle_brand", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "material_text", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "quantity_text", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "tag_style", "VARCHAR(32) NOT NULL DEFAULT 'traffic'");
  await ensureMysqlColumn("asset_variants", "price_index", "DECIMAL(10,4) NOT NULL DEFAULT 1.0000");
  await ensureMysqlColumn("asset_variants", "internal_price", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "ozon_price", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "ozon_old_price", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS asset_variant_ai_cache (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      cache_key VARCHAR(128) NOT NULL,
      kind VARCHAR(64) NOT NULL DEFAULT '',
      response_json LONGTEXT NULL,
      provider VARCHAR(64) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'ready',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_asset_variant_ai_cache_key (cache_key),
      INDEX idx_asset_variant_ai_cache_kind (kind, updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS asset_variant_video_cache (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      source_hash VARCHAR(128) NOT NULL,
      recipe_version VARCHAR(64) NOT NULL DEFAULT '',
      publish_url TEXT NOT NULL,
      preview_url TEXT NULL,
      original_name VARCHAR(255) NOT NULL DEFAULT 'shop-video.mp4',
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_asset_variant_video_cache (source_hash, recipe_version),
      INDEX idx_asset_variant_video_cache_updated (updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS asset_variant_jobs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      job_no VARCHAR(64) NOT NULL,
      job_type VARCHAR(64) NOT NULL DEFAULT 'publish_selection',
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      product_id BIGINT NULL,
      batch_id VARCHAR(128) NOT NULL DEFAULT '',
      total_count INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      request_json LONGTEXT NULL,
      result_json LONGTEXT NULL,
      error_json LONGTEXT NULL,
      current_stage VARCHAR(64) NOT NULL DEFAULT '',
      progress_json LONGTEXT NULL,
      created_by_person_id BIGINT NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_asset_variant_jobs_no (job_no),
      INDEX idx_asset_variant_jobs_status (status, created_at),
      INDEX idx_asset_variant_jobs_product (product_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await ensureMysqlColumn("asset_variant_jobs", "current_stage", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variant_jobs", "progress_json", "LONGTEXT NULL");
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS generated_titles (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      asset_variant_id BIGINT NULL,
      shop_id BIGINT NOT NULL,
      style VARCHAR(32) NOT NULL,
      title VARCHAR(500) NOT NULL,
      provider VARCHAR(64) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'generated',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_generated_titles_variant (asset_variant_id),
      INDEX idx_generated_titles_shop_style (shop_id, style)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS asset_vehicle_models (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      brand VARCHAR(128) NOT NULL,
      brand_ru VARCHAR(128) NOT NULL DEFAULT '',
      model VARCHAR(128) NOT NULL,
      model_ru VARCHAR(128) NOT NULL DEFAULT '',
      label_zh VARCHAR(255) NOT NULL DEFAULT '',
      label_ru VARCHAR(255) NOT NULL DEFAULT '',
      year_from INT NULL,
      year_to INT NULL,
      aliases_json LONGTEXT NULL,
      popularity_rank INT NOT NULL DEFAULT 999,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_asset_vehicle_model (brand, model, year_from, year_to),
      INDEX idx_asset_vehicle_models_brand (brand, status),
      INDEX idx_asset_vehicle_models_rank (popularity_rank, status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ozon_category_mappings (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      description_category_id BIGINT NOT NULL DEFAULT 0,
      type_id BIGINT NOT NULL DEFAULT 0,
      name_ru VARCHAR(500) NOT NULL DEFAULT '',
      name_zh VARCHAR(500) NOT NULL DEFAULT '',
      path_ru TEXT NULL,
      path_zh TEXT NULL,
      parent_description_category_id BIGINT NOT NULL DEFAULT 0,
      is_auto TINYINT(1) NOT NULL DEFAULT 0,
      source_shop_id BIGINT NULL,
      source VARCHAR(64) NOT NULL DEFAULT 'ozon_api',
      raw_json LONGTEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      synced_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ozon_category_mapping (description_category_id, type_id),
      INDEX idx_ozon_category_auto (is_auto, status),
      INDEX idx_ozon_category_name (name_zh(120), name_ru(120))
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  schemaReady = true;
}

async function ensureShopWatermarkDefaultColumns() {
  for (const sql of [
    "ALTER TABLE shops ADD COLUMN watermark_position VARCHAR(32) NOT NULL DEFAULT 'bottom-right'",
    "ALTER TABLE shops ADD COLUMN watermark_x_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_y_percent DECIMAL(8,4) NOT NULL DEFAULT 75.0000",
    "ALTER TABLE shops ADD COLUMN watermark_scale_percent DECIMAL(8,4) NOT NULL DEFAULT 22.0000",
    "ALTER TABLE shops ADD COLUMN watermark_opacity_percent DECIMAL(8,4) NOT NULL DEFAULT 82.0000"
  ]) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }
}

async function ensureMysqlColumn(table, column, definition) {
  try {
    await mysqlExecute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
}

async function assetVehicleModels() {
  await ensureAssetVariantSchema();
  const rows = await mysqlQuery(`
    SELECT *
    FROM asset_vehicle_models
    WHERE status = 'active'
    ORDER BY popularity_rank ASC, brand ASC, model ASC
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    brand: row.brand,
    brandRu: row.brand_ru,
    model: row.model,
    modelRu: row.model_ru,
    labelZh: row.label_zh || `${row.brand} ${row.model}`,
    labelRu: row.label_ru || [row.brand_ru, row.model_ru].filter(Boolean).join(" "),
    yearFrom: Number(row.year_from || 0) || null,
    yearTo: Number(row.year_to || 0) || null,
    aliases: parseJson(row.aliases_json, []),
    popularityRank: Number(row.popularity_rank || 999)
  }));
}

async function assetOzonCategoryMappings() {
  await ensureAssetVariantSchema();
  const rows = await mysqlQuery(`
    SELECT *
    FROM ozon_category_mappings
    WHERE status = 'active'
    ORDER BY is_auto DESC, path_zh ASC, name_zh ASC, name_ru ASC
    LIMIT 2000
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    descriptionCategoryId: Number(row.description_category_id || 0),
    typeId: Number(row.type_id || 0),
    nameRu: row.name_ru || "",
    nameZh: row.name_zh || "",
    pathRu: row.path_ru || "",
    pathZh: row.path_zh || "",
    isAuto: Boolean(row.is_auto),
    label: row.name_zh || row.path_zh || row.name_ru || row.path_ru,
    subLabel: row.name_ru || row.path_ru || "",
    value: row.name_zh || row.path_zh || row.name_ru || row.path_ru
  }));
}

async function ensureVehicleSeedData() {
  const countRows = await mysqlQuery("SELECT COUNT(*) AS count FROM asset_vehicle_models WHERE status = 'active'");
  if (Number(countRows[0]?.count || 0) > 0) return;
  for (const row of REAL_RUSSIA_VEHICLE_MODELS) {
    await mysqlExecute(`
      INSERT IGNORE INTO asset_vehicle_models
      (brand, brand_ru, model, model_ru, label_zh, label_ru, year_from, year_to, aliases_json, popularity_rank)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.brand,
      row.brandRu,
      row.model,
      row.modelRu,
      row.labelZh,
      row.labelRu,
      row.yearFrom || null,
      row.yearTo || null,
      JSON.stringify(row.aliases || []),
      row.popularityRank
    ]);
  }
}

async function generateVariantImages({ material, shopDir, watermark, tailImageUrl, mainImagePlan, batchId, shopId, sourceTitle = "", variantTitle = "", throwIfCancelled = null }) {
  await throwIfCancelled?.();
  const images = [];
  const mainDir = path.join(shopDir, "images", "main");
  const detailDir = path.join(shopDir, "images", "details");
  const tailDir = path.join(shopDir, "images", "tail");
  await fs.mkdir(mainDir, { recursive: true });
  await fs.mkdir(detailDir, { recursive: true });
  await fs.mkdir(tailDir, { recursive: true });

  const mainOutput = path.join(mainDir, "main-01.jpg");
  const mainBuffer = await readImageBuffer(material.mainImage);
  await throwIfCancelled?.();
  if (mainImagePlan === "original") {
    await sharp(mainBuffer).rotate().jpeg({ quality: 92 }).toFile(mainOutput);
  } else if (mainImagePlan === "ai_similar") {
    const edited = await generateAiSimilarMainImage({
      mainBuffer,
      material,
      sourceTitle,
      variantTitle
    });
    await sharp(edited).rotate().jpeg({ quality: 92 }).toFile(mainOutput);
  } else {
    const mainImage = await applyWatermark(mainBuffer, watermark);
    await mainImage.jpeg({ quality: 92 }).toFile(mainOutput);
  }
  images.push(await imageResult(mainOutput, "main", 1, { batchId, shopId, sourceTitle, variantTitle }));
  await throwIfCancelled?.();

  const detailSources = material.detailImages.length ? [...material.detailImages] : [material.mainImage].filter(Boolean);

  const detailImages = await mapWithConcurrency(detailSources, ASSET_IMAGE_CONCURRENCY, async (source, index) => {
    await throwIfCancelled?.();
    const output = path.join(detailDir, `detail-${String(index + 1).padStart(2, "0")}.jpg`);
    const buffer = await readImageBuffer(source);
    await throwIfCancelled?.();
    const detailImage = await applyWatermark(buffer, watermark);
    await detailImage.jpeg({ quality: 92 }).toFile(output);
    await throwIfCancelled?.();
    return imageResult(output, "detail", index + 1, { batchId, shopId, sourceTitle, variantTitle });
  });
  images.push(...detailImages);
  await throwIfCancelled?.();

  if (tailImageUrl) {
    const output = path.join(tailDir, `tail-01.jpg`);
    const buffer = await readImageBuffer(tailImageUrl);
    await throwIfCancelled?.();
    const tailImage = await applyWatermark(buffer, watermark);
    await tailImage.jpeg({ quality: 92 }).toFile(output);
    images.push(await imageResult(output, "tail", 1, { batchId, shopId, sourceTitle, variantTitle }));
  }
  return images;
}

async function generateAiSimilarMainImage({ mainBuffer, material, sourceTitle = "", variantTitle = "" }) {
  const referencePng = await sharp(mainBuffer).rotate().png().toBuffer();
  const prompt = [
    "Use the uploaded image as a reference and create a similar but not identical e-commerce main image.",
    "Keep the same product category, visual hierarchy, premium commercial ad feeling, and marketplace-ready 3:4 composition.",
    "Do not copy the exact original image. Recompose lighting, background, product angle, and typography while preserving the selling intent.",
    "For Ozon Russian market automotive accessory listing: luxury city or studio scene, clear product focus, high contrast, realistic materials.",
    sourceTitle ? `Source product title: ${sourceTitle}.` : "",
    variantTitle ? `Target listing title: ${variantTitle}.` : "",
    material?.description ? `Product notes: ${cleanText(material.description, 400)}.` : "",
    material?.tags ? `Keywords: ${cleanText(material.tags, 300)}.` : ""
  ].filter(Boolean).join("\n");

  return editOpenAiImage({
    imageBuffer: referencePng,
    filename: "main-reference.png",
    contentType: "image/png",
    prompt,
    ratio: "3:4"
  });
}

async function storeTailTemplateImage(source, name) {
  const text = String(source || "").trim();
  if (!text) return "";
  if (/^data:image\//i.test(text)) {
    await fs.mkdir(TAIL_TEMPLATE_ROOT, { recursive: true });
    const match = text.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid asset variant file URL");
    const ext = imageExtension(match[1]);
    const filename = `${Date.now().toString(36)}-${sanitizeFilename(name).slice(0, 40)}.${ext}`;
    const filePath = path.join(TAIL_TEMPLATE_ROOT, filename);
    await fs.writeFile(filePath, Buffer.from(match[2], "base64"));
    return path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
  }
  return text;
}

function imageExtension(mimePart) {
  const value = String(mimePart || "").toLowerCase();
  if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
  if (value.includes("webp")) return "webp";
  if (value.includes("png")) return "png";
  return "png";
}

async function generateTitleCandidates(material, shop) {
  try {
    const prompt = buildTitleGenerationPrompt(material, shop);
    const result = await cachedAiCall({
      kind: "asset_variant_title",
      cacheInput: { prompt },
      provider: "",
      request: { prompt, temperature: 0.35, maxTokens: 900 },
      maxAttempts: 2
    });
    return normalizeTitleCandidateObject(parseJsonFromText(result.content), material, shop);
  } catch {
    return Object.fromEntries(TITLE_STYLES.map((style) => [style, fallbackTitle(material, style, shop)]));
  }
}

function buildTitleGenerationPrompt(material, shop) {
  const dimensions = [material.lengthCm, material.widthCm, material.heightCm].filter(Boolean).join(' x ');
  const productFacts = {
    sourceProductNameZh: material.title || '',
    color: material.color || '',
    material: material.material || '',
    quantity: material.quantity || '',
    dimensionsCm: dimensions,
    weightG: material.weightG || '',
    sellingPointsZh: material.description || '',
    tags: material.tags || [],
    shopName: shop?.name || ''
  };
  return [
    'You are an Ozon Russia listing title specialist for automotive accessories.',
    'The input product name is Chinese source material only. Do NOT transliterate it and do NOT place the Chinese name at the beginning of the Russian title.',
    'The Russian title field MUST contain Russian/Latin letters and numbers only where needed. It MUST NOT contain any Chinese characters.',
    'Create original Russian product titles that fit Ozon product card expectations: the buyer must quickly understand product type, compatible car/model if present, material, color, quantity, and key value.',
    'Use natural Russian. Avoid keyword stuffing, unsupported claims, price words, discount words, contact info, competitor names, and absolute claims such as best/guaranteed/original unless the fact is explicitly provided.',
    'Do not use words meaning replica/fake/copy/1:1/analog/original/genuine. Keep titles truthful to the given facts.',
    'Return ONLY valid JSON with keys traffic, material, scenario, value, premium.',
    'Each key must be an object: {"ru":"Russian Ozon title","zh":"Chinese meaning of the Russian title"}.',
    'Russian title target length: 70-120 characters. Chinese meaning target length: 35-80 Chinese characters.',
    'Style strategy:',
    'traffic: search-oriented. Include product type + compatible car/model terms + common buyer search terms, but keep it readable.',
    'material: emphasize material, protection, durability, anti-scratch/fit only if supported by selling points.',
    'scenario: emphasize daily use, car owner use, commuting, gift/use scene, and compatibility.',
    'value: emphasize practical configuration and value-for-money without saying cheap or mentioning price.',
    'premium: emphasize refined look, material texture, precise fit, custom/special feel only when appropriate.',
    'Product facts JSON:',
    JSON.stringify(productFacts, null, 2)
  ].join('\n');
}
async function insertGeneratedTitleCandidates(variantId, shopId, candidates) {
  for (const style of TITLE_STYLES) {
    const title = typeof candidates[style] === "string" ? candidates[style] : candidates[style]?.ru || "";
    await mysqlExecute(`
      INSERT INTO generated_titles (asset_variant_id, shop_id, style, title, provider, status)
      VALUES (?, ?, ?, ?, 'ai_or_fallback', 'generated')
    `, [variantId, shopId, style, title]);
  }
}

async function cachedAiCall({ kind = "general", cacheInput = {}, provider = "", request = {}, maxAttempts = 2 } = {}) {
  const cacheKey = stableHash({ kind, provider, cacheInput });
  const rows = await mysqlQuery(`
    SELECT response_json
    FROM asset_variant_ai_cache
    WHERE cache_key = ? AND status = 'ready'
    LIMIT 1
  `, [cacheKey]).catch(() => []);
  const cached = parseJson(rows[0]?.response_json, null);
  if (cached?.content) return { ...cached, cached: true };

  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts || 1)); attempt += 1) {
    try {
      const result = await chatWithAiProvider(request);
      await mysqlExecute(`
        INSERT INTO asset_variant_ai_cache (cache_key, kind, response_json, provider, status)
        VALUES (?, ?, ?, ?, 'ready')
        ON DUPLICATE KEY UPDATE response_json = VALUES(response_json), provider = VALUES(provider), status = 'ready', updated_at = CURRENT_TIMESTAMP
      `, [cacheKey, kind, JSON.stringify(result || {}), provider || request.provider || "default"]).catch(() => null);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(400 * attempt);
    }
  }
  throw lastError || new Error("AI request failed");
}

async function applyWatermark(sourceBuffer, watermark) {
  if (!watermark?.logoPath && !watermark?.logoUrl && !watermark?.logo_url) return sharp(sourceBuffer).rotate();
  const base = sharp(sourceBuffer).rotate();
  const metadata = await base.metadata();
  const baseWidth = Number(metadata.width || 0);
  const baseHeight = Number(metadata.height || 0);
  if (!baseWidth || !baseHeight) throw new Error("闂佸搫鍟版慨鐢垫兜閸撲焦瀚氶柛鈩冾殔閻掑ジ鏌涢妷銉モ挃濠⒀勭墱娴滄悂宕崟闈涙");

  const watermarkBuffer = await readImageBuffer(watermark.logoPath || watermark.logoUrl || watermark.logo_url);
  const targetWidth = Math.max(1, Math.round(baseWidth * clamp(Number(watermark.sizePercent || watermark.size_percent || 22), 5, 60) / 100));
  const wm = await sharp(watermarkBuffer).resize({ width: targetWidth, withoutEnlargement: true }).ensureAlpha().png().toBuffer();
  const wmMeta = await sharp(wm).metadata();
  const opacity = clamp(Number(watermark.opacity ?? 0.82), 0.05, 1);
  const transparent = await sharp(wm)
    .composite([{ input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: "dest-in" }])
    .png()
    .toBuffer();
  const rect = watermarkRect(
    baseWidth,
    baseHeight,
    Number(wmMeta.width || targetWidth),
    Number(wmMeta.height || 1),
    watermark.position,
    Number(watermark.margin || watermark.margin_px || 24),
    Number(watermark.xPercent ?? watermark.x_percent ?? 75),
    Number(watermark.yPercent ?? watermark.y_percent ?? 75)
  );
  return base.composite([{ input: transparent, left: rect.left, top: rect.top }]);
}

function watermarkRect(baseWidth, baseHeight, width, height, position, margin, xPercent = 75, yPercent = 75) {
  const safeMargin = Math.max(0, margin);
  let left = baseWidth - width - safeMargin;
  let top = baseHeight - height - safeMargin;
  if (position === "custom") {
    left = Math.round(baseWidth * clamp(Number(xPercent), 0, 100) / 100);
    top = Math.round(baseHeight * clamp(Number(yPercent), 0, 100) / 100);
  } else if (position === "top-left") {
    left = safeMargin;
    top = safeMargin;
  } else if (position === "top-right") {
    left = baseWidth - width - safeMargin;
    top = safeMargin;
  } else if (position === "bottom-left") {
    left = safeMargin;
    top = baseHeight - height - safeMargin;
  } else if (position === "bottom-center") {
    left = Math.round((baseWidth - width) / 2);
    top = baseHeight - height - safeMargin;
  }
  return {
    left: Math.max(0, Math.min(left, Math.max(0, baseWidth - width))),
    top: Math.max(0, Math.min(top, Math.max(0, baseHeight - height)))
  };
}

async function loadAssetVariantMediaRows(connection, variant) {
  const sql = `
    SELECT *
    FROM listing_media_assets
    WHERE source_module = 'asset_variant'
      AND status <> 'deleted'
      AND batch_id = ?
      AND (shop_id = ? OR shop_id IS NULL)
    ORDER BY FIELD(role, 'main', 'detail', 'tail', 'video'), sort_order ASC, id ASC
  `;
  const params = [variant.batch_id || "", Number(variant.shop_id || 0)];
  const rows = connection
    ? (await connection.execute(sql, params))[0]
    : await mysqlQuery(sql, params);
  return Array.isArray(rows) ? rows : [];
}

function assetMediaUrl(item = {}) {
  return item.publish_url || item.publishUrl || item.url || item.preview_url || item.previewUrl || item.outputPath || item.local_path || item.localPath || "";
}

function assetVariantImageItems(variant, mediaRows = []) {
  const fromJson = parseJson(variant.images_json, []).map((image, index) => ({
    url: assetMediaUrl(image),
    preview_url: image.previewUrl || image.preview_url || image.url || "",
    publish_url: image.publishUrl || image.publish_url || image.url || "",
    type: image.type || image.role || "detail",
    role: image.type || image.role || "detail",
    name: image.name || image.original_name || "",
    outputPath: image.outputPath || image.output_path || "",
    localListingPath: image.localListingPath || image.local_listing_path || image.local_path || "",
    sort_order: Number(image.sortOrder || image.sort_order || index + 1)
  }));
  const fromMedia = mediaRows
    .filter((row) => String(row.media_type || "").toLowerCase() !== "video" && String(row.role || "").toLowerCase() !== "video")
    .map((row, index) => ({
      url: assetMediaUrl(row),
      preview_url: row.preview_url || "",
      publish_url: row.publish_url || "",
      type: row.role || "detail",
      role: row.role || "detail",
      name: row.original_name || row.storage_name || "",
      outputPath: row.source_path || "",
      localListingPath: row.local_path || "",
      sort_order: Number(row.sort_order || index + 1)
    }));
  const seen = new Set();
  return [...fromJson, ...fromMedia].filter((image) => {
    const url = String(image.url || "").trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function assetVariantVideoItems(mediaRows = []) {
  return mediaRows
    .filter((row) => String(row.media_type || "").toLowerCase() === "video" || String(row.role || "").toLowerCase() === "video")
    .map((row, index) => ({
      url: assetMediaUrl(row),
      preview_url: row.preview_url || "",
      publish_url: row.publish_url || "",
      name: row.original_name || row.storage_name || `video-${index + 1}`,
      sort_order: Number(row.sort_order || index + 1)
    }))
    .filter((item) => item.url);
}

function normalizeGeneratedVideoForResponse(video = {}) {
  const url = video.publish_url || video.publishUrl || video.url || "";
  const previewUrl = video.preview_url || video.previewUrl || video.url || "";
  return {
    id: video.id || `server-video-${Date.now().toString(36)}`,
    name: video.name || video.original_name || "shop-video.mp4",
    url,
    previewUrl,
    localUrl: previewUrl,
    publishUrl: video.publish_url || video.publishUrl || url,
    size: Number(video.file_size || video.size || 0),
    contentType: video.mime_type || video.contentType || "video/mp4"
  };
}

async function ensureAssetVariantVideoFromImages(connection, variant = {}, images = [], context = {}) {
  return assetVideoLimiter(() => ensureAssetVariantVideoFromImagesUnsafe(connection, variant, images, context));
}

async function ensureAssetVariantVideoFromImagesUnsafe(connection, variant = {}, images = [], context = {}) {
  await context.throwIfCancelled?.();
  const existingRows = await loadAssetVariantMediaRows(connection, variant);
  const existingVideos = assetVariantVideoItems(existingRows.filter(isReusableAssetVideoRow));
  if (existingVideos.length) return existingVideos[0];

  const sourceImage = images.find((image) => String(image.role || image.type || "").toLowerCase() === "main") ||
    images.find((image) => String(image.role || image.type || "").toLowerCase() === "tail") ||
    images.find((image) => assetMediaUrl(image));
  if (!sourceImage) return null;

  const sourcePath = resolveLocalAssetPath(sourceImage.localListingPath || sourceImage.local_path || sourceImage.outputPath || sourceImage.output_path || sourceImage.url);
  if (!sourcePath || !fsSync.existsSync(sourcePath)) return null;
  await context.throwIfCancelled?.();

  const variantDir = resolveLocalAssetPath(variant.output_dir || "");
  if (!variantDir) return null;
  const recipe = serverVideoRecipe();
  const sourceHash = await fileSha256(sourcePath).catch(() => "");
  if (sourceHash) {
    const cachedRows = await mysqlQuery(`
      SELECT publish_url, preview_url, original_name, metadata_json
      FROM asset_variant_video_cache
      WHERE source_hash = ? AND recipe_version = ?
      LIMIT 1
    `, [sourceHash, recipe.version]).catch(() => []);
    const cached = cachedRows[0];
    if (cached?.publish_url) {
      return {
        url: cached.publish_url,
        preview_url: cached.preview_url || cached.publish_url,
        publish_url: cached.publish_url,
        name: cached.original_name || "shop-video.mp4",
        sort_order: 1,
        cached: true
      };
    }
  }
  await context.throwIfCancelled?.();
  const videoDir = path.join(variantDir, "videos");
  await fs.mkdir(videoDir, { recursive: true });
  const videoPath = path.join(videoDir, "shop-video.mp4");
  let generatedBy = "server_ffmpeg_fast";
  if (ASSET_FAST_VIDEO) {
    try {
      await renderServerVideoFast(sourcePath, videoPath);
      await context.throwIfCancelled?.();
    } catch (error) {
      generatedBy = "server_ffmpeg_frames";
      console.warn("fast asset video generation failed, fallback to frame renderer:", error.message || error);
      await renderServerVideoWithFrames(sourcePath, videoDir, videoPath, context);
    }
  } else {
    generatedBy = "server_ffmpeg_frames";
    await renderServerVideoWithFrames(sourcePath, videoDir, videoPath, context);
  }
  await context.throwIfCancelled?.();

  const asset = await registerListingMediaAssetFromFile({
    filePath: videoPath,
    source_module: "asset_variant",
    source_id: `${variant.batch_id || ""}:${variant.shop_id || ""}:video:1`,
    batch_id: variant.batch_id || "",
    shop_id: Number(variant.shop_id || 0) || null,
    media_type: "video",
    role: "video",
    sort_order: 1,
    original_name: "shop-video.mp4",
    mime_type: "video/mp4",
    metadata: {
      generatedBy,
      videoRecipe: recipe,
      assetVariantId: Number(variant.id || 0),
      sourceImage: sourceImage.outputPath || sourceImage.url || ""
    }
  });
  if (sourceHash && asset.publish_url) {
    await mysqlExecute(`
      INSERT INTO asset_variant_video_cache (source_hash, recipe_version, publish_url, preview_url, original_name, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE publish_url = VALUES(publish_url), preview_url = VALUES(preview_url),
        original_name = VALUES(original_name), metadata_json = VALUES(metadata_json), updated_at = CURRENT_TIMESTAMP
    `, [
      sourceHash,
      recipe.version,
      asset.publish_url || asset.publishUrl || asset.url || "",
      asset.preview_url || asset.previewUrl || "",
      asset.original_name || asset.storage_name || "shop-video.mp4",
      JSON.stringify({ generatedBy, videoRecipe: recipe, sourceImage: sourceImage.outputPath || sourceImage.url || "" })
    ]).catch(() => null);
  }

  return {
    url: asset.publish_url || asset.publishUrl || asset.url || "",
    preview_url: asset.preview_url || asset.previewUrl || "",
    publish_url: asset.publish_url || asset.publishUrl || "",
    name: asset.original_name || asset.storage_name || "shop-video.mp4",
    sort_order: 1
  };
}

async function renderServerVideoFast(sourcePath, videoPath) {
  const frameCount = SERVER_VIDEO_FPS * SERVER_VIDEO_DURATION_SECONDS;
  await runFfmpeg([
    "-y",
    "-loop", "1",
    "-i", sourcePath,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-vf",
    [
      `scale=${SERVER_VIDEO_WIDTH}:${SERVER_VIDEO_HEIGHT}:force_original_aspect_ratio=increase`,
      `crop=${SERVER_VIDEO_WIDTH}:${SERVER_VIDEO_HEIGHT}`,
      `zoompan=z='min(zoom+0.00045,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${SERVER_VIDEO_WIDTH}x${SERVER_VIDEO_HEIGHT}:fps=${SERVER_VIDEO_FPS}`,
      "format=yuv420p"
    ].join(","),
    "-frames:v", String(frameCount),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-c:a", "aac",
    "-b:a", "96k",
    "-shortest",
    "-movflags", "+faststart",
    videoPath
  ]);
}

async function renderServerVideoWithFrames(sourcePath, videoDir, videoPath, context = {}) {
  const frameDir = path.join(videoDir, "frames");
  await fs.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(frameDir, { recursive: true });
  try {
    await renderServerVideoFrames(sourcePath, frameDir, context);
    await context.throwIfCancelled?.();
    await runFfmpeg([
      "-y",
      "-framerate", String(SERVER_VIDEO_FPS),
      "-i", path.join(frameDir, "frame-%04d.jpg"),
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-r", String(SERVER_VIDEO_FPS),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "21",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "96k",
      "-shortest",
      "-movflags", "+faststart",
      videoPath
    ]);
  } finally {
    await fs.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderServerVideoFrames(sourcePath, frameDir, context = {}) {
  const frameCount = SERVER_VIDEO_FPS * SERVER_VIDEO_DURATION_SECONDS;
  const source = sharp(sourcePath).rotate();
  const metadata = await source.metadata();
  const sourceWidth = Number(metadata.width || SERVER_VIDEO_WIDTH);
  const sourceHeight = Number(metadata.height || SERVER_VIDEO_HEIGHT);
  const sourceBuffer = await source.toBuffer();

  for (let index = 0; index < frameCount; index += 1) {
    if (index % 6 === 0) await context.throwIfCancelled?.();
    const progress = index / Math.max(1, frameCount - 1);
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const scale = 1.04 + Math.max(0, Math.sin(progress * Math.PI * 10)) * 0.018 + eased * 0.035;
    const coverScale = Math.max(SERVER_VIDEO_WIDTH / sourceWidth, SERVER_VIDEO_HEIGHT / sourceHeight) * scale;
    const coverWidth = Math.max(SERVER_VIDEO_WIDTH, Math.round(sourceWidth * coverScale));
    const coverHeight = Math.max(SERVER_VIDEO_HEIGHT, Math.round(sourceHeight * coverScale));
    const shakeX = Math.sin(progress * Math.PI * 12) * SERVER_VIDEO_WIDTH * 0.004;
    const shakeY = Math.cos(progress * Math.PI * 10) * SERVER_VIDEO_HEIGHT * 0.003;
    const left = clamp(Math.round((coverWidth - SERVER_VIDEO_WIDTH) / 2 - shakeX), 0, Math.max(0, coverWidth - SERVER_VIDEO_WIDTH));
    const top = clamp(Math.round((coverHeight - SERVER_VIDEO_HEIGHT) / 2 - shakeY), 0, Math.max(0, coverHeight - SERVER_VIDEO_HEIGHT));
    const frameBase = await sharp(sourceBuffer)
      .resize(coverWidth, coverHeight, { fit: "fill" })
      .extract({ left, top, width: SERVER_VIDEO_WIDTH, height: SERVER_VIDEO_HEIGHT })
      .jpeg({ quality: 94 })
      .toBuffer();
    const overlays = [
      { input: Buffer.from(serverVideoShineSvg(progress)), left: 0, top: 0 },
      { input: Buffer.from(serverVideoVignetteSvg()), left: 0, top: 0 }
    ];
    await sharp({
      create: {
        width: SERVER_VIDEO_WIDTH,
        height: SERVER_VIDEO_HEIGHT,
        channels: 3,
        background: "#f8fafc"
      }
    })
      .composite([{ input: frameBase, left: 0, top: 0 }, ...overlays])
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(path.join(frameDir, `frame-${String(index + 1).padStart(4, "0")}.jpg`));
  }
}

function serverVideoRecipe() {
  return {
    version: "server-video-recipe-v3-fast",
    width: SERVER_VIDEO_WIDTH,
    height: SERVER_VIDEO_HEIGHT,
    fps: SERVER_VIDEO_FPS,
    durationSeconds: SERVER_VIDEO_DURATION_SECONDS,
    motion: "fast_zoom",
    effects: ASSET_FAST_VIDEO ? ["ken_burns_zoom"] : ["shine", "soft_vignette"],
    format: "mp4_h264_aac"
  };
}

function isReusableAssetVideoRow(row = {}) {
  if (String(row.media_type || "").toLowerCase() !== "video" && String(row.role || "").toLowerCase() !== "video") return false;
  const metadata = parseJson(row.metadata_json, {});
  if (String(metadata.generatedBy || "").startsWith("server_ffmpeg")) {
    return ["server-video-recipe-v2", "server-video-recipe-v3-fast"].includes(metadata.videoRecipe?.version);
  }
  return true;
}

function serverVideoShineSvg(progress) {
  const width = SERVER_VIDEO_WIDTH;
  const height = SERVER_VIDEO_HEIGHT;
  const sweep = ((progress * 1.35) % 1.15) - 0.25;
  const x = Math.round(width * sweep);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="white" stop-opacity="0"/>
        <stop offset="0.45" stop-color="white" stop-opacity="0.42"/>
        <stop offset="1" stop-color="white" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <g transform="translate(${x} ${Math.round(height * 0.48)}) rotate(-12.6)">
      <rect x="${-Math.round(width * 0.12)}" y="${-height}" width="${Math.round(width * 0.28)}" height="${height * 2}" fill="url(#shine)"/>
    </g>
  </svg>`;
}

function serverVideoVignetteSvg() {
  const width = SERVER_VIDEO_WIDTH;
  const height = SERVER_VIDEO_HEIGHT;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="white" stop-opacity="0.10"/>
        <stop offset="0.52" stop-color="white" stop-opacity="0"/>
        <stop offset="1" stop-color="#0f172a" stop-opacity="0.10"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#shade)"/>
  </svg>`;
}

function runFfmpeg(args = []) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = ffmpegInstaller?.path;
    if (!ffmpegPath || !fsSync.existsSync(ffmpegPath)) {
      reject(new Error("ffmpeg executable not found"));
      return;
    }
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(stderr.slice(-1000) || `ffmpeg exited with code ${code}`));
    });
  });
}

function assetVariantModelName(variant) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const typeId = Number(variant.ozon_type_id || 0) || "asset";
  const shopId = Number(variant.shop_id || 0) || "S";
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `MZ-${today}-${typeId}-${shopId}-${random}`;
}

function assetVariantQuantity(value) {
  return Number(String(value || "").match(/\d+/)?.[0] || 1);
}


async function assetVariantDescription(variant, tags = []) {
  const title = cleanText(variant.variant_title || variant.source_title || "", 500);
  const material = russianMaterialText(variant.material_text);
  const color = russianColorText(variant.color);
  const vehicle = extractLikelyCarModel(String(variant.variant_title || "") + " " + String(variant.source_title || "")) || "";
  try {
    const request = {
      provider: "deepseek",
      messages: [
        { role: "system", content: [
          "Write only natural buyer-facing Russian product prose for Ozon.",
          "Do not include shop names, hashtags, tag lists, keyword dumps, or phrases like 'ключевые особенности', 'теги', 'ключевые слова'.",
          "Do not paste comma-separated tags into the description.",
          "Every sentence must explain real product information: purpose, material, fit, protection, use scenario, package contents.",
          "No Chinese or English except brand/model names and material abbreviations such as TPU or ABS."
        ].join(" ") },
        { role: "user", content: [
          "Write a natural Ozon short description in Russian, 100-150 words.",
          "Title: " + title,
          "Vehicle/model: " + vehicle,
          "Material: " + material,
          "Color: " + color,
          "Semantic tags for context only, do not copy them literally: " + tags.join(" ")
        ].join("\n") }
      ],
      response_format: { type: "text" }
    };
    const result = await cachedAiCall({
      kind: "asset_variant_description",
      cacheInput: request,
      provider: "deepseek",
      request,
      maxAttempts: 2
    });
    const text = sanitizeOzonDescriptionText(cleanText(result.content || "", 1400));
    if (russianWordCount(text) >= 70 && !looksBrokenGeneratedText(text) && !hasCjkText(text)) return text;
  } catch (error) {
    console.warn("asset variant description AI failed", error?.message || error);
  }
  return fallbackRussianDescription(variant, tags);
}

function russianWordCount(value) {
  return String(value || "").split(/\s+/).filter(Boolean).length;
}

function sanitizeOzonDescriptionText(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  text = text
    .replace(/Ключевые особенности\s*:\s*[^.?!]+[.?!]?/giu, "")
    .replace(/Ключевые слова\s*:\s*[^.?!]+[.?!]?/giu, "")
    .replace(/Теги\s*:\s*[^.?!]+[.?!]?/giu, "")
    .replace(/Хэштеги\s*:\s*[^.?!]+[.?!]?/giu, "");
  text = text.replace(/#[\p{L}\p{N}_-]+/gu, "");
  text = text.replace(/\b(?:ruvibemart|ruvibe\s*mart)\b[,;\s]*/giu, "");
  text = text.replace(/\s*,\s*,+/g, ", ").replace(/\s{2,}/g, " ").trim();
  text = text.replace(/\s*,\s*,+/g, ", ").replace(/\s{2,}/g, " ").trim();
  return text;
}

function fallbackRussianDescription(variant, tags = []) {
  const material = russianMaterialText(variant.material_text);
  const color = russianColorText(variant.color);
  const vehicle = extractLikelyCarModel(variant.variant_title || variant.source_title || variant.vehicle_model || "") || "автомобиля";
  const productType = detectProductType(variant.variant_title || variant.source_title || "", variant.description || "");
  return sanitizeOzonDescriptionText([
    `${productType} для ${vehicle} подходит для ежедневного использования, аккуратной защиты и удобного хранения.`,
    `Материал ${material} помогает снизить риск царапин, потертостей и следов от постоянного контакта с другими предметами.`,
    `Цвет ${color} выглядит сдержанно и легко сочетается с интерьером автомобиля и личными аксессуарами.`,
    "Форма рассчитана на комфортный хват, быстрый доступ к кнопкам и уверенное использование в дороге, на парковке и дома.",
    "Описание помогает покупателю понять назначение товара, ключевые преимущества, сценарии применения и совместимость с автомобилем.",
    "Подходит как практичный автоаксессуар и небольшой подарок водителю."
  ].join(" "));
}

function russianMaterialText(value) {
  const text = String(value || "").trim();
  if (/tpu|тпу|polyurethane|полиуретан|热塑|弹性体/i.test(text)) return "TPU";
  if (/abs/i.test(text)) return "ABS-пластик";
  if (/silicone|силикон|硅胶/i.test(text)) return "силикон";
  if (/stainless|steel|нержав|不锈钢|钢/i.test(text)) return "нержавеющая сталь";
  if (/leather|кожа|皮|牛皮/i.test(text)) return "искусственная кожа";
  if (/plastic|пластик|塑料/i.test(text)) return "пластик";
  return text && !/[\u4e00-\u9fff]/.test(text) && !looksBrokenGeneratedText(text) ? text : "прочный материал";
}

function russianColorText(value) {
  const text = String(value || "").trim();
  if (/black|черн|黑/i.test(text)) return "черный";
  if (/white|бел|白/i.test(text)) return "белый";
  if (/silver|серебр|gray|grey|серый|银|灰/i.test(text)) return "серебристый";
  if (/red|красн|红/i.test(text)) return "красный";
  if (/blue|син|голуб|蓝/i.test(text)) return "синий";
  if (/gold|золот|金/i.test(text)) return "золотистый";
  if (/transparent|прозрач|透明/i.test(text)) return "прозрачный";
  return text && !/[\u4e00-\u9fff]/.test(text) && !looksBrokenGeneratedText(text) ? text : "черный";
}

function assetVariantDimensions(variant) {
  return {
    length_cm: numberValue(variant.length_cm),
    width_cm: numberValue(variant.width_cm),
    height_cm: numberValue(variant.height_cm),
    weight_g: numberValue(variant.weight_g)
  };
}


function assetVariantRichContentJson(description = "", images = [], title = "") {
  const tailImage = images.find((image) => String(image.role || image.type || "").toLowerCase() === "tail");
  const imageUrl = assetMediaUrl(tailImage || images.find((image) => assetMediaUrl(image)) || {});
  const cleanDescription = sanitizeOzonDescriptionText(description);
  if (!imageUrl || !cleanDescription) return "";
  return JSON.stringify({
    content: [{ widgetName: "raShowcase", type: "billboard", blocks: [{
      imgLink: "",
      img: { src: imageUrl, srcMobile: imageUrl, alt: "", position: "width_full", positionMobile: "width_full", widthMobile: 1024, heightMobile: 1536 },
      title: { items: [{ type: "text", content: cleanRussianTitle(title || "Автомобильный аксессуар", 120) }], size: "size4", align: "left", color: "color1" },
      text: { size: "size2", align: "left", color: "color1", items: [{ type: "text", content: cleanDescription }] }
    }] }],
    version: 0.3
  });
}

function assetVariantAttributes(variant, tags = [], description = "", modelName = "", richContentJson = "") {
  const cleanDescription = sanitizeOzonDescriptionText(description);
  return [
    { name: "Brand", value: "No brand", required: true, source: "asset_variant" },
    { name: "Model name", value: modelName, required: true, attribute_id: 9048, source: "asset_variant" },
    { name: "Product tags", value: tags.join(" "), values: tags, required: false, source: "asset_variant" },
    { name: "Description", value: cleanDescription, required: false, attribute_id: 4191, type: "textarea", source: "asset_variant" },
    { name: "Rich content JSON", value: richContentJson, required: false, attribute_id: 11254, type: "rich_json", source: "asset_variant" },
    { name: "Color", value: variant.color || "", required: false, source: "asset_variant" },
    { name: "Material", value: variant.material_text || "", required: false, source: "asset_variant" },
    { name: "Quantity", value: variant.quantity_text || "", required: false, source: "asset_variant" },
    { name: "Source", value: "asset-variant-engine", required: false, source: "asset_variant" },
    { name: "Title style", value: variant.title_style || "", required: false, source: "asset_variant" }
  ].map((item, index) => ({ ...item, sort_order: index + 1 })).filter((item) => item.value || item.values?.length);
}

function assetVariantVariantRow(variant, images = [], videos = [], modelName = "") {
  const dimensions = assetVariantDimensions(variant);
  const videoUrls = videos.map((item) => item.publish_url || item.url).filter(Boolean);
  return {
    id: `asset-variant-${variant.id}`,
    sku: `AV-${variant.id}-${Date.now().toString(36)}`,
    offer_id: `AV-${variant.id}-${Date.now().toString(36)}`,
    name: variant.variant_title || variant.source_title || modelName,
    title: variant.variant_title || variant.source_title || modelName,
    images,
    video_urls: videoUrls,
    video_cover_urls: videoUrls,
    price: numberValue(variant.ozon_price || numberValue(variant.internal_price) * 2),
    old_price: numberValue(variant.ozon_old_price || numberValue(variant.internal_price) * 4),
    price_strategy_applied: true,
    color: variant.color || "",
    vehicle_brand: variant.vehicle_brand || "",
    spec: modelName,
    material: variant.material_text || "",
    quantity: assetVariantQuantity(variant.quantity_text),
    weight_g: dimensions.weight_g,
    length_mm: Math.round(dimensions.length_cm * 10),
    width_mm: Math.round(dimensions.width_cm * 10),
    height_mm: Math.round(dimensions.height_cm * 10),
    stock: 0,
    sort_order: 1
  };
}

async function ensureAssetVariantListingTemplateFromPackage(connection, variant, images = [], videos = [], session, descriptionCache = null) {
  const ozonCategoryId = cleanText(variant.ozon_category_id || "", 128) || "asset-variant";
  const ozonCategoryName = cleanText(variant.ozon_category_name || "", 500) || "asset variant";
  const descriptionCategoryId = Number(variant.ozon_description_category_id || 0) || 0;
  const typeId = Number(variant.ozon_type_id || 0) || 0;
  const tags = parseJson(variant.tags_json, []);
  const modelName = assetVariantModelName(variant);
  const descriptionCacheKey = [
    Number(variant.source_product_id || 0) || variant.source_title || variant.variant_title || "",
    variant.material_text || "",
    variant.color || "",
    variant.quantity_text || ""
  ].join("|");
  let description = descriptionCache?.get(descriptionCacheKey);
  if (!description) {
    description = await assetVariantDescription(variant, tags);
    descriptionCache?.set(descriptionCacheKey, description);
  }
  const richContentJson = assetVariantRichContentJson(description, images, variant.variant_title || variant.source_title || "");
  const dimensions = assetVariantDimensions(variant);
  const attributes = assetVariantAttributes(variant, tags, description, modelName, richContentJson);
  const sourceRaw = {
    asset_variant_id: Number(variant.id),
    batch_id: variant.batch_id || "",
    shop_id: Number(variant.shop_id || 0),
    shop_name: variant.shop_name || "",
    ozon_category_id: ozonCategoryId,
    description_category_id: descriptionCategoryId || "",
    type_id: typeId || "",
    category_name: ozonCategoryName,
    price_index: Number(variant.price_index || 1),
    internal_price: Number(variant.internal_price || 0),
    ozon_price: Number(variant.ozon_price || 0),
    ozon_old_price: Number(variant.ozon_old_price || 0)
  };
  const editablePayload = {
    sku: `AV-${variant.id}`,
    title: variant.variant_title || variant.source_title || "",
    description,
    ozon_category_id: ozonCategoryId,
    description_category_id: descriptionCategoryId || "",
    type_id: typeId || "",
    legacy_category_id: ozonCategoryId,
    category_name: ozonCategoryName,
    source_raw: sourceRaw,
    price: {
      value: Number(variant.ozon_price || Number(variant.internal_price || 0) * 2 || 0),
      old_price: Number(variant.ozon_old_price || Number(variant.internal_price || 0) * 4 || 0),
      currency_code: "CNY",
      strategy_applied: true,
      vat: "0"
    },
    dimensions,
    logistics: {
      color: variant.color || "",
      spec: modelName,
      model: modelName,
      material: variant.material_text || "",
      quantity: assetVariantQuantity(variant.quantity_text)
    },
    rich_content_json: richContentJson,
    rich_content: richContentJson,
    images,
    videos,
    attributes,
    variants: [assetVariantVariantRow(variant, images, videos, modelName)]
  };
  const name = `缂備浇浜慨闈涱焽濡ゅ懎绀岄柛娑卞墰閻熸劙鏌?${variant.batch_id || "batch"}-${variant.shop_name || variant.shop_id || "shop"}-${variant.id}`;
  const [rows] = await connection.execute(`
    SELECT id
    FROM listing_category_templates
    WHERE source_type = 'asset_variant_engine' AND template_name = ? AND ozon_category_id = ? AND status <> 'deleted'
    ORDER BY id ASC
    LIMIT 1
  `, [name, ozonCategoryId]);
  if (rows[0]?.id) {
    await connection.execute(`
      UPDATE listing_category_templates
      SET category_name = ?, source_raw_json = ?, editable_payload_json = ?, title = ?, description = ?,
          attributes_json = ?, images_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      ozonCategoryName,
      JSON.stringify(sourceRaw),
      JSON.stringify(editablePayload),
      editablePayload.title,
      editablePayload.description,
      JSON.stringify(attributes),
      JSON.stringify(images),
      Number(rows[0].id)
    ]);
    return Number(rows[0].id);
  }
  const [result] = await connection.execute(`
    INSERT INTO listing_category_templates
    (ozon_category_id, category_name, template_name, required_attributes_json, ai_rules_json, title_prompt,
     description_prompt, image_rules_json, source_type, source_raw_json, editable_payload_json, title, description,
     attributes_json, images_json, created_by_person_id, updated_at)
    VALUES (?, ?, ?, '[]', '{}', '', '', '{}', 'asset_variant_engine', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    ozonCategoryId,
    ozonCategoryName,
    name,
    JSON.stringify(sourceRaw),
    JSON.stringify(editablePayload),
    editablePayload.title,
    editablePayload.description,
    JSON.stringify(attributes),
    JSON.stringify(images),
    personId(session)
  ]);
  return Number(result.insertId);
}

async function insertListingDraftFromPackage(connection, templateId, variant, images, videos = [], session) {
  const manualFacts = {
    source: "asset-variant-engine",
    asset_variant_id: Number(variant.id),
    batch_id: variant.batch_id,
    title_style: variant.title_style,
    tag_style: variant.tag_style,
    price_index: Number(variant.price_index || 1),
    internal_price: Number(variant.internal_price || 0),
    ozon_price: Number(variant.ozon_price || 0),
    ozon_old_price: Number(variant.ozon_old_price || 0),
    tags: parseJson(variant.tags_json, []),
    ozon_category_id: variant.ozon_category_id || "",
    description_category_id: Number(variant.ozon_description_category_id || 0) || "",
    type_id: Number(variant.ozon_type_id || 0) || "",
    category_name: variant.ozon_category_name || "",
    shop_id: Number(variant.shop_id),
    shop_name: variant.shop_name || "",
    videos
  };
  const [result] = await connection.execute(`
    INSERT INTO listing_drafts
    (template_id, product_name, internal_code, source_urls_json, source_images_json, cost_price, sale_price,
     length_cm, width_cm, height_cm, weight_g, color, spec, quantity, manual_facts_json, ai_payload_json,
     created_by_person_id, updated_at)
    VALUES (?, ?, ?, '[]', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    templateId,
    variant.variant_title || variant.source_title || `asset variant ${variant.id}`,
    `AV-${variant.id}`,
    JSON.stringify(images),
    Number(variant.internal_price || 0),
    Number(variant.length_cm || 0),
    Number(variant.width_cm || 0),
    Number(variant.height_cm || 0),
    Number(variant.weight_g || 0),
    variant.color || "",
    variant.material_text || "",
    assetVariantQuantity(variant.quantity_text),
    JSON.stringify(manualFacts),
    JSON.stringify({ title: variant.variant_title, description: variant.description_text, videos }),
    personId(session)
  ]);
  return Number(result.insertId);
}

async function insertListingShopCopyFromPackage(connection, draftId, variant, images, videos = [], session) {
  const mappedImages = images.map((image, index) => ({
    url: assetMediaUrl(image),
    role: image.role || image.type || "",
    sort_order: Number(image.sort_order || image.sortOrder || index + 1)
  })).filter((image) => image.url);
  const mappedVideos = videos.map((video, index) => ({
    url: assetMediaUrl(video),
    role: "video",
    sort_order: Number(video.sort_order || index + 1)
  })).filter((video) => video.url);
  const validation = { blocked: false, level: "green", errors: [], warnings: [] };
  await connection.execute(`
    INSERT INTO listing_shop_copies
    (draft_id, shop_id, offer_id, title, price, stock_quantity, watermark_path, images_json, validation_json,
     status, created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'prepared', ?, CURRENT_TIMESTAMP)
  `, [
    draftId,
    Number(variant.shop_id),
    `AV-${variant.id}-${Date.now().toString(36)}`,
    variant.variant_title || variant.source_title || "",
    Number(variant.ozon_price || variant.internal_price || 0),
    variant.watermark_path || "",
    JSON.stringify([...mappedImages, ...mappedVideos]),
    JSON.stringify(validation),
    personId(session)
  ]);
}

async function updateAssetVariantPublishState({ variantId = 0, draftId = 0, shopId = 0, status = "", publishResult = null } = {}) {
  const normalizedStatus = String(status || "").slice(0, 32);
  if (draftId && shopId) {
    await mysqlExecute(`
      UPDATE listing_shop_copies
      SET status = ?, publish_response_json = ?,
          published_at = CASE WHEN ? IN ('imported', 'published', 'success') THEN CURRENT_TIMESTAMP ELSE published_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ? AND shop_id = ?
    `, [
      normalizedStatus,
      publishResult ? JSON.stringify(publishResult) : null,
      normalizedStatus,
      Number(draftId),
      Number(shopId)
    ]);
  }
  if (variantId) {
    await mysqlExecute("UPDATE asset_variants SET status = ? WHERE id = ?", [normalizedStatus || "generated", Number(variantId)]);
  }
}

function statusFromOzonPublishResult(result = {}) {
  const info = result.import_info || result.importInfo || {};
  const raw = JSON.stringify(info || result || {}).toLowerCase();
  if (raw.includes("fail") || raw.includes("error") || raw.includes("rejected")) return "failed";
  if (raw.includes("import") || raw.includes("success") || raw.includes("done")) return "imported";
  if (raw.includes("pending") || raw.includes("process") || raw.includes("moderation")) return "processing";
  return result.task_id || result.taskId ? "submitted" : "published";
}

function firstOzonProductId(source = {}) {
  const text = JSON.stringify(source || {});
  const productIdMatch = text.match(/"product_id"\s*:\s*"?(\d+)/i) || text.match(/"ozon_product_id"\s*:\s*"?(\d+)/i);
  return productIdMatch?.[1] || "";
}

async function markSourceProductsListed(variantIds = []) {
  const ids = uniqueNumbers(variantIds);
  if (!ids.length) return;
  const rows = await mysqlQuery(`
    SELECT DISTINCT source_product_id
    FROM asset_variants
    WHERE id IN (${ids.map(() => "?").join(",")})
      AND source_product_id IS NOT NULL
      AND source_product_id > 0
  `, ids);
  const productIds = uniqueNumbers(rows.map((row) => row.source_product_id));
  if (!productIds.length) return;
  await mysqlExecute(`
    UPDATE products
    SET selection_status = 'listed', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${productIds.map(() => "?").join(",")})
  `, productIds).catch(() => null);
}

function normalizeProductImageList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item?.url || item || "").trim()).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = parseJson(text, null);
  if (Array.isArray(parsed)) return parsed.map((item) => String(item?.url || item || "").trim()).filter(Boolean);
  return text.split(/[\\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

async function ensureAssetVariantListingTemplate(connection, variant, session) {
  const ozonCategoryId = cleanText(variant.ozon_category_id || "", 128) || "asset-variant";
  const ozonCategoryName = cleanText(variant.ozon_category_name || "", 500) || "Auto accessories";
  const descriptionCategoryId = Number(variant.ozon_description_category_id || 0) || 0;
  const typeId = Number(variant.ozon_type_id || 0) || 0;
  const name = ozonCategoryId === "asset-variant" ? "Asset variant category" : `Asset variant category ${ozonCategoryName || ozonCategoryId}`;
  const [rows] = await connection.execute(`
    SELECT id
    FROM listing_category_templates
    WHERE source_type = 'asset_variant_engine' AND template_name = ? AND ozon_category_id = ? AND status <> 'deleted'
    ORDER BY id ASC
    LIMIT 1
  `, [name, ozonCategoryId]);
  if (rows[0]?.id) return Number(rows[0].id);
  const editablePayload = {
    title: variant.variant_title || variant.source_title || "",
    description: variant.description_text || "",
    ozon_category_id: ozonCategoryId,
    description_category_id: descriptionCategoryId || "",
    type_id: typeId || "",
    price: Number(variant.internal_price || 0),
    old_price: Number(variant.ozon_old_price || 0),
    images: [],
    attributes: [
      { name: "Source", value: "asset-variant-engine", required: false },
      { name: "Title style", value: variant.title_style || "", required: false },
      { name: "Tags", value: parseJson(variant.tags_json, []).join(" "), required: false }
    ]
  };
  const [result] = await connection.execute(`
    INSERT INTO listing_category_templates
    (ozon_category_id, category_name, template_name, required_attributes_json, ai_rules_json, title_prompt,
     description_prompt, image_rules_json, source_type, source_raw_json, editable_payload_json, title, description,
     attributes_json, images_json, created_by_person_id, updated_at)
    VALUES (?, ?, ?, '[]', '{}', '', '', '{}', 'asset_variant_engine', ?, ?, ?, ?, ?, '[]', ?, CURRENT_TIMESTAMP)
  `, [
    ozonCategoryId,
    ozonCategoryName,
    name,
    JSON.stringify({
      asset_variant_id: variant.id,
      batch_id: variant.batch_id,
      ozon_category_id: ozonCategoryId,
      description_category_id: descriptionCategoryId || "",
      type_id: typeId || "",
      category_name: ozonCategoryName
    }),
    JSON.stringify(editablePayload),
    editablePayload.title,
    editablePayload.description,
    JSON.stringify(editablePayload.attributes),
    personId(session)
  ]);
  return Number(result.insertId);
}

async function insertListingDraft(connection, templateId, variant, images, session) {
  const manualFacts = {
    source: "asset-variant-engine",
    asset_variant_id: Number(variant.id),
    batch_id: variant.batch_id,
    title_style: variant.title_style,
    tag_style: variant.tag_style,
    price_index: Number(variant.price_index || 1),
    internal_price: Number(variant.internal_price || 0),
    ozon_price: Number(variant.ozon_price || 0),
    ozon_old_price: Number(variant.ozon_old_price || 0),
    tags: parseJson(variant.tags_json, []),
    ozon_category_id: variant.ozon_category_id || "",
    description_category_id: Number(variant.ozon_description_category_id || 0) || "",
    type_id: Number(variant.ozon_type_id || 0) || "",
    category_name: variant.ozon_category_name || "",
    shop_id: Number(variant.shop_id),
    shop_name: variant.shop_name || ""
  };
  const [result] = await connection.execute(`
    INSERT INTO listing_drafts
    (template_id, product_name, internal_code, source_urls_json, source_images_json, cost_price, sale_price,
     length_cm, width_cm, height_cm, weight_g, color, spec, quantity, manual_facts_json, ai_payload_json,
     created_by_person_id, updated_at)
    VALUES (?, ?, ?, '[]', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    templateId,
    variant.variant_title || variant.source_title || `缂備浇浜慨闈涱焽濡ゅ啯鍟戦柛灞捐壘缂?${variant.id}`,
    `AV-${variant.id}`,
    JSON.stringify(images),
    Number(variant.internal_price || 0),
    Number(variant.length_cm || 0),
    Number(variant.width_cm || 0),
    Number(variant.height_cm || 0),
    Number(variant.weight_g || 0),
    variant.color || "",
    variant.material_text || "",
    Number(String(variant.quantity_text || "").match(/\d+/)?.[0] || 1),
    JSON.stringify(manualFacts),
    JSON.stringify({ title: variant.variant_title, description: variant.description_text }),
    personId(session)
  ]);
  return Number(result.insertId);
}

async function insertListingShopCopy(connection, draftId, variant, images, session) {
  const mappedImages = images.map((url, index) => ({ url, sort_order: index + 1 }));
  const validation = { blocked: false, level: "green", errors: [], warnings: [] };
  await connection.execute(`
    INSERT INTO listing_shop_copies
    (draft_id, shop_id, offer_id, title, price, stock_quantity, watermark_path, images_json, validation_json,
     status, created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'prepared', ?, CURRENT_TIMESTAMP)
  `, [
    draftId,
    Number(variant.shop_id),
    `AV-${variant.id}-${Date.now().toString(36)}`,
    variant.variant_title || variant.source_title || "",
    Number(variant.ozon_price || variant.internal_price || 0),
    variant.watermark_path || "",
    JSON.stringify(mappedImages),
    JSON.stringify(validation),
    personId(session)
  ]);
}

function normalizeMaterialPayload(raw = {}) {
  return {
    title: cleanText(raw.title, 500),
    ownerName: cleanText(raw.ownerName || raw.owner_name || "", 128),
    tags: normalizeTags(raw.tags),
    description: String(raw.description || "").trim(),
    sourceProductId: Number(raw.sourceProductId || raw.source_product_id || 0) || null,
    ozonCategoryId: cleanText(raw.ozonCategoryId || raw.ozon_category_id || "", 128),
    ozonDescriptionCategoryId: Number(raw.ozonDescriptionCategoryId || raw.ozon_description_category_id || 0) || 0,
    ozonTypeId: Number(raw.ozonTypeId || raw.ozon_type_id || 0) || 0,
    ozonCategoryName: cleanText(raw.ozonCategoryName || raw.ozon_category_name || "", 500),
    vehicleBrand: cleanText(raw.vehicleBrand || raw.vehicle_brand || raw.carBrand || raw.car_brand || "", 128),
    vehicleModel: cleanText(raw.vehicleModel || raw.vehicle_model || raw.carModel || raw.car_model || "", 128),
    basePriceRmb: numberValue(raw.basePriceRmb || raw.base_price_rmb || raw.salePriceRmb || raw.sale_price_rmb || raw.airSalePriceRmb || raw.air_sale_price_rmb),
    quantity: cleanText(raw.quantity || raw.quantityText || raw.quantity_text || "", 64),
    color: cleanText(raw.color || "", 128),
    material: cleanText(raw.material || raw.materialText || raw.material_text || "", 128),
    lengthCm: numberValue(raw.lengthCm || raw.length_cm),
    widthCm: numberValue(raw.widthCm || raw.width_cm),
    heightCm: numberValue(raw.heightCm || raw.height_cm),
    weightG: numberValue(raw.weightG || raw.weight_g),
    mainImage: String(raw.mainImage || raw.main_image || "").trim(),
    detailImages: (Array.isArray(raw.detailImages) ? raw.detailImages : []).map((item) => String(item || "").trim()).filter(Boolean)
  };
}

function normalizeTags(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,;#]+/);
  return uniqueValues(source
    .map((item) => String(item?.value || item || "").trim())
    .filter(Boolean)
    .map((item) => item.startsWith("#") ? item : `#${item}`)
  ).slice(0, 20);
}

async function mapWithConcurrency(items = [], concurrency = 2, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(Number(concurrency || 1), list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await worker(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, runWorker));
  return results;
}

function createConcurrencyLimiter(concurrency = 1) {
  const limit = Math.max(1, Number(concurrency || 1));
  const queue = [];
  let active = 0;

  const runNext = () => {
    if (active >= limit || !queue.length) return;
    const item = queue.shift();
    active += 1;
    Promise.resolve()
      .then(item.worker)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return (worker) => new Promise((resolve, reject) => {
    queue.push({ worker, resolve, reject });
    runNext();
  });
}

function hasReplacementMarks(value = "") {
  const text = String(value || "");
  return text.includes("\uFFFD") || /\?{3,}/.test(text);
}

function containsCjk(value = "") {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function isValidRichContentJson(value = "") {
  if (typeof value === "object" && value) return true;
  const text = String(value || "").trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed && typeof parsed === "object");
  } catch {
    return false;
  }
}

async function fileSha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function stableHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function writeText(filePath, content = "") {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, String(content ?? ""), "utf8");
}

function sanitizeFilename(value = "") {
  return String(value || "asset")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "asset";
}

function normalizeShopRuleRow(row, index = 0) {
  return {
    id: Number(row.id),
    name: row.name,
    status: row.status,
    legalEntity: row.legal_entity || "",
    watermark_path: normalizeUrl(row.watermark_path || ""),
    watermarkPath: normalizeUrl(row.watermark_path || ""),
    watermark_position: row.watermark_position || "bottom-right",
    watermark_x_percent: Number(row.watermark_x_percent ?? 75),
    watermark_y_percent: Number(row.watermark_y_percent ?? 75),
    watermark_scale_percent: Number(row.watermark_scale_percent ?? 22),
    watermark_opacity_percent: Number(row.watermark_opacity_percent ?? 82),
    rule: normalizeRule({
      titleStyle: row.title_style || defaultTitleStyle(index),
      tagStyle: row.tag_style,
      priceIndex: row.price_index,
      priceRole: row.price_role,
      watermarkTemplateId: row.watermark_template_id || (row.watermark_path ? `shop-${row.id}` : ""),
      tailImageUrl: row.tail_image_url,
      tailCategory: row.tail_category,
      vehicleModel: row.vehicle_model,
      tailTemplateId: row.tail_template_id,
      mainImagePlan: row.main_image_plan,
      updated_at: row.rule_updated_at || ""
    })
  };
}

function normalizeRule(rule = {}) {
  const titleStyle = normalizeTitleStyle(rule.titleStyle || rule.title_style);
  return {
    titleStyle,
    tagStyle: normalizeTagStyle(rule.tagStyle || rule.tag_style || titleStyle),
    priceIndex: normalizePriceIndex(rule.priceIndex || rule.price_index),
    priceRole: normalizePriceRole(rule.priceRole || rule.price_role),
    watermarkTemplateId: String(rule.watermarkTemplateId || rule.watermark_template_id || ""),
    tailImageUrl: String(rule.tailImageUrl || rule.tail_image_url || ""),
    tailCategory: cleanText(rule.tailCategory || rule.tail_category || DEFAULT_TAIL_CATEGORY, 128),
    vehicleModel: cleanText(rule.vehicleModel || rule.vehicle_model || DEFAULT_TAIL_MODEL, 128),
    tailTemplateId: Number(rule.tailTemplateId || rule.tail_template_id || 0) || null,
    mainImagePlan: String(rule.mainImagePlan || rule.main_image_plan || "watermarked"),
    updated_at: rule.updated_at || rule.updatedAt || ""
  };
}

function normalizeSecond(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  return String(value).replace("T", " ").replace("Z", "").slice(0, 19);
}

function normalizeTailTemplate(row = {}) {
  const imagePath = String(row.image_path || row.imagePath || "").trim();
  return {
    id: Number(row.id || 0),
    shopId: Number(row.shop_id || row.shopId || 0) || null,
    shopName: row.shop_name || row.shopName || "",
    category: cleanText(row.category || DEFAULT_TAIL_CATEGORY, 128),
    vehicleModel: cleanText(row.vehicle_model || row.vehicleModel || DEFAULT_TAIL_MODEL, 128),
    name: cleanText(row.name || "闁诲繐绻戦崕鍐裁瑰Ο浣曠喖鍩勯崘鈺冨嚒", 255),
    imagePath,
    imageUrl: imagePath ? normalizeUrl(imagePath) : "",
    purpose: row.purpose || "anti_hijack",
    isDefault: Boolean(row.is_default ?? row.isDefault),
    sortOrder: Number(row.sort_order || row.sortOrder || 0),
    status: row.status || "active"
  };
}

function resolveTailTemplate(rule, shop, templates, templateMap) {
  if (rule.tailTemplateId && templateMap.has(Number(rule.tailTemplateId))) {
    return templateMap.get(Number(rule.tailTemplateId));
  }
  const scoped = templates.filter((template) => {
    const shopMatch = !template.shopId || Number(template.shopId) === Number(shop.id);
    const categoryMatch = !rule.tailCategory || template.category === rule.tailCategory;
    const modelMatch = !rule.vehicleModel || template.vehicleModel === rule.vehicleModel;
    return shopMatch && categoryMatch && modelMatch;
  });
  return scoped.find((template) => template.isDefault) || scoped[0] || templates.find((template) => template.isDefault) || null;
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function flattenOzonCategoryTree(tree) {
  const roots = Array.isArray(tree) ? tree : Array.isArray(tree?.result) ? tree.result : Array.isArray(tree?.items) ? tree.items : [];
  const rows = [];
  const walk = (node, parents = []) => {
    if (!node || typeof node !== "object") return;
    const descriptionCategoryId = Number(
      node.description_category_id
      || node.descriptionCategoryId
      || node.category_id
      || parents.at(-1)?.descriptionCategoryId
      || 0
    );
    const typeId = Number(node.type_id || node.typeId || 0);
    const nameRu = cleanText(node.category_name || node.name || node.type_name || node.title || "", 500);
    const pathRuParts = [...parents.map((item) => item.nameRu).filter(Boolean), nameRu].filter(Boolean);
    const pathRu = pathRuParts.join(" / ");
    const pathZh = translateCategoryPath(pathRuParts).join(" / ");
    rows.push({
      descriptionCategoryId,
      typeId,
      nameRu,
      nameZh: translateCategoryName(nameRu),
      pathRu,
      pathZh,
      parentDescriptionCategoryId: Number(parents.at(-1)?.descriptionCategoryId || 0),
      isAuto: isAutoCategory(`${pathRu} ${pathZh}`),
      raw: node
    });
    const children = node.children || node.childs || node.categories || node.types || [];
    for (const child of Array.isArray(children) ? children : []) {
      walk(child, [...parents, { nameRu, descriptionCategoryId }]);
    }
  };
  for (const root of roots) walk(root);
  return rows.filter((row) => row.nameRu || row.pathRu);
}

function translateCategoryPath(parts) {
  return parts.map(translateCategoryName);
}

function translateCategoryName(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  const found = CATEGORY_ZH_HINTS.find(([ru]) => text.toLowerCase().includes(ru.toLowerCase()));
  return found ? found[1] : text;
}

function isAutoCategory(value) {
  const text = String(value || "").toLowerCase();
  return AUTO_CATEGORY_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

function normalizeTitleStyle(value) {
  const style = String(value || "traffic").trim();
  const legacyMap = {
    functional: "traffic",
    gift: "value"
  };
  const normalized = legacyMap[style] || style;
  return TITLE_STYLES.includes(normalized) ? normalized : "traffic";
}

function normalizeTagStyle(value) {
  const style = String(value || "traffic").trim();
  return TAG_STYLES.includes(style) ? style : "traffic";
}

function normalizePriceIndex(value) {
  const parsed = Number(value || 1);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(Math.max(parsed, 0.1), 9.9999);
}

function normalizePriceRole(value) {
  const role = String(value || "").trim();
  return ["owner", "main", "new", "other_owner", "lift"].includes(role) ? role : "";
}

function priceIndexForRole(role) {
  if (role === "owner" || role === "main") return 1;
  if (role === "new") return 0.95;
  if (role === "other_owner") return 1.05;
  if (role === "lift") return 5;
  return null;
}

function resolveShopPriceIndex(value, material = {}, shop = {}) {
  const explicitRoleIndex = priceIndexForRole(shop.rule?.priceRole || shop.rule?.price_role);
  if (explicitRoleIndex !== null) return explicitRoleIndex;
  const ownerName = String(material.publisherName || material.publisher_name || material.ownerName || material.owner_name || "").trim();
  const legalEntity = String(shop.legalEntity || shop.legal_entity || "").trim();
  const shopText = `${shop.name || ""} ${legalEntity}`.toLowerCase();
  const defaultIndex = ownerName && legalEntity && ownerName === legalEntity
    ? 1
    : /ruvibe\s*mart/i.test(String(shop.name || "").trim())
      ? 1
      : /(^|\s)(new|fresh)(\s|$)|新店|全新/.test(shopText)
        ? 0.95
        : 1.05;
  const parsed = normalizePriceIndex(value);
  if (Math.abs(parsed - 1) < 0.0001 && Math.abs(defaultIndex - 1) > 0.0001) return defaultIndex;
  return parsed;
}

async function personNameForSession(session = null) {
  const id = personId(session);
  if (!id) return "";
  const row = await mysqlQuery("SELECT name FROM people WHERE id = ? LIMIT 1", [id]).then((rows) => rows[0]).catch(() => null);
  return String(row?.name || "").trim();
}

function roundMoney(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function defaultTitleStyle(index = 0) {
  return TITLE_STYLES[Math.abs(Number(index || 0)) % TITLE_STYLES.length];
}

function normalizeWatermarkTemplate(row) {
  return {
    id: String(row.id),
    name: row.name,
    logo_url: normalizeUrl(row.logo_url || row.logo_path || ""),
    logoUrl: normalizeUrl(row.logo_url || row.logo_path || ""),
    logoPath: resolveLocalAssetPath(row.logo_path || row.logo_url || ""),
    position: row.position || "bottom-right",
    x_percent: Number(row.x_percent ?? 75),
    xPercent: Number(row.x_percent ?? 75),
    y_percent: Number(row.y_percent ?? 75),
    yPercent: Number(row.y_percent ?? 75),
    opacity: Number(row.opacity ?? 0.82),
    size_percent: Number(row.size_percent || 22),
    sizePercent: Number(row.size_percent || 22),
    margin_px: Number(row.margin_px || 24),
    margin: Number(row.margin_px || 24),
    status: row.status || "active"
  };
}

function defaultShopWatermark(shop) {
  return normalizeWatermarkTemplate({
    id: `shop-${shop.id}`,
    name: shop.name,
    logo_url: shop.watermark_path || shop.watermarkPath || "",
    position: shop.watermark_position || "bottom-right",
    x_percent: Number(shop.watermark_x_percent ?? 75),
    y_percent: Number(shop.watermark_y_percent ?? 75),
    opacity: Number(shop.watermark_opacity_percent ?? 82) / 100,
    size_percent: Number(shop.watermark_scale_percent ?? 22),
    margin_px: 24,
    status: "active"
  });
}

async function readImageBuffer(source) {
  const text = String(source || "").trim();
  if (!text) throw new Error("Missing text");
  const dataUrlMatch = text.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (dataUrlMatch) return Buffer.from(dataUrlMatch[1], "base64");
  const productImageMatch = text.match(/^\/?api\/products\/(\d+)\/image$/i);
  if (productImageMatch) {
    const rows = await mysqlQuery("SELECT image_url FROM products WHERE id = ? LIMIT 1", [Number(productImageMatch[1])]);
    const storedImage = String(rows[0]?.image_url || "").trim();
    if (storedImage && storedImage !== text) return readImageBuffer(storedImage);
  }
  if (/^\/?api\//i.test(text)) {
    return fetchImageBuffer(new URL(text.replace(/^\/?/, "/"), config.appBaseUrl).toString());
  }
  if (/^https?:\/\//i.test(text)) {
    const response = await fetch(text);
    if (!response.ok) throw new Error(`闂佹悶鍎辨晶鑺ユ櫠閺嶃劎鈻旈悗锝庡幗缁佹澘顭块幆鎵翱閻熸瑱绠撻弫?{response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFile(resolveLocalAssetPath(text));
}

async function fetchImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`闂佹悶鍎辨晶鑺ユ櫠閺嶃劎鈻旈悗锝庡幗缁佹澘顭块幆鎵翱閻熸瑱绠撻弫?{response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function imageResult(filePath, type, sortOrder = 1, context = {}) {
  const relative = path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
  const parts = relative.split("/");
  const batchId = parts[2];
  const fileName = parts.slice(3).join("/");
  const asset = await registerListingMediaAssetFromFile({
    filePath,
    source_module: "asset_variant",
    source_id: `${context.batchId || batchId}:${context.shopId || ""}:${type}:${sortOrder}`,
    batch_id: context.batchId || batchId || "",
    shop_id: context.shopId || null,
    media_type: "image",
    role: type,
    sort_order: sortOrder,
    metadata: {
      sourceOutputPath: relative,
      assetVariantBatchId: context.batchId || batchId || "",
      productTitle: context.sourceTitle || "",
      variantTitle: context.variantTitle || ""
    }
  });
  return {
    assetId: asset.id,
    type,
    sortOrder,
    outputPath: relative,
    previewUrl: fileUrl(batchId, fileName),
    publishUrl: asset.publishUrl || asset.publish_url || "",
    url: asset.publishUrl || asset.publish_url || fileUrl(batchId, fileName),
    localListingPath: asset.localPath || asset.local_path || "",
    listingPreviewUrl: asset.previewUrl || asset.preview_url || "",
    hash: asset.hash || asset.hash_sha256 || ""
  };
}

function fileUrl(batchId, filename) {
  return `/api/asset-variant-engine/files/${encodeURIComponent(batchId)}/${filename.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text) || /^data:/i.test(text)) return text;
  const normalized = text.replace(/\\/g, "/");
  if (normalized.startsWith("/api/") || normalized.startsWith("/uploads/")) return normalized;
  const uploadsIndex = normalized.toLowerCase().lastIndexOf("/uploads/");
  if (uploadsIndex >= 0) return normalized.slice(uploadsIndex);
  const publicUploadsIndex = normalized.toLowerCase().lastIndexOf("/public/uploads/");
  if (publicUploadsIndex >= 0) return normalized.slice(publicUploadsIndex + "/public".length);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function resolveLocalAssetPath(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  let normalized = text.replace(/\\/g, "/");
  if (/^https?:\/\//i.test(normalized)) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname || "");
    } catch {
      return text;
    }
  }
  const assetFileMatch = normalized.match(/^\/?api\/asset-variant-engine\/files\/([^/]+)\/(.+)$/i);
  if (assetFileMatch) {
    const batchId = decodeURIComponent(assetFileMatch[1]);
    const fileName = assetFileMatch[2].split("/").map((part) => decodeURIComponent(part)).join(path.sep);
    return path.resolve(VARIANT_ROOT, batchId, fileName);
  }
  const candidates = [];
  const withoutLeadingSlash = normalized.replace(/^\/+/, "");
  if (withoutLeadingSlash.startsWith("uploads/")) {
    candidates.push(path.resolve(ROOT_DIR, "public", withoutLeadingSlash));
    candidates.push(path.resolve(ROOT_DIR, withoutLeadingSlash));
  }
  if (withoutLeadingSlash.startsWith("shop-watermarks/")) {
    candidates.push(path.resolve(ROOT_DIR, "uploads", withoutLeadingSlash));
    candidates.push(path.resolve(ROOT_DIR, "public", "uploads", withoutLeadingSlash));
  }
  if (withoutLeadingSlash.startsWith("public/")) {
    candidates.push(path.resolve(ROOT_DIR, withoutLeadingSlash));
  }
  candidates.push(path.isAbsolute(normalized) ? normalized : path.resolve(ROOT_DIR, withoutLeadingSlash));
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || candidates[0] || text;
}

async function removeLocalAssetPath(value, { recursive = false } = {}) {
  const text = String(value || "").trim();
  if (!text) return false;
  const absolute = path.resolve(ROOT_DIR, text);
  const allowedRoots = [VARIANT_ROOT, LISTING_MEDIA_ROOT];
  const allowed = allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return absolute !== resolvedRoot && absolute.startsWith(`${resolvedRoot}${path.sep}`);
  });
  if (!allowed) return false;
  try {
    await fs.rm(absolute, { recursive, force: true });
    return true;
  } catch {
    return false;
  }
}

function mediaPublishValue(image = {}) {
  return image.publishUrl || image.publish_url || image.url || image.previewUrl || image.outputPath || "";
}


function buildListingWorkbook({ shop, title, titleZh, material, images, rule, tailTemplate }) {
  const mainImages = images.filter((image) => image.type === "main").map(mediaPublishValue);
  const detailImages = images.filter((image) => image.type === "detail").map(mediaPublishValue);
  const tailImages = images.filter((image) => image.type === "tail").map(mediaPublishValue);
  const detailHeaders = detailImages.map((_, index) => "Detail image " + (index + 1));
  const tailHeaders = tailImages.map((_, index) => "Tail image " + (index + 1));
  const rows = [
    ["Shop", "Category", "Vehicle model", "Title RU", "Title CN", "Tags", "Description", "Color", "Material", "Quantity", "Length cm", "Width cm", "Height cm", "Weight g", "Main images", ...detailHeaders, ...tailHeaders, "Tail template", "Image count"],
    [shop.name, rule?.tailCategory || "", rule?.vehicleModel || "", title, titleZh || "", material.tags.join(","), material.description, material.color || "", material.material || "", material.quantity || "", material.lengthCm || "", material.widthCm || "", material.heightCm || "", material.weightG || "", mainImages.join("\n"), ...detailImages, ...tailImages, tailTemplate?.name || "", String(images.length)]
  ];
  return createMinimalXlsx("listing", rows);
}
function buildProductInfo({ shop, title, titleZh, material, images, rule, tailTemplate }) {
  return {
    shop: { id: shop.id, name: shop.name },
    category: rule?.tailCategory || "",
    ozonCategory: {
      id: material.ozonCategoryId || "",
      descriptionCategoryId: material.ozonDescriptionCategoryId || 0,
      typeId: material.ozonTypeId || 0,
      name: material.ozonCategoryName || ""
    },
    vehicleBrand: material.vehicleBrand || "",
    vehicleModel: material.vehicleModel || rule?.vehicleModel || "",
    title,
    titleRu: title,
    titleZh: titleZh || "",
    tags: material.tags,
    description: material.description,
    sellingPoints: material.description,
    color: material.color || "",
    material: material.material || "",
    quantity: material.quantity || "",
    dimensions: {
      lengthCm: material.lengthCm || 0,
      widthCm: material.widthCm || 0,
      heightCm: material.heightCm || 0,
      weightG: material.weightG || 0
    },
    titleStyle: rule?.titleStyle || "",
    watermarkTemplateId: rule?.watermarkTemplateId || "",
    mainImagePlan: rule?.mainImagePlan || "",
    tailTemplate: tailTemplate ? {
      id: tailTemplate.id,
      name: tailTemplate.name,
      category: tailTemplate.category,
      vehicleModel: tailTemplate.vehicleModel
    } : null,
    images: {
      main: images.filter((image) => image.type === "main").map(mediaPublishValue),
      details: images.filter((image) => image.type === "detail").map(mediaPublishValue),
      tail: images.filter((image) => image.type === "tail").map(mediaPublishValue)
    }
  };
}


function buildProductInfoWorkbook(productInfo) {
  const rows = [
    ["Field", "Value"],
    ["Shop", productInfo.shop.name],
    ["Category", productInfo.category],
    ["Ozon category", productInfo.ozonCategory?.name || productInfo.ozonCategory?.id || ""],
    ["Vehicle model", productInfo.vehicleModel],
    ["Title RU", productInfo.titleRu || productInfo.title],
    ["Title ZH", productInfo.titleZh || ""],
    ["Tags", productInfo.tags.join(",")],
    ["Selling points", productInfo.sellingPoints || productInfo.description],
    ["Color", productInfo.color],
    ["Material", productInfo.material],
    ["Quantity", productInfo.quantity],
    ["Length", productInfo.dimensions.lengthCm || ""],
    ["Width", productInfo.dimensions.widthCm || ""],
    ["Height", productInfo.dimensions.heightCm || ""],
    ["Weight", productInfo.dimensions.weightG || ""],
    ["Main images", "images/main"],
    ["Detail images", "images/details"],
    ["Tail images", "images/tail"]
  ];
  return createMinimalXlsx("product-info", rows);
}

function buildListingJson({ shop, title, titleZh, material, images, rule, tailTemplate }) {
  return {
    shop: {
      id: shop.id,
      name: shop.name
    },
    category: rule?.tailCategory || "",
    ozonCategory: {
      id: material.ozonCategoryId || "",
      descriptionCategoryId: material.ozonDescriptionCategoryId || 0,
      typeId: material.ozonTypeId || 0,
      name: material.ozonCategoryName || ""
    },
    vehicleModel: rule?.vehicleModel || "",
    title,
    titleRu: title,
    titleZh: titleZh || "",
    tags: material.tags,
    description: material.description,
    sellingPoints: material.description,
    color: material.color || "",
    material: material.material || "",
    quantity: material.quantity || "",
    dimensions: {
      lengthCm: material.lengthCm || 0,
      widthCm: material.widthCm || 0,
      heightCm: material.heightCm || 0,
      weightG: material.weightG || 0
    },
    images: {
      main: images.filter((image) => image.type === "main").map(mediaPublishValue),
      details: images.filter((image) => image.type === "detail").map(mediaPublishValue),
      tail: images.filter((image) => image.type === "tail").map(mediaPublishValue)
    },
    tailTemplate: tailTemplate ? {
      id: tailTemplate.id,
      name: tailTemplate.name,
      category: tailTemplate.category,
      vehicleModel: tailTemplate.vehicleModel
    } : null
  };
}

function fallbackTitle(material, style, shop) {
  const productType = detectProductType(material.title, material.description);
  const carModel = extractLikelyCarModel(`${material.vehicleModel || ""} ${material.title || ""}`) || "";
  const materialPart = material.material ? russianFactValue(material.material, "material") : "";
  const colorValue = russianFactValue(material.color, "color");
  const quantityValue = russianFactValue(material.quantity, "quantity");
  const parts = [carModel, materialPart, colorValue, quantityValue].filter(Boolean).join(" ");
  const suffixByStyle = {
    traffic: "для автомобиля, точная посадка и защита на каждый день",
    material: "из прочного материала, аккуратная посадка и защита от износа",
    scenario: "для ежедневного использования, удобного хранения и аккуратной защиты",
    value: "практичный автоаксессуар для защиты и комфорта",
    premium: "аккуратный автоаксессуар со сдержанным дизайном"
  };
  const ru = cleanRussianTitle(`${productType}${parts ? ` ${parts}` : ""}, ${suffixByStyle[style] || suffixByStyle.traffic}`, 500);
  return { ru, zh: buildChineseTitleMeaning(ru, material) };
}
function buildChineseTitleMeaning(ruTitle, material = {}) {
  const productType = chineseProductType(material.title, material.description);
  const model = extractLikelyCarModel(String(material.vehicleModel || "") + " " + String(material.title || "")) || "";
  const materialText = chineseFactValue(material.material, "material");
  const colorText = chineseFactValue(material.color, "color");
  const quantityText = chineseFactValue(material.quantity, "quantity");
  const parts = [model, materialText, colorText, quantityText].filter(Boolean).join(" / ");
  return cleanText(productType + (parts ? " - " + parts : ""), 500);
}

function chineseProductType(title, description) {
  const text = String((title || "") + " " + (description || "")).toLowerCase();
  if (text.includes("key") || text.includes("钥匙") || text.includes("брелок")) return "汽车钥匙保护壳";
  if (text.includes("安全带") || text.includes("seat belt") || text.includes("ремень")) return "安全带护肩套";
  if (text.includes("light") || text.includes("led") || text.includes("灯")) return "汽车灯饰";
  if (text.includes("film") || text.includes("膜")) return "汽车保护膜";
  return "汽车用品";
}

function chineseFactValue(value, type = "") {
  const text = cleanText(value, 120);
  if (!text) return "";
  const lower = text.toLowerCase();
  if (type === "color") {
    if (lower.includes("black") || lower.includes("черн") || text.includes("黑")) return "黑色";
    if (lower.includes("silver") || lower.includes("серебр") || text.includes("银")) return "银色";
    if (lower.includes("white") || lower.includes("бел") || text.includes("白")) return "白色";
  }
  if (type === "quantity") {
    const count = String(text).match(/\d+/)?.[0];
    return count ? count + "件" : text;
  }
  return text;
}

function generateShopTags(material, shop, rule = {}, title = "") {
  const model = extractLikelyCarModel(String(material.vehicleModel || "") + " " + String(material.title || "") + " " + String(title || "")) || "auto key";
  const materialText = russianTagWord(material.material || "tpu");
  const colorText = russianTagWord(material.color || "black");
  const shopTag = tagToken(shop.name || shop.legalEntity || "shop");
  const modelSafe = model.toLowerCase();
  const base = [shopTag, modelSafe, modelSafe + " key", modelSafe + " cover", "auto accessories", "key cover", "car key case", "key protection", "scratch protection", "driver gift", materialText, materialText + " cover", colorText, colorText + " cover", "daily use", "precise fit", "soft cover", "button access", "car accessory", "protective case"];
  return uniqueValues(base.map(tagToken)).slice(0, 20);
}

function extractLikelyCarModel(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  const seeded = REAL_RUSSIA_VEHICLE_MODELS
    .map((item) => [item.labelRu, item.labelZh, `${item.brand} ${item.model}`, item.model, ...(item.aliases || [])])
    .flat()
    .filter(Boolean)
    .sort((a, b) => String(b).length - String(a).length)
    .find((candidate) => lower.includes(String(candidate).toLowerCase()));
  if (seeded) return seeded;
  const brandModel = text.match(/\b([A-Za-z][A-Za-z-]{1,20})\s+([A-Za-z]?\d{1,3}[A-Za-z]?|[A-Za-z]{1,4}-?\d{1,3})\b/);
  if (brandModel) return `${brandModel[1]} ${brandModel[2]}`;
  const modelOnly = text.match(/\b(TENET|Belgee|Haval|Chery|Geely|Changan|Omoda|Jaecoo|Exeed)\b[^\w]{0,6}([A-Za-z]?\d{1,3}[A-Za-z]?|[A-Za-z]{1,4}-?\d{1,3})/i);
  return modelOnly ? `${modelOnly[1]} ${modelOnly[2]}` : "";
}

function tagToken(value) {
  const text = String(value || "").toLowerCase().replace(/ruvibe\s*mart/gi, "ruvibemart").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  return text ? "#" + text : "";
}

function russianTagWord(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("tpu")) return "tpu";
  if (text.includes("abs")) return "abs";
  if (text.includes("leather") || text.includes("кожа") || text.includes("皮")) return "кожа";
  if (text.includes("metal") || text.includes("металл") || text.includes("钢")) return "металл";
  if (text.includes("black") || text.includes("черн") || text.includes("黑")) return "черный";
  if (text.includes("silver") || text.includes("серебр") || text.includes("银")) return "серебристый";
  if (text.includes("white") || text.includes("бел") || text.includes("白")) return "белый";
  return text && !looksBrokenGeneratedText(text) && !hasCjkText(text) ? text : "автоаксессуар";
}

function detectProductType(title, description) {
  const text = String((title || '') + ' ' + (description || '')).toLowerCase();
  if (text.includes("安全带") || text.includes("seat belt") || text.includes("ремень")) return "Накладка на ремень безопасности";
  if (text.includes('key') || text.includes('钥匙') || text.includes('брелок')) return 'Чехол для автомобильного ключа';
  if (text.includes('light') || text.includes('led') || text.includes('灯') || text.includes('подсвет')) return 'Автомобильная подсветка';
  if (text.includes('film') || text.includes('膜') || text.includes('пленк')) return 'Защитная пленка для автомобиля';
  return 'Автомобильный аксессуар';
}

function russianFactValue(value, type = "") {
  let text = cleanText(value, 120);
  if (!text) return "";
  if (type === "color") return russianColorText(text);
  if (type === "quantity") {
    const number = text.match(/\d+/)?.[0];
    return number ? number + " шт." : hasCjkText(text) ? "" : text;
  }
  if (type === "material") return russianMaterialText(text);
  return hasCjkText(text) ? "" : text;
}

function looksLikeTitleStyleNote(value) {
  return /title style|style note/i.test(String(value || ""));
}

function normalizeTitleCandidateObject(value, material, shop) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(TITLE_STYLES.map((style) => [
    style,
    normalizeTitlePair(source[style] || source[TITLE_STYLE_LABELS[style]], material, style, shop)
  ]));
}

function normalizeTitlePair(value, material, style, shop) {
  const fallback = fallbackTitle(material, style, shop);
  if (value && typeof value === "object") {
    const ru = cleanText(value.ru || value.russian || value.titleRu || "", 500);
    const zh = cleanText(value.zh || value.cn || value.titleZh || "", 500);
    return {
      ru: isInvalidRussianTitle(ru) ? fallback.ru : ru || fallback.ru,
      zh: looksBrokenGeneratedText(zh) || looksLikeTitleStyleNote(zh) ? fallback.zh : zh || fallback.zh
    };
  }
  if (value) {
    const ru = cleanText(value, 500);
    return { ru: isInvalidRussianTitle(ru) ? fallback.ru : ru, zh: fallback.zh };
  }
  return fallback;
}

function isInvalidRussianTitle(value) {
  const text = String(value || "");
  return !text || looksBrokenGeneratedText(text) || hasCjkText(text);
}

function hasCjkText(value) {
  return /[\u3400-\u9fff\u3040-\u30ff]/.test(String(value || ""));
}
function looksBrokenGeneratedText(value) {
  const text = String(value || "");
  if (!text) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks >= 4 && questionMarks / Math.max(1, text.length) > 0.12) return true;
  return /闂|閻|婵|缂|濞|鈧/.test(text);
}
function cleanText(value, max = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanRussianTitle(value, max = 500) {
  let text = cleanText(value, max)
    .replace(/\?{2,}/g, " ")
    .replace(/[^\p{L}\p{N}\s,.\-+]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
  if (!text || looksBrokenGeneratedText(text) || hasCjkText(text)) {
    text = "Автомобильный аксессуар для защиты и ежедневного использования";
  }
  return text.slice(0, max);
}

function personId(session) {
  return Number(session?.personId || 0) || null;
}

function uniqueNumbers(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number).filter(Boolean))];
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createMinimalXlsx(sheetName, rows) {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    "xl/worksheets/sheet1.xml": worksheetXml(rows)
  };
  return zipStore(files);
}

function worksheetXml(rows) {
  const xmlRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex + 1)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${xmlRows}</sheetData>
</worksheet>`;
}

function columnName(index) {
  let name = "";
  let value = index;
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function escapeXml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  }[char]));
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { fetchOzonDescriptionCategoryTree } from "../ozonClient.js";
import { chatWithAiProvider } from "./ai-provider-settings.js";
import { ensureListingAutomationSchema, registerListingMediaAssetFromFile } from "./listing-automation.js";

const ROOT_DIR = process.cwd();
const VARIANT_ROOT = path.resolve(ROOT_DIR, "uploads", "shop-variants");
const TAIL_TEMPLATE_ROOT = path.resolve(ROOT_DIR, "uploads", "asset-tail-templates");
const LISTING_MEDIA_ROOT = path.resolve(ROOT_DIR, "public", "uploads", "listing-media");
const ASSET_VARIANT_CONCURRENCY = 4;
const TITLE_STYLES = ["traffic", "material", "scenario", "value", "premium"];
const TAG_STYLES = ["traffic", "vehicle", "material", "compact"];
const TAG_STYLE_LABELS = {
  traffic: "流量词型",
  vehicle: "精准车型型",
  material: "材质卖点型",
  compact: "简洁防跟卖型"
};
const TITLE_STYLE_LABELS = {
  traffic: "搜索流量型",
  material: "材质卖点型",
  scenario: "场景适配型",
  value: "性价比型",
  premium: "高端质感型"
};
const MAIN_IMAGE_PLANS = [
  { value: "original", label: "保留原始主图" },
  { value: "watermarked", label: "主图加店铺水印" }
];
const DEFAULT_TAIL_CATEGORY = "通用汽车用品";
const DEFAULT_TAIL_MODEL = "通用车型";
const AUTO_CATEGORY_KEYWORDS = [
  "авто", "автомоб", "машин", "транспорт", "запчаст", "аксессуар", "ключ", "брелок",
  "汽车", "车", "汽配", "汽车用品", "钥匙", "配件"
];
const CATEGORY_ZH_HINTS = [
  ["Автотовары", "汽车用品"],
  ["Автоаксессуары", "汽车配件"],
  ["Автомобильные аксессуары", "汽车配件"],
  ["Запчасти", "汽车零配件"],
  ["Чехлы", "保护套"],
  ["Ключ", "钥匙"],
  ["Брелок", "钥匙扣"],
  ["Коврики", "脚垫"],
  ["Накладки", "装饰/保护贴"],
  ["Пороги", "门槛条"]
];
const REAL_RUSSIA_VEHICLE_MODELS = [
  vehicleSeed("Haval", "Хавейл", "Jolion", "Джолион", "哈弗 Jolion", "Haval Jolion", 2021, null, 1),
  vehicleSeed("Haval", "Хавейл", "F7", "F7", "哈弗 F7", "Haval F7", 2019, null, 2),
  vehicleSeed("Haval", "Хавейл", "M6", "M6", "哈弗 M6", "Haval M6", 2023, null, 3),
  vehicleSeed("Haval", "Хавейл", "Dargo", "Дарго", "哈弗 Dargo", "Haval Dargo", 2022, null, 4),
  vehicleSeed("Chery", "Чери", "Tiggo 4 Pro", "Тигго 4 Про", "奇瑞 Tiggo 4 Pro", "Chery Tiggo 4 Pro", 2022, null, 5),
  vehicleSeed("Chery", "Чери", "Tiggo 7 Pro Max", "Тигго 7 Про Макс", "奇瑞 Tiggo 7 Pro Max", "Chery Tiggo 7 Pro Max", 2022, null, 6),
  vehicleSeed("Chery", "Чери", "Tiggo 8 Pro Max", "Тигго 8 Про Макс", "奇瑞 Tiggo 8 Pro Max", "Chery Tiggo 8 Pro Max", 2022, null, 7),
  vehicleSeed("Chery", "Чери", "Arrizo 8", "Арризо 8", "奇瑞 Arrizo 8", "Chery Arrizo 8", 2023, null, 8),
  vehicleSeed("Geely", "Джили", "Coolray", "Кулрей", "吉利 Coolray", "Geely Coolray", 2020, null, 9),
  vehicleSeed("Geely", "Джили", "Monjaro", "Монжаро", "吉利 Monjaro", "Geely Monjaro", 2023, null, 10),
  vehicleSeed("Geely", "Джили", "Atlas Pro", "Атлас Про", "吉利 Atlas Pro", "Geely Atlas Pro", 2021, null, 11),
  vehicleSeed("Geely", "Джили", "Tugella", "Тугелла", "吉利 Tugella", "Geely Tugella", 2020, null, 12),
  vehicleSeed("Changan", "Чанган", "CS35 Plus", "CS35 Plus", "长安 CS35 Plus", "Changan CS35 Plus", 2019, null, 13),
  vehicleSeed("Changan", "Чанган", "CS55 Plus", "CS55 Plus", "长安 CS55 Plus", "Changan CS55 Plus", 2022, null, 14),
  vehicleSeed("Changan", "Чанган", "CS75 Plus", "CS75 Plus", "长安 CS75 Plus", "Changan CS75 Plus", 2022, null, 15),
  vehicleSeed("Changan", "Чанган", "UNI-K", "UNI-K", "长安 UNI-K", "Changan UNI-K", 2022, null, 16),
  vehicleSeed("Omoda", "Омода", "C5", "C5", "欧萌达 Omoda C5", "Omoda C5", 2022, null, 17),
  vehicleSeed("Jaecoo", "Джейку", "J7", "J7", "Jaecoo J7", "Jaecoo J7", 2023, null, 18),
  vehicleSeed("Jaecoo", "Джейку", "J8", "J8", "Jaecoo J8", "Jaecoo J8", 2024, null, 19),
  vehicleSeed("Exeed", "Эксид", "TXL", "TXL", "星途 Exeed TXL", "Exeed TXL", 2020, null, 20),
  vehicleSeed("Exeed", "Эксид", "VX", "VX", "星途 Exeed VX", "Exeed VX", 2021, null, 21),
  vehicleSeed("Exeed", "Эксид", "LX", "LX", "星途 Exeed LX", "Exeed LX", 2021, null, 22),
  vehicleSeed("Exeed", "Эксид", "RX", "RX", "星途 Exeed RX", "Exeed RX", 2023, null, 23),
  vehicleSeed("TENET", "Тенет", "T4", "T4", "TENET T4", "TENET T4", 2025, null, 24),
  vehicleSeed("TENET", "Тенет", "T7", "T7", "TENET T7", "TENET T7", 2025, null, 25),
  vehicleSeed("TENET", "Тенет", "T8", "T8", "TENET T8", "TENET T8", 2025, null, 26)
];

let schemaReady = false;

function vehicleSeed(brand, brandRu, model, modelRu, labelZh, labelRu, yearFrom, yearTo, rank, aliases = []) {
  return { brand, brandRu, model, modelRu, labelZh, labelRu, yearFrom, yearTo, popularityRank: rank, aliases };
}

export async function assetVariantBootstrap() {
  await ensureAssetVariantSchema();
  const shops = await mysqlQuery(`
    SELECT s.id, s.name, s.status, s.legal_entity, s.watermark_path,
      s.watermark_position, s.watermark_x_percent, s.watermark_y_percent, s.watermark_scale_percent, s.watermark_opacity_percent,
      r.title_style, r.tag_style, r.price_index, r.watermark_template_id, r.tail_image_url, r.main_image_plan,
      r.tail_category, r.vehicle_model, r.tail_template_id
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
  await mysqlExecute(`
    INSERT INTO shop_variant_rules
    (shop_id, title_style, tag_style, price_index, watermark_template_id, tail_image_url, main_image_plan,
     tail_category, vehicle_model, tail_template_id, updated_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title_style = VALUES(title_style),
      tag_style = VALUES(tag_style),
      price_index = VALUES(price_index),
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
    normalizeTagStyle(body.tagStyle || body.tag_style),
    normalizePriceIndex(body.priceIndex || body.price_index),
    String(body.watermarkTemplateId || body.watermark_template_id || ""),
    String(body.tailImageUrl || body.tail_image_url || ""),
    String(body.mainImagePlan || body.main_image_plan || "watermarked"),
    cleanText(body.tailCategory || body.tail_category || DEFAULT_TAIL_CATEGORY, 128),
    cleanText(body.vehicleModel || body.vehicle_model || DEFAULT_TAIL_MODEL, 128),
    Number(body.tailTemplateId || body.tail_template_id || 0) || null,
    personId(session)
  ]);
  return { ok: true, shopId };
}

export async function generateAssetVariants(body = {}, session = null) {
  await ensureAssetVariantSchema();
  const material = normalizeMaterialPayload(body.material || body);
  const shopIds = uniqueNumbers(body.shopIds || body.shop_ids);
  const rulesInput = Array.isArray(body.rules) ? body.rules : [];
  if (!material.title) throw new Error("请填写原始标题");
  if (!material.mainImage) throw new Error("请上传主图");
  if (!shopIds.length) throw new Error("请选择店铺");

  const bootstrap = await assetVariantBootstrap();
  const shops = bootstrap.shops.filter((shop) => shopIds.includes(Number(shop.id)));
  if (!shops.length) throw new Error("未找到可用店铺");

  const templateMap = new Map(bootstrap.watermarkTemplates.map((template) => [String(template.id), template]));
  const tailTemplateMap = new Map(bootstrap.tailTemplates.map((template) => [Number(template.id), template]));
  const ruleMap = new Map(rulesInput.map((rule) => [Number(rule.shopId || rule.shop_id), rule]));
  const batchId = `variant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const batchDir = path.join(VARIANT_ROOT, batchId);
  await fs.mkdir(batchDir, { recursive: true });

  const variants = await mapWithConcurrency(shops, ASSET_VARIANT_CONCURRENCY, async (shop) => {
    const mergedRule = normalizeRule({ ...shop.rule, ...(ruleMap.get(Number(shop.id)) || {}) });
    const titleCandidates = await generateTitleCandidates(material, shop);
    const selectedTitle = titleCandidates[mergedRule.titleStyle] || fallbackTitle(material, mergedRule.titleStyle, shop);
    const title = selectedTitle.ru;
    const titleZh = selectedTitle.zh;
    const priceIndex = normalizePriceIndex(mergedRule.priceIndex || mergedRule.price_index);
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
      variantTitle: title
    });

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
       length_cm, width_cm, height_cm, weight_g, color, material_text, quantity_text,
       output_dir, status, created_by_person_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?)
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
      material.material || "",
      material.quantity || "",
      outputDir,
      personId(session)
    ]);

    const variantId = Number(insertResult.insertId || 0);
    await insertGeneratedTitleCandidates(variantId, shop.id, titleCandidates);
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
  if (!batchId && !assetIds.length) throw new Error("请选择要删除的素材");

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
  if (!material.title) throw new Error("请先填写原始标题");
  if (!shopId) throw new Error("请选择店铺");
  const bootstrap = await assetVariantBootstrap();
  const shop = bootstrap.shops.find((item) => Number(item.id) === shopId);
  if (!shop) throw new Error("未找到店铺");
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
  if (!variantIds.length) return { ok: true, imported: 0, drafts: [], note: "未选择素材包" };

  const variants = await mysqlQuery(`
    SELECT v.*, s.name AS shop_name, s.watermark_path
    FROM asset_variants v
    LEFT JOIN shops s ON s.id = v.shop_id
    WHERE v.id IN (${variantIds.map(() => "?").join(",")})
    ORDER BY v.id ASC
  `, variantIds);
  if (!variants.length) return { ok: true, imported: 0, drafts: [], note: "没有找到可导入的素材包" };

  const drafts = [];
  await withMysqlTransaction(async (connection) => {
    for (const variant of variants) {
      const images = parseJson(variant.images_json, []).map((image) => image.publishUrl || image.url || image.previewUrl || image.outputPath).filter(Boolean);
      const templateId = await ensureAssetVariantListingTemplate(connection, variant, session);
      const draftId = await insertListingDraft(connection, templateId, variant, images, session);
      await insertListingShopCopy(connection, draftId, variant, images, session);
      await connection.execute(`
        UPDATE asset_variants
        SET imported_to_listing = 1, imported_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [variant.id]);
      drafts.push({ variantId: Number(variant.id), draftId, shopId: Number(variant.shop_id), shopName: variant.shop_name });
    }
  });

  return {
    ok: true,
    imported: drafts.length,
    drafts,
    note: `已导入 ${drafts.length} 个素材包到 listing-automation`
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
  if (!shop) throw new Error("没有找到带真实 Ozon API 凭证的店铺，无法同步真实类目");
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
  const name = cleanText(body.name || `${category}-${vehicleModel}-尾图`, 255);
  const isDefault = Boolean(body.isDefault ?? body.is_default);
  const imagePath = await storeTailTemplateImage(body.image || body.imageData || body.image_data || body.imagePath || body.image_path, name);
  if (!imagePath) throw new Error("请上传尾图模板图片");

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
  const filePath = resolveLocalAssetPath(template.imagePath);
  try {
    const buffer = await fs.readFile(filePath);
    return { buffer, mime: mimeForPath(filePath) };
  } catch {
    return null;
  }
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
  if (config.dbClient !== "mysql") throw new Error("素材裂变引擎当前需要 MySQL 模式");
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
  await ensureMysqlColumn("asset_variants", "material_text", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "quantity_text", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureMysqlColumn("asset_variants", "tag_style", "VARCHAR(32) NOT NULL DEFAULT 'traffic'");
  await ensureMysqlColumn("asset_variants", "price_index", "DECIMAL(10,4) NOT NULL DEFAULT 1.0000");
  await ensureMysqlColumn("asset_variants", "internal_price", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "ozon_price", "DECIMAL(10,2) NOT NULL DEFAULT 0");
  await ensureMysqlColumn("asset_variants", "ozon_old_price", "DECIMAL(10,2) NOT NULL DEFAULT 0");
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

async function generateVariantImages({ material, shopDir, watermark, tailImageUrl, mainImagePlan, batchId, shopId, sourceTitle = "", variantTitle = "" }) {
  const images = [];
  const mainDir = path.join(shopDir, "images", "main");
  const detailDir = path.join(shopDir, "images", "details");
  const tailDir = path.join(shopDir, "images", "tail");
  await fs.mkdir(mainDir, { recursive: true });
  await fs.mkdir(detailDir, { recursive: true });
  await fs.mkdir(tailDir, { recursive: true });

  const mainOutput = path.join(mainDir, "main-01.jpg");
  const mainBuffer = await readImageBuffer(material.mainImage);
  if (mainImagePlan === "original") {
    await sharp(mainBuffer).rotate().jpeg({ quality: 92 }).toFile(mainOutput);
  } else {
    const mainImage = await applyWatermark(mainBuffer, watermark);
    await mainImage.jpeg({ quality: 92 }).toFile(mainOutput);
  }
  images.push(await imageResult(mainOutput, "main", 1, { batchId, shopId, sourceTitle, variantTitle }));

  const detailSources = material.detailImages.length ? [...material.detailImages] : [material.mainImage].filter(Boolean);

  for (let index = 0; index < detailSources.length; index += 1) {
    const source = detailSources[index];
    const output = path.join(detailDir, `detail-${String(index + 1).padStart(2, "0")}.jpg`);
    const buffer = await readImageBuffer(source);
    const detailImage = await applyWatermark(buffer, watermark);
    await detailImage.jpeg({ quality: 92 }).toFile(output);
    images.push(await imageResult(output, "detail", index + 1, { batchId, shopId, sourceTitle, variantTitle }));
  }

  if (tailImageUrl) {
    const output = path.join(tailDir, `tail-01.jpg`);
    const buffer = await readImageBuffer(tailImageUrl);
    const tailImage = await applyWatermark(buffer, watermark);
    await tailImage.jpeg({ quality: 92 }).toFile(output);
    images.push(await imageResult(output, "tail", 1, { batchId, shopId, sourceTitle, variantTitle }));
  }
  return images;
}

async function storeTailTemplateImage(source, name) {
  const text = String(source || "").trim();
  if (!text) return "";
  if (/^data:image\//i.test(text)) {
    await fs.mkdir(TAIL_TEMPLATE_ROOT, { recursive: true });
    const match = text.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) throw new Error("尾图模板图片格式不正确");
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
    const result = await chatWithAiProvider({ prompt, temperature: 0.35, maxTokens: 900 });
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

async function applyWatermark(sourceBuffer, watermark) {
  if (!watermark?.logoPath && !watermark?.logoUrl && !watermark?.logo_url) return sharp(sourceBuffer).rotate();
  const base = sharp(sourceBuffer).rotate();
  const metadata = await base.metadata();
  const baseWidth = Number(metadata.width || 0);
  const baseHeight = Number(metadata.height || 0);
  if (!baseWidth || !baseHeight) throw new Error("无法识别图片尺寸");

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

async function ensureAssetVariantListingTemplate(connection, variant, session) {
  const ozonCategoryId = cleanText(variant.ozon_category_id || "", 128) || "asset-variant";
  const ozonCategoryName = cleanText(variant.ozon_category_name || "", 500) || "素材裂变";
  const descriptionCategoryId = Number(variant.ozon_description_category_id || 0) || 0;
  const typeId = Number(variant.ozon_type_id || 0) || 0;
  const name = ozonCategoryId === "asset-variant" ? "素材裂变导入模板" : `素材裂变导入模板-${ozonCategoryName || ozonCategoryId}`;
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
      { name: "素材来源", value: "asset-variant-engine", required: false },
      { name: "标题风格", value: variant.title_style || "", required: false },
      { name: "产品标签", value: parseJson(variant.tags_json, []).join(" "), required: false }
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
    variant.variant_title || variant.source_title || `素材裂变 ${variant.id}`,
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
    tags: normalizeTags(raw.tags),
    description: String(raw.description || "").trim(),
    sourceProductId: Number(raw.sourceProductId || raw.source_product_id || 0) || null,
    ozonCategoryId: cleanText(raw.ozonCategoryId || raw.ozon_category_id || "", 128),
    ozonDescriptionCategoryId: Number(raw.ozonDescriptionCategoryId || raw.ozon_description_category_id || 0) || 0,
    ozonTypeId: Number(raw.ozonTypeId || raw.ozon_type_id || 0) || 0,
    ozonCategoryName: cleanText(raw.ozonCategoryName || raw.ozon_category_name || "", 500),
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
      watermarkTemplateId: row.watermark_template_id || (row.watermark_path ? `shop-${row.id}` : ""),
      tailImageUrl: row.tail_image_url,
      tailCategory: row.tail_category,
      vehicleModel: row.vehicle_model,
      tailTemplateId: row.tail_template_id,
      mainImagePlan: row.main_image_plan
    })
  };
}

function normalizeRule(rule = {}) {
  return {
    titleStyle: normalizeTitleStyle(rule.titleStyle || rule.title_style),
    tagStyle: normalizeTagStyle(rule.tagStyle || rule.tag_style),
    priceIndex: normalizePriceIndex(rule.priceIndex || rule.price_index),
    watermarkTemplateId: String(rule.watermarkTemplateId || rule.watermark_template_id || ""),
    tailImageUrl: String(rule.tailImageUrl || rule.tail_image_url || ""),
    tailCategory: cleanText(rule.tailCategory || rule.tail_category || DEFAULT_TAIL_CATEGORY, 128),
    vehicleModel: cleanText(rule.vehicleModel || rule.vehicle_model || DEFAULT_TAIL_MODEL, 128),
    tailTemplateId: Number(rule.tailTemplateId || rule.tail_template_id || 0) || null,
    mainImagePlan: String(rule.mainImagePlan || rule.main_image_plan || "watermarked")
  };
}

function normalizeTailTemplate(row = {}) {
  const imagePath = String(row.image_path || row.imagePath || "").trim();
  return {
    id: Number(row.id || 0),
    shopId: Number(row.shop_id || row.shopId || 0) || null,
    shopName: row.shop_name || row.shopName || "",
    category: cleanText(row.category || DEFAULT_TAIL_CATEGORY, 128),
    vehicleModel: cleanText(row.vehicle_model || row.vehicleModel || DEFAULT_TAIL_MODEL, 128),
    name: cleanText(row.name || "尾图模板", 255),
    imagePath,
    imageUrl: imagePath ? `/api/asset-variant-engine/tail-template-files/${encodeURIComponent(row.id)}` : "",
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
  if (!text) throw new Error("图片不能为空");
  const dataUrlMatch = text.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (dataUrlMatch) return Buffer.from(dataUrlMatch[1], "base64");
  if (/^\/?api\//i.test(text)) {
    return fetchImageBuffer(new URL(text.replace(/^\/?/, "/"), config.appBaseUrl).toString());
  }
  if (/^https?:\/\//i.test(text)) {
    const response = await fetch(text);
    if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return fs.readFile(resolveLocalAssetPath(text));
}

async function fetchImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
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
  const detailHeaders = detailImages.map((_, index) => `详情图${index + 1}`);
  const tailHeaders = tailImages.map((_, index) => `尾图${index + 1}`);
  const rows = [
    ["店铺", "类目", "车型", "俄语标题", "中文标题释义", "标签", "产品卖点", "颜色", "材质", "数量", "长cm", "宽cm", "高cm", "重量g", "主图", ...detailHeaders, ...tailHeaders, "尾图模板", "图片总数"],
    [
      shop.name,
      rule?.tailCategory || "",
      rule?.vehicleModel || "",
      title,
      titleZh || "",
      material.tags.join(","),
      material.description,
      material.color || "",
      material.material || "",
      material.quantity || "",
      material.lengthCm || "",
      material.widthCm || "",
      material.heightCm || "",
      material.weightG || "",
      mainImages.join("\n"),
      ...detailImages,
      ...tailImages,
      tailTemplate?.name || "",
      String(images.length)
    ]
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
    ["字段", "值"],
    ["店铺", productInfo.shop.name],
    ["类目", productInfo.category],
    ["Ozon类目", productInfo.ozonCategory?.name || productInfo.ozonCategory?.id || ""],
    ["车型", productInfo.vehicleModel],
    ["俄语标题", productInfo.titleRu || productInfo.title],
    ["中文标题释义", productInfo.titleZh || ""],
    ["标签", productInfo.tags.join(",")],
    ["产品卖点", productInfo.sellingPoints || productInfo.description],
    ["颜色", productInfo.color],
    ["材质", productInfo.material],
    ["数量", productInfo.quantity],
    ["长cm", productInfo.dimensions.lengthCm || ""],
    ["宽cm", productInfo.dimensions.widthCm || ""],
    ["高cm", productInfo.dimensions.heightCm || ""],
    ["重量g", productInfo.dimensions.weightG || ""],
    ["主图文件夹", "images/main"],
    ["详情图文件夹", "images/details"],
    ["尾图文件夹", "images/tail"]
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
  const carModel = extractLikelyCarModel(material.title) || "универсальная модель";
  const materialPart = material.material ? "из " + russianFactValue(material.material, "material") : "для защиты";
  const colorValue = russianFactValue(material.color, "color");
  const quantityValue = russianFactValue(material.quantity, "quantity");
  const colorPart = colorValue ? ", цвет " + colorValue : "";
  const quantityPart = quantityValue ? ", " + quantityValue : "";
  const base = {
    traffic: {
      ru: productType + ' для ключа ' + carModel + ' ' + materialPart + colorPart + quantityPart + ', автомобильный аксессуар',
      zh: '搜索流量型标题：突出产品类型、车型、材质、颜色和常用搜索词'
    },
    material: {
      ru: productType + ' для ключа ' + carModel + ' ' + materialPart + ', защита от царапин и ежедневного износа' + colorPart,
      zh: '材质卖点型标题：突出材质、防刮、耐磨和日常保护'
    },
    scenario: {
      ru: productType + ' для ключа ' + carModel + ', удобный аксессуар для ежедневного вождения и поездок' + colorPart,
      zh: '场景适配型标题：突出日常通勤、车主使用和适配场景'
    },
    value: {
      ru: 'Практичный ' + productType.toLowerCase() + ' для ключа ' + carModel + ' ' + materialPart + colorPart + quantityPart + ', выгодная комплектация',
      zh: '性价比型标题：突出实用配置和用料搭配的综合价值'
    },
    premium: {
      ru: 'Премиальный ' + productType.toLowerCase() + ' для ключа ' + carModel + ' ' + materialPart + colorPart + ', аккуратная посадка и стиль',
      zh: '高端质感型标题：突出质感、贴合度和精致外观'
    }
  }[style] || {
    ru: productType + ' для автомобильного ключа ' + materialPart + colorPart,
    zh: '通用标题'
  };
  return {
    ru: cleanText(base.ru.replace(/\s+/g, ' '), 500),
    zh: cleanText(base.zh, 500)
  };
}

function generateShopTags(material, shop, rule = {}, title = "") {
  const model = extractLikelyCarModel(`${material.vehicleModel || ""} ${material.title || ""} ${title || ""}`) || "универсальный";
  const materialText = russianTagWord(material.material || "материал");
  const colorText = russianTagWord(material.color || "");
  const shopTag = tagToken(shop.name || shop.legalEntity || "shop");
  const modelParts = model.split(/\s+/).filter(Boolean);
  const modelTags = [
    model,
    `${model} аксессуары`,
    `${model} ключ`,
    `${model} чехол`,
    modelParts.slice(0, 2).join(" ")
  ];
  const materialTags = [
    materialText,
    `${materialText} чехол`,
    "защита ключа",
    colorText ? `${colorText} чехол` : ""
  ];
  const trafficTags = ["автоаксессуары", "чехол для ключа", "брелок авто", "подарок водителю", "защита от царапин", "аксессуар в авто"];
  const compactTags = ["без логотипа", "аккуратная посадка", "ежедневное использование", "универсальный стиль"];
  const style = normalizeTagStyle(rule.tagStyle || rule.tag_style);
  const ordered = style === "vehicle"
    ? [...modelTags, ...modelTags, ...materialTags, ...trafficTags]
    : style === "material"
      ? [...materialTags, ...modelTags, ...trafficTags]
      : style === "compact"
        ? [...modelTags.slice(0, 3), ...materialTags, ...compactTags]
        : [...trafficTags, ...modelTags, ...materialTags];
  return uniqueValues([shopTag, ...ordered].map(tagToken)).slice(0, 20);
}

function tagToken(value) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/ruvibe\s*mart/gi, "ruvibemart")
    .replace(/[^a-zа-яё0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  return text ? `#${text}` : "";
}

function russianTagWord(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("tpu")) return "тпу";
  if (text.includes("abs")) return "abs";
  if (text.includes("皮") || text.includes("leather")) return "кожа";
  if (text.includes("金") || text.includes("metal")) return "металл";
  if (text.includes("黑") || text.includes("black")) return "черный";
  if (text.includes("银") || text.includes("silver")) return "серебро";
  if (text.includes("白") || text.includes("white")) return "белый";
  return text || "материал";
}

function detectProductType(title, description) {
  const text = String((title || '') + ' ' + (description || '')).toLowerCase();
  if (text.includes('key') || text.includes('ключ') || text.includes('钥匙')) return 'Чехол для автомобильного ключа';
  if (text.includes('коврик') || text.includes('脚垫')) return 'Автомобильный коврик';
  if (text.includes('наклад') || text.includes('门槛')) return 'Автомобильная накладка';
  return 'Автомобильный аксессуар';
}

function extractLikelyCarModel(title) {
  const text = String(title || '');
  const match = text.match(/(Belgee\s*X50|Belgee\s*X70|Haval\s*[A-Z0-9-]+|Chery\s*[A-Z0-9\s-]+|Geely\s*[A-Z0-9\s-]+|Omoda\s*[A-Z0-9-]+|Jaecoo\s*[A-Z0-9-]+|Exeed\s*[A-Z0-9-]+|TENET\s*[A-Z0-9-]+)/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
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
      zh: looksBrokenGeneratedText(zh) ? fallback.zh : zh || fallback.zh
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

function russianFactValue(value, type = "") {
  let text = cleanText(value, 120);
  if (!text) return "";
  const lower = text.toLowerCase();
  const colorMap = [
    [/黑|black|черн/, "черный"],
    [/白|white|бел/, "белый"],
    [/银|сереб|silver/, "серебристый"],
    [/灰|gray|grey|сер/, "серый"],
    [/红|red|красн/, "красный"],
    [/蓝|blue|син/, "синий"],
    [/金|gold|золот/, "золотистый"]
  ];
  if (type === "color") {
    const hit = colorMap.find(([pattern]) => pattern.test(lower) || pattern.test(text));
    return hit ? hit[1] : hasCjkText(text) ? "" : text;
  }
  if (type === "quantity") {
    const number = text.match(/\d+/)?.[0];
    return number ? `${number} шт.` : hasCjkText(text) ? "" : text;
  }
  if (type === "material") {
    if (/tpu|тпу/i.test(text)) return "TPU";
    if (/皮|кож|leather/i.test(text)) return "кожи";
    if (/金属|metal|металл/i.test(text)) return "металла";
    return hasCjkText(text) ? "" : text;
  }
  return hasCjkText(text) ? "" : text;
}

function looksBrokenGeneratedText(value) {
  const text = String(value || "");
  if (!text) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks >= 4 && questionMarks / Math.max(1, text.length) > 0.12) return true;
  return /(?:�|鏍|绱|涓|閫|鍥|灏|棰|璇|搴|姘|鎻)/.test(text);
}

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency || 1));
  const results = new Array(list.length);
  let cursor = 0;
  async function runNext() {
    const index = cursor;
    cursor += 1;
    if (index >= list.length) return;
    results[index] = await worker(list[index], index);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, runNext));
  return results;
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

async function writeText(filePath, content) {
  await fs.writeFile(filePath, content || "", "utf8");
}

function normalizeUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  if (/^(https?:|data:|blob:)/i.test(text)) return text;
  if (text.startsWith("/")) return text;
  return `/${text.replace(/^public[\\/]/, "").replace(/\\/g, "/")}`;
}

function resolveLocalAssetPath(value) {
  const text = String(value || "").trim();
  if (!text || /^https?:|^data:/i.test(text)) return text;
  const clean = text.replace(/^\/+/, "");
  const candidates = [
    path.resolve(ROOT_DIR, clean),
    path.resolve(ROOT_DIR, "uploads", clean.replace(/^uploads[\\/]/, "")),
    path.resolve(ROOT_DIR, "public", clean.replace(/^public[\\/]/, ""))
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || candidates[0];
}

function sanitizeFilename(value) {
  return String(value || "asset").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 90);
}

function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function cleanText(value, max = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function personId(session) {
  return Number(session?.person_id || session?.personId || 0) || null;
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

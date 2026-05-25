import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import { config } from "../config.js";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";

const ROOT_DIR = process.cwd();
const PACKAGE_ROOT = path.resolve(ROOT_DIR, "uploads", "listing-packages");
const GENERATED_IMAGE_ROOT = path.resolve(ROOT_DIR, "uploads", "generated-images");
let schemaReady = false;
const tableColumnsCache = new Map();

export async function multiShopPublishBootstrap(query = {}, session = null) {
  await ensureMultiShopSchema();
  const productColumns = await getTableColumns("products");
  const inventoryColumns = await getTableColumns("inventory_current").catch(() => new Set());
  const hasInventoryCurrent = inventoryColumns.size > 0 && inventoryColumns.has("real_product_id");
  const productId = Number(query.productId || query.masterProductId || query.master_product_id || 0);
  const productWhere = [];
  const productParams = [];
  if (productId) {
    productWhere.push("p.`id` = ?");
    productParams.push(productId);
  } else if (productColumns.has("active")) {
    productWhere.push("p.`active` = 1");
  }
  const productOrder = productColumns.has("updated_at") ? "p.`updated_at` DESC, p.`id` DESC" : "p.`id` DESC";
  const productLimit = productId ? 1 : 80;
  const stockExpr = hasInventoryCurrent && inventoryColumns.has("available_stock")
    ? "COALESCE(ic.`available_stock`, 0)"
    : productNumberExpr(productColumns, ["stock", "stock_quantity", "quantity", "inventory", "alert_stock"], 0);
  const products = await mysqlQuery(`
    SELECT
      p.\`id\` AS id,
      ${productTextExpr(productColumns, ["code", "selection_id"], "''")} AS product_code,
      ${productTextExpr(productColumns, ["name", "title", "product_name"], "'未命名商品'")} AS title,
      ${productTextExpr(productColumns, ["name", "title", "product_name"], "'未命名商品'")} AS name,
      ${productTextExpr(productColumns, ["image_url", "main_image", "primary_image", "cover_image"], "''")} AS main_image,
      ${productTextExpr(productColumns, ["image_url", "main_image", "primary_image", "cover_image"], "''")} AS image_url,
      ${productNumberExpr(productColumns, ["purchase_cost", "cost_price", "cost", "purchase_price"], 0)} AS cost_price,
      ${productNumberExpr(productColumns, ["default_price", "price", "sale_price", "price_rmb", "sale_price_rmb", "listing_price_rub", "air_sale_price_rmb"], 0)} AS default_price,
      ${productNumberExpr(productColumns, ["default_price", "price", "sale_price", "price_rmb", "sale_price_rmb", "listing_price_rub", "air_sale_price_rmb"], 0)} AS default_sale_price,
      ${stockExpr} AS stock,
      ${stockExpr} AS stock_quantity,
      ${productTextExpr(productColumns, ["category", "product_category", "source_platform"], "'未分类'")} AS category,
      ${productTextExpr(productColumns, ["vehicle_models", "vehicle_model", "shipping_method"], "''")} AS vehicle_models,
      ${productTextExpr(productColumns, ["brand"], "''")} AS brand,
      ${productTextExpr(productColumns, ["material"], "''")} AS material,
      ${productTextExpr(productColumns, ["description", "product_description", "supplier_note"], "''")} AS description,
      ${productTextExpr(productColumns, ["status", "selection_status"], "'active'")} AS status
    FROM products p
    ${hasInventoryCurrent ? "LEFT JOIN inventory_current ic ON ic.real_product_id = p.`id`" : ""}
    ${productWhere.length ? `WHERE ${productWhere.join(" AND ")}` : ""}
    ORDER BY ${productOrder}
    LIMIT ${productLimit}
  `, productParams);
  const shops = await mysqlQuery(`
    SELECT id, name, 'ozon' AS platform, watermark_path, status,
      watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent
    FROM shops
    WHERE status <> 'deleted'
    ORDER BY id DESC
  `);
  const templates = await mysqlQuery(`
    SELECT id, name, logo_url, logo_path, position, opacity, size_percent, margin_px, status
    FROM shop_watermark_templates
    WHERE status <> 'deleted'
    ORDER BY updated_at DESC, id DESC
  `);
  const versions = (query.masterProductId || query.productId)
    ? await multiShopVersions({ masterProductId: query.masterProductId || query.productId }, session)
    : [];

  return {
    products: products.map(normalizeProduct),
    shops: shops.map(normalizeShop),
    watermarkTemplates: [
      ...templates.map(normalizeWatermarkTemplate),
      ...shops.filter((shop) => shop.watermark_path).map(shopWatermarkTemplate)
    ],
    imagePlans: [
      { value: "use_master_main", label: "母商品主图" },
      { value: "first_raw", label: "第一张原图" },
      { value: "shop_specific", label: "店铺专属图" },
      { value: "manual", label: "手动选择" }
    ],
    stats: {
      productCount: products.length,
      shopCount: shops.length,
      activeShopCount: shops.filter((shop) => shop.status === "active").length,
      watermarkTemplateCount: templates.length + shops.filter((shop) => shop.watermark_path).length,
      generatedVersionCount: versions.length
    },
    versions
  };
}

export async function multiShopVersions(query = {}) {
  await ensureMultiShopSchema();
  const params = [];
  let where = "1=1";
  if (query.masterProductId) {
    where += " AND v.master_product_id = ?";
    params.push(Number(query.masterProductId));
  }
  const rows = await mysqlQuery(`
    SELECT v.*, s.name AS shop_name
    FROM shop_product_versions v
    LEFT JOIN shops s ON s.id = v.shop_id
    WHERE ${where}
    ORDER BY v.updated_at DESC, v.id DESC
  `, params);
  return rows.map(normalizeVersion);
}

export async function generateMultiShopVersions(body = {}, session = null) {
  await ensureMultiShopSchema();
  const masterProductId = Number(body.masterProductId || body.master_product_id || 0);
  const shops = Array.isArray(body.shops) ? body.shops : [];
  if (!masterProductId) throw new Error("请选择母商品");
  if (!shops.length) throw new Error("请选择需要生成版本的店铺");

  const product = await loadProductForPublish(masterProductId);
  if (!product) throw new Error("母商品不存在");

  const versions = [];
  await withMysqlTransaction(async (connection) => {
    for (const item of shops) {
      const shopId = Number(item.shopId || item.shop_id || 0);
      if (!shopId) continue;
      const title = cleanText(item.title || product.name, 500);
      const price = Number(item.price || 0);
      const stock = Number(item.stock ?? item.stock_quantity ?? 0);
      const offerId = cleanText(item.offerId || item.offer_id || buildOfferId(product, shopId), 128);
      const mainImageUrl = cleanText(item.mainImageUrl || item.main_image_url || product.image_url || "", 2000);
      const watermarkTemplateId = item.watermarkTemplateId || item.watermark_template_id || null;
      const imagePlan = cleanText(item.imagePlan || item.image_plan || "use_master_main", 64);
      const description = item.description || product.supplier_note || "";
      const validation = validateVersion({ title, price, stock, mainImageUrl, watermarkTemplateId });
      const generatedImages = buildGeneratedImages(mainImageUrl, item.detailImages || item.detail_images || [], watermarkTemplateId);

      await connection.execute(`
        INSERT INTO shop_product_versions
        (master_product_id, shop_id, offer_id, title, price, stock_quantity, description,
         watermark_template_id, image_plan, generated_images_json, validation_json, status, created_by_person_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?)
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          price = VALUES(price),
          stock_quantity = VALUES(stock_quantity),
          description = VALUES(description),
          watermark_template_id = VALUES(watermark_template_id),
          image_plan = VALUES(image_plan),
          generated_images_json = VALUES(generated_images_json),
          validation_json = VALUES(validation_json),
          status = 'generated',
          updated_at = CURRENT_TIMESTAMP
      `, [
        masterProductId,
        shopId,
        offerId,
        title,
        price,
        stock,
        description,
        watermarkTemplateId || null,
        imagePlan,
        JSON.stringify(generatedImages),
        JSON.stringify(validation),
        personId(session)
      ]);
    }
  });

  const shopIds = shops.map((item) => Number(item.shopId || item.shop_id || 0)).filter(Boolean);
  const placeholders = shopIds.map(() => "?").join(",");
  const rows = await mysqlQuery(`
    SELECT v.*, s.name AS shop_name
    FROM shop_product_versions v
    LEFT JOIN shops s ON s.id = v.shop_id
    WHERE v.master_product_id = ? AND v.shop_id IN (${placeholders})
    ORDER BY v.id DESC
  `, [masterProductId, ...shopIds]);
  versions.push(...rows.map(normalizeVersion));
  return { ok: true, versions };
}

export async function generatePreviewImages(body = {}, session = null) {
  await ensureMultiShopSchema();
  const productId = Number(body.productId || body.masterProductId || body.product_id || 0);
  const shopIds = (Array.isArray(body.shopIds) ? body.shopIds : [body.shopId]).map(Number).filter(Boolean);
  if (!productId) throw new Error("请选择商品");
  if (!shopIds.length) throw new Error("请选择店铺");

  const product = await loadProductForPublish(productId);
  if (!product) throw new Error("商品不存在");
  const sourceImage = normalizeUrl(product.image_url || "");
  if (!sourceImage) throw new Error("商品缺少主图");

  const shops = await mysqlQuery(`
    SELECT id, name, watermark_path, status,
      watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent
    FROM shops
    WHERE id IN (${shopIds.map(() => "?").join(",")}) AND status <> 'deleted'
  `, shopIds);
  const shopMap = new Map(shops.map((shop) => [Number(shop.id), shop]));
  const sourceBuffer = await readImageBuffer(sourceImage);
  const previews = [];

  for (const shopId of shopIds) {
    const shop = shopMap.get(Number(shopId));
    if (!shop) {
      previews.push({ shopId, previewUrl: "", status: "failed", error: "店铺不存在" });
      continue;
    }

    let generatedImageId = 0;
    try {
      const pendingResult = await mysqlExecute(`
        INSERT INTO generated_images
        (product_id, shop_id, image_type, source_image, watermark_template_id, output_path, preview_url, status)
        VALUES (?, ?, 'main', ?, ?, '', '', 'generating')
      `, [productId, shopId, sourceImage, `shop-${shopId}`]);
      generatedImageId = Number(pendingResult.insertId || 0);

      const watermark = await loadWatermarkForShop(shop);
      if (!watermark.logoPath && !watermark.logoUrl) throw new Error("店铺缺少水印模板");

      const outputDir = path.join(GENERATED_IMAGE_ROOT, String(shopId));
      await fs.mkdir(outputDir, { recursive: true });
      const baseName = `product-${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const webpPath = path.join(outputDir, `${baseName}.webp`);
      const jpgPath = path.join(outputDir, `${baseName}.jpg`);
      const watermarked = await applyWatermarkWithSharp(sourceBuffer, watermark);
      await watermarked.clone().webp({ quality: 88 }).toFile(webpPath);
      await watermarked.clone().jpeg({ quality: 92 }).toFile(jpgPath);

      const relativeWebp = path.relative(ROOT_DIR, webpPath).replace(/\\/g, "/");
      const previewUrl = `/api/multi-shop-publish/generated-images/${shopId}/${path.basename(webpPath)}`;
      const watermarkTemplateId = watermark.id || `shop-${shopId}`;
      await mysqlExecute(`
        UPDATE generated_images
        SET watermark_template_id = ?, output_path = ?, preview_url = ?, status = 'generated'
        WHERE id = ?
      `, [String(watermarkTemplateId), relativeWebp, previewUrl, generatedImageId]);

      previews.push({
        shopId,
        previewUrl,
        outputPath: relativeWebp,
        jpgPath: path.relative(ROOT_DIR, jpgPath).replace(/\\/g, "/"),
        status: "generated"
      });
    } catch (error) {
      if (generatedImageId) {
        await mysqlExecute("UPDATE generated_images SET status = 'failed' WHERE id = ?", [generatedImageId]).catch(() => {});
      } else {
        await mysqlExecute(`
          INSERT INTO generated_images
          (product_id, shop_id, image_type, source_image, watermark_template_id, output_path, preview_url, status)
          VALUES (?, ?, 'main', ?, ?, '', '', 'failed')
        `, [productId, shopId, sourceImage, `shop-${shopId}`]).catch(() => {});
      }
      previews.push({ shopId, previewUrl: "", status: "failed", error: error.message || "生成失败" });
    }
  }

  return { previews, createdBy: personId(session) };
}

export async function resolveGeneratedImageFile(shopId, filename) {
  const safeShopId = String(Number(shopId || 0));
  const safeFilename = path.basename(String(filename || ""));
  if (!safeShopId || !safeFilename) return null;
  const filePath = path.resolve(GENERATED_IMAGE_ROOT, safeShopId, safeFilename);
  const shopDir = path.resolve(GENERATED_IMAGE_ROOT, safeShopId);
  if (!filePath.startsWith(shopDir)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
  try {
    const buffer = await fs.readFile(filePath);
    return { buffer, mime };
  } catch {
    return null;
  }
}

async function loadProductForPublish(productId) {
  const columns = await getTableColumns("products");
  const rows = await mysqlQuery(`
    SELECT
      p.\`id\` AS id,
      ${productTextExpr(columns, ["code", "selection_id"], "''")} AS code,
      ${productTextExpr(columns, ["name", "title", "product_name"], "'未命名商品'")} AS name,
      ${productTextExpr(columns, ["image_url", "main_image", "primary_image", "cover_image"], "''")} AS image_url,
      ${productTextExpr(columns, ["description", "product_description", "supplier_note"], "''")} AS supplier_note
    FROM products p
    WHERE p.\`id\` = ?
    LIMIT 1
  `, [Number(productId)]);
  return rows[0] || null;
}

export async function exportMultiShopListingPackage(body = {}, session = null) {
  await ensureMultiShopSchema();
  const versions = normalizeExportVersions(body.versions || []);
  if (!versions.length) throw new Error("请先生成店铺版本");

  const packageId = `listing-package-${Date.now()}`;
  const packageDir = path.join(PACKAGE_ROOT, packageId);
  await fs.mkdir(packageDir, { recursive: true });
  const files = [];

  for (const version of versions) {
    const shopDirName = sanitizeFilename(`${version.shopName || version.shopId}`);
    const shopDir = path.join(packageDir, shopDirName);
    const imageDir = path.join(shopDir, "images");
    await fs.mkdir(imageDir, { recursive: true });

    const rows = [
      ["店铺", version.shopName || ""],
      ["Offer ID", version.offerId || ""],
      ["标题", version.title || ""],
      ["价格", version.price || ""],
      ["库存", version.stock || ""],
      ["主图方案", version.imagePlan || ""],
      ["水印模板", version.watermarkTemplateId || ""]
    ];
    await writePackageFile(path.join(shopDir, "listing.xlsx"), rows.map((row) => row.join("\t")).join("\n"), files, packageDir);
    await writePackageFile(path.join(shopDir, "title.txt"), version.title || "", files, packageDir);
    await writePackageFile(path.join(shopDir, "description.txt"), version.description || "", files, packageDir);
    await writePackageFile(path.join(shopDir, "tags.txt"), buildTags(version), files, packageDir);
    await materializeImage(version.mainImageUrl, path.join(imageDir, "main.png"), files, packageDir);
    const detailImages = Array.isArray(version.images) ? version.images.slice(1) : [];
    const unresolvedDetails = [];
    for (let index = 0; index < detailImages.length; index += 1) {
      const imageUrl = detailImages[index].generatedUrl || detailImages[index].sourceUrl || "";
      const saved = await materializeImage(imageUrl, path.join(imageDir, `detail-${String(index + 1).padStart(2, "0")}.png`), files, packageDir);
      if (!saved && imageUrl) unresolvedDetails.push(imageUrl);
    }
    if (unresolvedDetails.length) {
      await writePackageFile(path.join(imageDir, "detail-image-urls.txt"), unresolvedDetails.join("\n"), files, packageDir);
    }
  }

  return {
    ok: true,
    packageId,
    packageDir,
    files,
    createdBy: personId(session)
  };
}

export async function createMultiShopPublishTask(body = {}, session = null) {
  await ensureMultiShopSchema();
  const masterProductId = Number(body.masterProductId || body.master_product_id || 0);
  const versions = Array.isArray(body.versions) ? body.versions : [];
  if (!masterProductId) throw new Error("请选择母商品");
  if (!versions.length) throw new Error("请先生成店铺版本");

  const taskNo = `PUB-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString(36).toUpperCase()}`;
  let taskId = 0;
  await withMysqlTransaction(async (connection) => {
    const [taskResult] = await connection.execute(`
      INSERT INTO publish_tasks
      (task_no, master_product_id, total_count, pending_count, status, created_by_person_id)
      VALUES (?, ?, ?, ?, 'ready', ?)
    `, [taskNo, masterProductId, versions.length, versions.length, personId(session)]);
    taskId = Number(taskResult.insertId);

    for (const item of versions) {
      const versionId = Number(item.versionId || item.version_id || (String(item.versionId || "").startsWith("local-") ? 0 : item.versionId) || 0);
      const payload = item.payload || item;
      const shopId = Number(item.shopId || payload.shopId || payload.shop_id || 0);
      const offerId = cleanText(item.offerId || payload.offerId || payload.offer_id || "", 128);
      const requestJson = JSON.stringify(payload);
      await connection.execute(`
        INSERT INTO publish_task_items
        (task_id, shop_product_version_id, shop_id, offer_id, status, request_json)
        VALUES (?, ?, ?, ?, 'ready', ?)
      `, [taskId, versionId || null, shopId, offerId, requestJson]);
    }
  });

  return multiShopPublishTaskDetail(taskId, session);
}

export async function multiShopPublishTasks() {
  await ensureMultiShopSchema();
  return mysqlQuery("SELECT * FROM publish_tasks ORDER BY created_at DESC, id DESC LIMIT 100");
}

export async function multiShopPublishTaskDetail(id) {
  await ensureMultiShopSchema();
  const task = await mysqlQuery("SELECT * FROM publish_tasks WHERE id = ? LIMIT 1", [Number(id)]).then((rows) => rows[0]);
  if (!task) throw new Error("发布任务不存在");
  const items = await mysqlQuery(`
    SELECT i.*, s.name AS shop_name
    FROM publish_task_items i
    LEFT JOIN shops s ON s.id = i.shop_id
    WHERE i.task_id = ?
    ORDER BY i.id
  `, [Number(id)]);
  return { ...task, taskNo: task.task_no, items };
}

export async function retryMultiShopPublishItem(id) {
  await ensureMultiShopSchema();
  await mysqlExecute(`
    UPDATE publish_task_items
    SET status = 'ready', retry_count = retry_count + 1, error_message = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'failed'
  `, [Number(id)]);
  const item = await mysqlQuery("SELECT task_id FROM publish_task_items WHERE id = ? LIMIT 1", [Number(id)]).then((rows) => rows[0]);
  if (item?.task_id) await refreshTaskCounts(item.task_id);
  return { ok: true, itemId: Number(id), taskId: item?.task_id || null };
}

export async function regenerateMultiShopVersion(id) {
  await ensureMultiShopSchema();
  await mysqlExecute("UPDATE shop_product_versions SET status = 'generated', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  return { ok: true, version: (await mysqlQuery("SELECT * FROM shop_product_versions WHERE id = ?", [Number(id)])).map(normalizeVersion)[0] };
}

async function refreshTaskCounts(taskId) {
  const rows = await mysqlQuery(`
    SELECT status, COUNT(*) AS count
    FROM publish_task_items
    WHERE task_id = ?
    GROUP BY status
  `, [Number(taskId)]);
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const ready = counts.ready || counts.draft || 0;
  const processing = counts.processing || 0;
  const success = counts.success || 0;
  const failed = counts.failed || 0;
  let status = "ready";
  if (processing) status = "processing";
  else if (success === total && total) status = "success";
  else if (failed && success) status = "failed";
  else if (failed === total && total) status = "failed";
  await mysqlExecute(`
    UPDATE publish_tasks
    SET total_count = ?, pending_count = ?, processing_count = ?, success_count = ?, failed_count = ?, status = ?
    WHERE id = ?
  `, [total, ready, processing, success, failed, status, Number(taskId)]);
}

async function ensureMultiShopSchema() {
  if (config.dbClient !== "mysql") throw new Error("多店铺商品发布 MVP 目前需要 MySQL 模式");
  if (schemaReady) return;
  await ensureShopWatermarkDefaultColumns();
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS shop_watermark_templates (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(128) NOT NULL,
      logo_url TEXT NOT NULL,
      logo_path TEXT NULL,
      position VARCHAR(32) NOT NULL DEFAULT 'bottom-right',
      opacity DECIMAL(4,2) NOT NULL DEFAULT 0.82,
      size_percent DECIMAL(5,2) NOT NULL DEFAULT 22.00,
      margin_px INT NOT NULL DEFAULT 24,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS shop_product_versions (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      master_product_id BIGINT NOT NULL,
      shop_id BIGINT NOT NULL,
      offer_id VARCHAR(128) NOT NULL DEFAULT '',
      title VARCHAR(500) NOT NULL DEFAULT '',
      price DECIMAL(12,2) NOT NULL DEFAULT 0,
      stock_quantity INT NOT NULL DEFAULT 0,
      description LONGTEXT NULL,
      watermark_template_id VARCHAR(128) NULL,
      image_plan VARCHAR(64) NOT NULL DEFAULT 'use_master_main',
      generated_images_json LONGTEXT NULL,
      validation_json LONGTEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_shop_product_versions (master_product_id, shop_id, offer_id),
      INDEX idx_shop_versions_product (master_product_id, status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS publish_tasks (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      task_no VARCHAR(64) NOT NULL,
      master_product_id BIGINT NOT NULL,
      total_count INT NOT NULL DEFAULT 0,
      pending_count INT NOT NULL DEFAULT 0,
      processing_count INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_publish_tasks_no (task_no)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS publish_task_items (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      task_id BIGINT NOT NULL,
      shop_product_version_id BIGINT NULL,
      shop_id BIGINT NOT NULL,
      offer_id VARCHAR(128) NOT NULL DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      retry_count INT NOT NULL DEFAULT 0,
      ozon_task_id VARCHAR(128) NOT NULL DEFAULT '',
      ozon_product_id VARCHAR(128) NOT NULL DEFAULT '',
      ozon_sku VARCHAR(128) NOT NULL DEFAULT '',
      product_url TEXT NULL,
      request_json LONGTEXT NULL,
      response_json LONGTEXT NULL,
      error_message TEXT NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_publish_items_task (task_id, status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS generated_images (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      product_id BIGINT NOT NULL,
      shop_id BIGINT NOT NULL,
      image_type VARCHAR(32) NOT NULL DEFAULT 'main',
      source_image TEXT NOT NULL,
      watermark_template_id VARCHAR(128) NULL,
      output_path TEXT NULL,
      preview_url TEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_generated_images_product_shop (product_id, shop_id, image_type, created_at)
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

function normalizeProduct(row) {
  const imageUrl = normalizeUrl(row.main_image || row.image_url || "");
  const defaultPrice = Number(row.default_price ?? row.default_sale_price ?? 0);
  const stock = Number(row.stock ?? row.stock_quantity ?? 0);
  return {
    id: row.id,
    product_code: row.product_code || `P-${row.id}`,
    title: row.title || row.name,
    name: row.title || row.name,
    category: row.category || "未分类",
    vehicle_models: row.vehicle_models || "",
    brand: row.brand || "",
    material: row.material || "",
    cost_price: Number(row.cost_price || 0),
    default_price: defaultPrice,
    default_sale_price: defaultPrice,
    stock,
    stock_quantity: stock,
    main_image: imageUrl,
    description: row.description || "",
    status: row.status || "active",
    assets: imageUrl ? [{ id: `product-${row.id}-main`, asset_type: "main", url: imageUrl, sort_order: 1 }] : []
  };
}

function normalizeShop(row) {
  return {
    id: row.id,
    name: row.name,
    shop_name: row.name,
    platform: row.platform || "ozon",
    watermark_path: normalizeUrl(row.watermark_path || ""),
    watermark_position: row.watermark_position || "bottom-right",
    watermark_x_percent: Number(row.watermark_x_percent ?? 75),
    watermark_y_percent: Number(row.watermark_y_percent ?? 75),
    watermark_scale_percent: Number(row.watermark_scale_percent ?? 22),
    watermark_opacity_percent: Number(row.watermark_opacity_percent ?? 82),
    status: row.status || "active",
    watermark_template_id: row.watermark_path ? `shop-${row.id}` : ""
  };
}

function shopWatermarkTemplate(shop) {
  return {
    id: `shop-${shop.id}`,
    name: `${shop.name} 默认水印`,
    logo_url: normalizeUrl(shop.watermark_path || ""),
    position: shop.watermark_position || "bottom-right",
    x_percent: Number(shop.watermark_x_percent ?? 75),
    y_percent: Number(shop.watermark_y_percent ?? 75),
    opacity: Number(shop.watermark_opacity_percent ?? 82) / 100,
    size_percent: Number(shop.watermark_scale_percent ?? 22),
    margin_px: 24,
    status: "active"
  };
}

function normalizeWatermarkTemplate(row) {
  return {
    id: row.id,
    name: row.name,
    logo_url: normalizeUrl(row.logo_url || row.logo_path || ""),
    logo_path: row.logo_path || "",
    position: row.position || "bottom-right",
    x_percent: Number(row.x_percent ?? 75),
    y_percent: Number(row.y_percent ?? 75),
    opacity: Number(row.opacity ?? 0.82),
    size_percent: Number(row.size_percent || 22),
    margin_px: Number(row.margin_px || 24),
    status: row.status || "active"
  };
}

function normalizeVersion(row) {
  const images = safeJson(row.generated_images_json, []);
  return {
    id: row.id,
    shopId: row.shop_id,
    shop_id: row.shop_id,
    shopName: row.shop_name || "",
    shop_name: row.shop_name || "",
    offerId: row.offer_id,
    offer_id: row.offer_id,
    title: row.title,
    price: Number(row.price || 0),
    stock: Number(row.stock_quantity || 0),
    stock_quantity: Number(row.stock_quantity || 0),
    description: row.description || "",
    watermarkTemplateId: row.watermark_template_id || "",
    watermark_template_id: row.watermark_template_id || "",
    imagePlan: row.image_plan || "use_master_main",
    image_plan: row.image_plan || "use_master_main",
    mainImageUrl: images[0]?.generatedUrl || images[0]?.sourceUrl || "",
    generated_image_url: images[0]?.generatedUrl || images[0]?.sourceUrl || "",
    images,
    validation: safeJson(row.validation_json, {}),
    status: row.status || "draft"
  };
}

function normalizeExportVersions(versions) {
  return versions.map((item) => item.payload || item).map((item) => ({
    shopId: item.shopId || item.shop_id,
    shopName: item.shopName || item.shop_name,
    offerId: item.offerId || item.offer_id,
    title: item.title,
    price: item.price,
    stock: item.stock || item.stock_quantity,
    imagePlan: item.imagePlan || item.image_plan,
    watermarkTemplateId: item.watermarkTemplateId || item.watermark_template_id,
    mainImageUrl: item.mainImageUrl || item.generated_image_url,
    description: item.description,
    images: Array.isArray(item.images) ? item.images : []
  }));
}

function validateVersion(version) {
  const errors = [];
  const warnings = [];
  if (!version.title) errors.push("缺失标题");
  if (!Number(version.price)) errors.push("缺失价格");
  if (!version.mainImageUrl) errors.push("缺失主图");
  if (!version.watermarkTemplateId) errors.push("缺失水印");
  if (!Number.isFinite(Number(version.stock))) warnings.push("库存不是有效数字");
  return { errors, warnings, level: errors.length ? "red" : warnings.length ? "yellow" : "green" };
}

function buildGeneratedImages(mainImageUrl, detailImages, watermarkTemplateId) {
  const images = [];
  if (mainImageUrl) images.push({ type: "main", sourceUrl: mainImageUrl, generatedUrl: mainImageUrl, watermarkTemplateId });
  for (const image of Array.isArray(detailImages) ? detailImages : []) {
    const url = typeof image === "string" ? image : image?.url || image?.sourceUrl || "";
    if (url) images.push({ type: "detail", sourceUrl: url, generatedUrl: url, watermarkTemplateId });
  }
  return images;
}

function buildOfferId(product, shopId) {
  const code = String(product.code || product.id || "P").replace(/[^a-z0-9_-]/gi, "").slice(0, 24);
  return `SHOP${shopId}-${code}-${Date.now().toString(36).toUpperCase()}`.slice(0, 128);
}

async function writePackageFile(filePath, content, files, packageDir) {
  await fs.writeFile(filePath, content || "", "utf8");
  files.push(path.relative(packageDir, filePath).replace(/\\/g, "/"));
}

async function materializeImage(imageUrl, outputPath, files, packageDir) {
  const url = String(imageUrl || "").trim();
  if (!url) {
    await writePackageFile(`${outputPath}.missing.txt`, "缺失图片", files, packageDir);
    return false;
  }
  try {
    const dataUrlMatch = url.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    if (dataUrlMatch) {
      await fs.writeFile(outputPath, Buffer.from(dataUrlMatch[1], "base64"));
      files.push(path.relative(packageDir, outputPath).replace(/\\/g, "/"));
      return true;
    }
    if (/^https?:\/\//i.test(url)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`图片下载失败 ${response.status}`);
      await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      files.push(path.relative(packageDir, outputPath).replace(/\\/g, "/"));
      return true;
    }
    const localPath = path.resolve(ROOT_DIR, url.replace(/^\/+/, ""));
    await fs.copyFile(localPath, outputPath);
    files.push(path.relative(packageDir, outputPath).replace(/\\/g, "/"));
    return true;
  } catch {
    await writePackageFile(`${outputPath}.url.txt`, url, files, packageDir);
    return false;
  }
}

function buildTags(version) {
  return [version.shopName, version.offerId, version.imagePlan].filter(Boolean).join(",");
}

function sanitizeFilename(value) {
  return String(value || "shop").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80);
}

function normalizeUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  if (/^(https?:|data:|blob:)/i.test(text)) return text;
  if (text.startsWith("/")) return text;
  return `/${text.replace(/^public[\\/]/, "").replace(/\\/g, "/")}`;
}

function safeJson(value, fallback) {
  try {
    if (!value) return fallback;
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function personId(session) {
  return session?.person_id || session?.personId || null;
}

async function loadWatermarkForShop(shop) {
  const rows = await mysqlQuery(`
    SELECT id, name, logo_url, logo_path, position, opacity, size_percent, margin_px, status
    FROM shop_watermark_templates
    WHERE id = ? AND status <> 'deleted'
    LIMIT 1
  `, [shop.watermark_template_id || 0]).catch(() => []);
  const template = rows[0] || null;
  if (template) {
    return {
      id: template.id,
      logoUrl: normalizeUrl(template.logo_url || template.logo_path || ""),
      logoPath: resolveLocalAssetPath(template.logo_path || template.logo_url || ""),
      position: template.position || "bottom-right",
      xPercent: Number(template.x_percent ?? 75),
      yPercent: Number(template.y_percent ?? 75),
      opacity: Number(template.opacity ?? 0.82),
      sizePercent: Number(template.size_percent || 22),
      margin: Number(template.margin_px || 24)
    };
  }
  return {
    id: `shop-${shop.id}`,
    logoUrl: normalizeUrl(shop.watermark_path || ""),
    logoPath: resolveLocalAssetPath(shop.watermark_path || ""),
    position: shop.watermark_position || "bottom-right",
    xPercent: Number(shop.watermark_x_percent ?? 75),
    yPercent: Number(shop.watermark_y_percent ?? 75),
    opacity: Number(shop.watermark_opacity_percent ?? 82) / 100,
    sizePercent: Number(shop.watermark_scale_percent ?? 22),
    margin: 24
  };
}

async function applyWatermarkWithSharp(sourceBuffer, watermark) {
  const base = sharp(sourceBuffer).rotate();
  const metadata = await base.metadata();
  const baseWidth = Number(metadata.width || 0);
  const baseHeight = Number(metadata.height || 0);
  if (!baseWidth || !baseHeight) throw new Error("无法识别主图尺寸");

  const watermarkBuffer = await readImageBuffer(watermark.logoPath || watermark.logoUrl);
  const watermarkWidth = Math.max(1, Math.round(baseWidth * Math.min(Math.max(Number(watermark.sizePercent || 22), 5), 60) / 100));
  const resizedWatermark = await sharp(watermarkBuffer)
    .resize({ width: watermarkWidth, withoutEnlargement: true })
    .ensureAlpha()
    .modulate({ brightness: 1 })
    .png()
    .toBuffer();
  const watermarkMeta = await sharp(resizedWatermark).metadata();
  const rect = watermarkRect({
    baseWidth,
    baseHeight,
    watermarkWidth: Number(watermarkMeta.width || watermarkWidth),
    watermarkHeight: Number(watermarkMeta.height || 1),
    position: watermark.position,
    margin: Number(watermark.margin || 24),
    xPercent: Number(watermark.xPercent ?? watermark.x_percent ?? 75),
    yPercent: Number(watermark.yPercent ?? watermark.y_percent ?? 75)
  });
  const opacity = Math.min(Math.max(Number(watermark.opacity ?? 0.82), 0.05), 1);
  const transparentWatermark = await sharp(resizedWatermark)
    .composite([{ input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: "dest-in" }])
    .png()
    .toBuffer();
  return base.composite([{ input: transparentWatermark, left: rect.left, top: rect.top }]);
}

function watermarkRect({ baseWidth, baseHeight, watermarkWidth, watermarkHeight, position, margin, xPercent = 75, yPercent = 75 }) {
  const safeMargin = Math.max(0, margin);
  let left = baseWidth - watermarkWidth - safeMargin;
  let top = baseHeight - watermarkHeight - safeMargin;
  if (position === "custom") {
    left = Math.round(baseWidth * Math.min(Math.max(Number(xPercent), 0), 100) / 100);
    top = Math.round(baseHeight * Math.min(Math.max(Number(yPercent), 0), 100) / 100);
  } else if (position === "top-left" || position === "left-top") {
    left = safeMargin;
    top = safeMargin;
  } else if (position === "top-right" || position === "right-top") {
    left = baseWidth - watermarkWidth - safeMargin;
    top = safeMargin;
  } else if (position === "bottom-left" || position === "left-bottom") {
    left = safeMargin;
    top = baseHeight - watermarkHeight - safeMargin;
  } else if (position === "bottom-center") {
    left = Math.round((baseWidth - watermarkWidth) / 2);
    top = baseHeight - watermarkHeight - safeMargin;
  }
  return {
    left: Math.max(0, Math.min(left, Math.max(0, baseWidth - watermarkWidth))),
    top: Math.max(0, Math.min(top, Math.max(0, baseHeight - watermarkHeight)))
  };
}

async function readImageBuffer(source) {
  const text = String(source || "").trim();
  if (!text) throw new Error("图片路径为空");
  const dataUrlMatch = text.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (dataUrlMatch) return Buffer.from(dataUrlMatch[1], "base64");
  if (/^https?:\/\//i.test(text)) {
    const response = await fetch(text);
    if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const localPath = resolveLocalAssetPath(text);
  if (!localPath) throw new Error("图片路径无效");
  return fs.readFile(localPath);
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

async function getTableColumns(tableName) {
  const safeName = String(tableName || "").replace(/[^a-zA-Z0-9_]/g, "");
  if (!safeName) return new Set();
  if (tableColumnsCache.has(safeName)) return tableColumnsCache.get(safeName);
  try {
    const rows = await mysqlQuery(`SHOW COLUMNS FROM \`${safeName}\``);
    const columns = new Set(rows.map((row) => row.Field));
    tableColumnsCache.set(safeName, columns);
    return columns;
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      const columns = new Set();
      tableColumnsCache.set(safeName, columns);
      return columns;
    }
    throw error;
  }
}

function productTextExpr(columns, candidates, fallbackSql) {
  const column = firstExistingColumn(columns, candidates);
  return column ? `COALESCE(p.\`${column}\`, ${fallbackSql})` : fallbackSql;
}

function productNumberExpr(columns, candidates, fallbackValue = 0) {
  const parts = candidates
    .filter((column) => columns.has(column))
    .map((column) => `NULLIF(p.\`${column}\`, 0)`);
  if (!parts.length) return String(Number(fallbackValue || 0));
  return `COALESCE(${parts.join(", ")}, ${Number(fallbackValue || 0)})`;
}

function firstExistingColumn(columns, candidates) {
  return candidates.find((column) => columns.has(column)) || "";
}

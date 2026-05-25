import { config } from "../config.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import {
  createOzonProductBySku,
  fetchOzonCategoryAttributeValues,
  fetchOzonCategoryAttributes,
  fetchOzonDescriptionCategoryTree,
  fetchOzonProductImportInfo,
  fetchOzonProductInfoAttributes,
  importOzonProducts,
  searchOzonCategoryAttributeValues
} from "../ozonClient.js";

let mysqlSchemaReady = false;
const LISTING_MEDIA_ROOT = path.resolve(process.cwd(), "public", "uploads", "listing-media");
const LISTING_MEDIA_MAX_BYTES = 200 * 1024 * 1024;
const LISTING_MEDIA_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"]
]);

export async function listingCategoryTemplates(session) {
  await ensureListingAutomationSchema();
  return all(`
    SELECT t.*, p.name AS created_by_name
    FROM listing_category_templates t
    LEFT JOIN people p ON p.id = t.created_by_person_id
    WHERE t.status <> 'deleted'
    ORDER BY t.updated_at DESC, t.id DESC
  `).then((rows) => rows.map(normalizeTemplateRow));
}

export async function listingCategoryTemplateDetail(id, session) {
  await ensureListingAutomationSchema();
  const template = await listingCategoryTemplate(id, session);
  if (!template) throw new Error("类目模板不存在");
  return template;
}

export async function listingCopyJobs(session) {
  await ensureListingAutomationSchema();
  return all(`
    SELECT j.*, s.name AS shop_name, p.name AS created_by_name
    FROM listing_ozon_copy_jobs j
    LEFT JOIN shops s ON s.id = j.shop_id
    LEFT JOIN people p ON p.id = j.created_by_person_id
    ORDER BY j.updated_at DESC, j.id DESC
    LIMIT 100
  `).then((rows) => rows.map(normalizeCopyJobRow));
}

export async function copyListingTemplateFromOzonSku(body, session) {
  await ensureListingAutomationSchema();
  const sku = Number(body?.sku || body?.ozon_sku || body?.ozonSku || 0);
  const shopId = Number(body?.shop_id || body?.shopId || 0);
  if (!Number.isFinite(sku) || sku <= 0) throw new Error("请输入 Ozon 前台 SKU");
  if (!shopId) throw new Error("请选择用于复制商品的店铺");

  const shop = await row("SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint FROM shops WHERE id = ? AND status <> 'deleted'", [shopId]);
  if (!shop) throw new Error("店铺不存在");

  const offerId = String(body?.offer_id || body?.offerId || `COPY-${sku}-${Date.now().toString(36)}`).slice(0, 128);
  const name = String(body?.name || body?.product_name || `Ozon SKU ${sku} 本地模板`).trim();
  const templateName = String(body?.template_name || body?.templateName || body?.local_template_name || body?.localTemplateName || `SKU ${sku} 模板`).trim();
  const price = Number(body?.price || body?.sale_price || 1);
  const requestPayload = {
    sku,
    name,
    offer_id: offerId,
    price,
    old_price: Number(body?.old_price || body?.oldPrice || price),
    currency_code: String(body?.currency_code || body?.currencyCode || "RUB"),
    vat: String(body?.vat || "0")
  };
  const editablePayload = buildEditableTemplatePayload({
    sku,
    name,
    price,
    categoryName: "",
    request: requestPayload
  });

  const response = await createOzonProductBySku(shop, requestPayload);
  const taskId = response?.result?.task_id || response?.task_id || response?.result?.taskId || null;

  const existingTemplate = await row(`
    SELECT id
    FROM listing_category_templates
    WHERE source_type = 'ozon_sku_copy'
      AND source_ozon_sku = ?
      AND status <> 'deleted'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `, [String(sku)]);
  let templateId = existingTemplate?.id || null;
  const sourceRawJson = JSON.stringify({
    request: requestPayload,
    response,
    duplicate_action: templateId ? "updated_existing" : "created"
  });

  if (templateId) {
    await run(`
      UPDATE listing_category_templates
      SET template_name = ?, source_shop_id = ?, source_raw_json = ?, editable_payload_json = ?,
          title = ?, description = ?, attributes_json = ?, images_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      templateName,
      shopId,
      sourceRawJson,
      JSON.stringify(editablePayload),
      editablePayload.title,
      editablePayload.description,
      JSON.stringify(editablePayload.attributes),
      JSON.stringify(editablePayload.images),
      templateId
    ]);
  } else {
    templateId = await insert(`
      INSERT INTO listing_category_templates
      (ozon_category_id, category_name, template_name, required_attributes_json, ai_rules_json, title_prompt,
       description_prompt, image_rules_json, source_type, source_ozon_sku, source_shop_id, source_raw_json,
       editable_payload_json, title, description, attributes_json, images_json,
       created_by_person_id, updated_at)
      VALUES (?, ?, ?, '[]', '{}', '', '', '{}', 'ozon_sku_copy', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      `pending:${sku}`,
      "",
      templateName,
      String(sku),
      shopId,
      sourceRawJson,
      JSON.stringify(editablePayload),
      editablePayload.title,
      editablePayload.description,
      JSON.stringify(editablePayload.attributes),
      JSON.stringify(editablePayload.images),
      personId(session)
    ]);
  }

  const jobId = await insert(`
    INSERT INTO listing_ozon_copy_jobs
    (shop_id, ozon_sku, offer_id, task_id, template_id, status, request_json, response_json, created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    shopId,
    String(sku),
    offerId,
    taskId ? String(taskId) : "",
    templateId,
    taskId ? "submitted" : "submitted_without_task",
    JSON.stringify(requestPayload),
    JSON.stringify(response),
    personId(session)
  ]);

  return {
    ok: true,
    reused: Boolean(existingTemplate?.id),
    job: await listingCopyJob(jobId),
    template: await listingCategoryTemplate(templateId, session)
  };
}

export async function refreshListingCopyJob(jobId) {
  await ensureListingAutomationSchema();
  const job = await listingCopyJob(jobId);
  if (!job) throw new Error("复制任务不存在");
  if (!job.task_id) return job;
  const shop = await row("SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint FROM shops WHERE id = ?", [job.shop_id]);
  if (!shop) throw new Error("店铺不存在");
  const response = await fetchOzonProductImportInfo(shop, job.task_id);
  const status = importStatus(response);
  const refs = extractImportedProductRefs(response, job);
  let productDetail = null;
  let categoryAttributes = [];
  let template = null;
  let detailError = null;
  if (status === "imported" && (refs.productIds.length || refs.offerIds.length)) {
    try {
      const details = await fetchOzonProductInfoAttributes(shop, {
        productIds: refs.productIds,
        offerIds: refs.offerIds
      });
      productDetail = Array.isArray(details) ? details[0] : null;
      if (productDetail && job.template_id) {
        categoryAttributes = await fetchOzonCategoryAttributesForProduct(shop, productDetail).catch(() => []);
        template = await applyOzonProductDetailToTemplate(job.template_id, productDetail, {
          importInfo: response,
          job,
          refs,
          categoryAttributes
        }, null);
      }
    } catch (error) {
      detailError = error;
    }
  }
  await mysqlExecute(`
    UPDATE listing_ozon_copy_jobs
    SET status = ?, response_json = ?, product_id = ?, product_detail_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    productDetail ? "template_synced" : status,
    JSON.stringify(response),
    refs.productIds[0] ? String(refs.productIds[0]) : "",
    productDetail ? JSON.stringify(productDetail) : (detailError ? JSON.stringify({ error: detailError.message }) : ""),
    Number(jobId)
  ]);
  return {
    job: await listingCopyJob(jobId),
    template: template || (job.template_id ? await listingCategoryTemplate(job.template_id, null) : null),
    product_detail: productDetail,
    category_attributes: categoryAttributes,
    detail_error: detailError ? detailError.message : ""
  };
}

export async function createListingCategoryTemplate(body, session) {
  await ensureListingAutomationSchema();
  const payload = normalizeTemplatePayload(body);
  if (!payload.ozon_category_id) throw new Error("Ozon 类目 ID 不能为空");
  if (!payload.category_name) throw new Error("类目名称不能为空");
  if (!payload.template_name) throw new Error("模板名称不能为空");

  const id = await insert(`
    INSERT INTO listing_category_templates
    (ozon_category_id, category_name, template_name, required_attributes_json, ai_rules_json, title_prompt,
     description_prompt, image_rules_json, editable_payload_json, title, description, attributes_json, images_json,
     created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    payload.ozon_category_id,
    payload.category_name,
    payload.template_name,
    JSON.stringify(payload.required_attributes),
    JSON.stringify(payload.ai_rules),
    payload.title_prompt,
    payload.description_prompt,
    JSON.stringify(payload.image_rules),
    JSON.stringify(payload.editable_payload),
    payload.title,
    payload.description,
    JSON.stringify(payload.attributes),
    JSON.stringify(payload.images),
    personId(session)
  ]);
  return listingCategoryTemplate(id, session);
}

export async function createListingTemplateFromCollectedProduct(body, session) {
  await ensureListingAutomationSchema();
  const payload = buildTemplatePayloadFromCollectedProduct(body || {});
  if (!payload.ozon_category_id) throw new Error("采集数据缺少类目 ID，请手动补充后再导入");
  const existingTemplate = payload.source_ozon_sku
    ? await row(`
      SELECT id
      FROM listing_category_templates
      WHERE source_type = 'ozon_frontend_collect'
        AND source_ozon_sku = ?
        AND status <> 'deleted'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `, [payload.source_ozon_sku])
    : null;

  if (existingTemplate?.id) {
    await updateListingCategoryTemplate(existingTemplate.id, payload, session);
    await mysqlExecute(`
      UPDATE listing_category_templates
      SET source_type = 'ozon_frontend_collect',
          source_ozon_sku = ?,
          source_raw_json = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [payload.source_ozon_sku, JSON.stringify(payload.source_raw), existingTemplate.id]);
    return {
      ok: true,
      reused: true,
      template: await listingCategoryTemplate(existingTemplate.id, session)
    };
  }

  const id = await insert(`
    INSERT INTO listing_category_templates
    (ozon_category_id, category_name, template_name, required_attributes_json, ai_rules_json, title_prompt,
     description_prompt, image_rules_json, source_type, source_ozon_sku, source_raw_json,
     editable_payload_json, title, description, attributes_json, images_json,
     created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, '', '', '{}', 'ozon_frontend_collect', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    payload.ozon_category_id,
    payload.category_name,
    payload.template_name,
    JSON.stringify(payload.required_attributes),
    JSON.stringify(payload.ai_rules),
    payload.source_ozon_sku,
    JSON.stringify(payload.source_raw),
    JSON.stringify(payload.editable_payload),
    payload.title,
    payload.description,
    JSON.stringify(payload.attributes),
    JSON.stringify(payload.images),
    personId(session)
  ]);

  return {
    ok: true,
    reused: false,
    template: await listingCategoryTemplate(id, session)
  };
}

export async function saveListingCollectedProductDetail(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const collectionId = String(body.id || body.collectionId || body.collection_id || `ozon_collect_${Date.now()}`).trim();
  const tenantId = String(body.tenant_id || body.tenantId || "admin").trim();
  const result = await createListingTemplateFromCollectedProduct(body, session).catch((error) => ({
    ok: false,
    error: error.message,
    template: null
  }));
  const templateId = result.template?.id || null;
  await mysqlExecute(`
    INSERT INTO listing_collected_product_details
    (id, tenant_id, platform, sku, title, template_id, payload_json, status, error_message, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      platform = VALUES(platform),
      sku = VALUES(sku),
      title = VALUES(title),
      template_id = VALUES(template_id),
      payload_json = VALUES(payload_json),
      status = VALUES(status),
      error_message = VALUES(error_message),
      updated_at = CURRENT_TIMESTAMP
  `, [
    collectionId,
    tenantId,
    String(body.platform || "Ozon"),
    String(body.sku || body.productId || body.product_id || ""),
    String(body.title || body.productTitle || body.name || ""),
    templateId,
    JSON.stringify(body),
    result.ok ? "template_created" : "saved_with_error",
    result.error || ""
  ]);
  return getListingCollectedProductDetail(collectionId, tenantId);
}

export async function getListingCollectedProductDetail(id, tenantId = "admin") {
  await ensureListingAutomationSchema();
  const detail = await row(`
    SELECT c.*, t.template_name, t.category_name, t.ozon_category_id
    FROM listing_collected_product_details c
    LEFT JOIN listing_category_templates t ON t.id = c.template_id
    WHERE c.id = ? AND c.tenant_id = ?
    LIMIT 1
  `, [String(id || ""), String(tenantId || "admin")]);
  if (!detail) return null;
  return {
    ...detail,
    collectionId: detail.id,
    payload: parseJson(detail.payload_json, {}),
    template: detail.template_id ? await listingCategoryTemplate(detail.template_id, null) : null
  };
}

export async function createListingTemplateFromCollectedProductId(id, session = null) {
  const detail = await getListingCollectedProductDetail(id, "admin");
  if (!detail) throw new Error("采集详情不存在");
  return createListingTemplateFromCollectedProduct(detail.payload, session);
}

export async function uploadListingMedia(req) {
  await ensureListingAutomationSchema();
  const file = await readListingMediaMultipart(req);
  const safeName = sanitizeListingMediaFilename(file.filename || "upload");
  const extension = path.extname(safeName).toLowerCase();
  const expectedContentType = LISTING_MEDIA_TYPES.get(extension);
  if (!expectedContentType) {
    const error = new Error("上架素材仅支持 jpg、jpeg、png、webp、mp4、mov、webm");
    error.status = 415;
    throw error;
  }
  if (!file.buffer?.length) {
    const error = new Error("上传文件为空");
    error.status = 400;
    throw error;
  }
  if (file.buffer.length > LISTING_MEDIA_MAX_BYTES) {
    const error = new Error("上架素材不能超过 200MB");
    error.status = 413;
    throw error;
  }

  await fs.mkdir(LISTING_MEDIA_ROOT, { recursive: true });
  const storedName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const filePath = path.join(LISTING_MEDIA_ROOT, storedName);
  await fs.writeFile(filePath, file.buffer);
  const url = `/uploads/listing-media/${storedName}`;
  const publishUrl = buildListingMediaPublishUrl(url);
  const asset = await registerListingMediaAsset({
    source_module: "listing_upload",
    media_type: expectedContentType.startsWith("video/") ? "video" : "image",
    role: expectedContentType.startsWith("video/") ? "video" : "image",
    local_path: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
    preview_url: url,
    publish_url: publishUrl || "",
    original_name: safeName,
    storage_name: storedName,
    mime_type: file.contentType || expectedContentType,
    file_size: file.buffer.length,
    hash_sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    status: publishUrl ? "public_ready" : "local_only",
    metadata: { upload: "listing_media" }
  });
  return {
    ok: true,
    assetId: asset.id,
    asset,
    url: publishUrl || url,
    localUrl: url,
    publishUrl: publishUrl || "",
    previewUrl: url,
    name: safeName,
    size: file.buffer.length,
    contentType: file.contentType || expectedContentType,
    mediaType: expectedContentType.startsWith("video/") ? "video" : "image"
  };
}

export async function listingMediaAssets(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  const rows = await all(`
    SELECT *
    FROM listing_media_assets
    WHERE status <> 'deleted'
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `, [limit]);
  return rows.map(normalizeListingMediaAssetRow);
}

export async function listingOzonCategories(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const keyword = String(query.keyword || query.q || "").trim();
  const limit = Math.min(Math.max(Number(query.limit || 80), 1), 300);
  const params = [];
  let where = "WHERE status = 'active'";
  if (keyword) {
    where += " AND (name_zh LIKE ? OR name_ru LIKE ? OR path_zh LIKE ? OR path_ru LIKE ? OR CAST(description_category_id AS CHAR) LIKE ? OR CAST(type_id AS CHAR) LIKE ?)";
    const like = `%${keyword}%`;
    params.push(like, like, like, like, like, like);
  }
  params.push(limit);
  const rows = await all(`
    SELECT *
    FROM ozon_category_mappings
    ${where}
    ORDER BY
      CASE WHEN name_zh = ? OR name_ru = ? THEN 0 ELSE 1 END,
      is_auto DESC,
      updated_at DESC,
      path_zh ASC,
      name_zh ASC
    LIMIT ?
  `, keyword ? [...params.slice(0, -1), keyword, keyword, limit] : [keyword, keyword, limit]);
  return rows.map(normalizeOzonCategoryRow);
}

export async function syncListingOzonCategories(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const shop = await resolveOzonApiShop(body.shop_id || body.shopId);
  const tree = await fetchOzonDescriptionCategoryTree(shop, { language: body.language || "ZH_HANS" });
  const rows = flattenOzonCategoryTree(tree);
  let saved = 0;
  for (const item of rows) {
    if (!item.descriptionCategoryId || !item.typeId) continue;
    await run(`
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
      item.descriptionCategoryId,
      item.typeId,
      item.nameRu,
      item.nameZh,
      item.pathRu,
      item.pathZh,
      item.parentDescriptionCategoryId,
      item.isAuto ? 1 : 0,
      shop.id,
      JSON.stringify(item.raw || {})
    ]);
    saved += 1;
  }
  return { ok: true, shopId: Number(shop.id), shopName: shop.name, saved };
}

export async function listingOzonCategoryAttributes(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const descriptionCategoryId = Number(query.description_category_id || query.descriptionCategoryId || 0);
  const typeId = Number(query.type_id || query.typeId || 0);
  if (!descriptionCategoryId || !typeId) return [];
  const rows = await all(`
    SELECT *
    FROM ozon_category_attributes
    WHERE description_category_id = ? AND type_id = ? AND status = 'active'
    ORDER BY is_required DESC, sort_order ASC, attribute_id ASC
  `, [descriptionCategoryId, typeId]);
  const attributes = rows.map(normalizeOzonCategoryAttributeRow);
  await attachCachedAttributeValues(attributes, descriptionCategoryId, typeId, Number(query.value_limit || query.valueLimit || 120));
  return attributes;
}

export async function syncListingOzonCategoryAttributes(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const descriptionCategoryId = Number(body.description_category_id || body.descriptionCategoryId || 0);
  const typeId = Number(body.type_id || body.typeId || 0);
  if (!descriptionCategoryId || !typeId) throw new Error("缺少 description_category_id/type_id，无法同步类目属性");
  const shop = await resolveOzonApiShop(body.shop_id || body.shopId);
  const attributes = await fetchOzonCategoryAttributes(shop, {
    descriptionCategoryId,
    typeId,
    language: body.language || "ZH_HANS"
  });
  let saved = 0;
  let valuesSaved = 0;
  for (const [index, item] of attributes.entries()) {
    const attributeId = Number(item.id || item.attribute_id || item.attributeId || 0);
    if (!attributeId) continue;
    await run(`
      INSERT INTO ozon_category_attributes
      (description_category_id, type_id, attribute_id, name, description, is_required, attribute_type,
       dictionary_id, is_collection, group_name, sort_order, source_shop_id, raw_json, status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        description = VALUES(description),
        is_required = VALUES(is_required),
        attribute_type = VALUES(attribute_type),
        dictionary_id = VALUES(dictionary_id),
        is_collection = VALUES(is_collection),
        group_name = VALUES(group_name),
        sort_order = VALUES(sort_order),
        source_shop_id = VALUES(source_shop_id),
        raw_json = VALUES(raw_json),
        status = 'active',
        synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `, [
      descriptionCategoryId,
      typeId,
      attributeId,
      String(item.name || item.attribute_name || "").trim(),
      String(item.description || item.hint || "").trim(),
      item.is_required || item.required ? 1 : 0,
      String(item.type || item.attribute_type || item.value_type || "String").trim(),
      Number(item.dictionary_id || item.dictionaryId || 0),
      item.is_collection || item.collection ? 1 : 0,
      String(item.group_name || item.group || "").trim(),
      Number(item.sort_order || item.order || index + 1),
      shop.id,
      JSON.stringify(item)
    ]);
    saved += 1;
    const dictionaryId = Number(item.dictionary_id || item.dictionaryId || 0);
    if (dictionaryId && (item.is_required || item.required || body.sync_values)) {
      const valueResult = await syncListingOzonAttributeValues({
        shop_id: shop.id,
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        attribute_id: attributeId,
        language: body.language || "ZH_HANS",
        limit: body.value_limit || 200
      }, session).catch(() => null);
      valuesSaved += Number(valueResult?.saved || 0);
    }
  }
  return {
    ok: true,
    shopId: Number(shop.id),
    shopName: shop.name,
    descriptionCategoryId,
    typeId,
    saved,
    values_saved: valuesSaved,
    attributes: await listingOzonCategoryAttributes({ description_category_id: descriptionCategoryId, type_id: typeId }, session)
  };
}

export async function listingOzonAttributeValues(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const descriptionCategoryId = Number(query.description_category_id || query.descriptionCategoryId || 0);
  const typeId = Number(query.type_id || query.typeId || 0);
  const attributeId = Number(query.attribute_id || query.attributeId || 0);
  const keyword = String(query.keyword || query.q || "").trim();
  if (!descriptionCategoryId || !typeId || !attributeId) return [];
  const params = [descriptionCategoryId, typeId, attributeId];
  let where = "WHERE description_category_id = ? AND type_id = ? AND attribute_id = ? AND status = 'active'";
  if (keyword) {
    where += " AND value LIKE ?";
    params.push(`%${keyword}%`);
  }
  params.push(Math.min(Math.max(Number(query.limit || 80), 1), 500));
  const rows = await all(`
    SELECT *
    FROM ozon_attribute_values
    ${where}
    ORDER BY value ASC, dictionary_value_id ASC
    LIMIT ?
  `, params);
  return rows.map(normalizeOzonAttributeValueRow);
}

export async function listingOzonCategorySyncJobs(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 200);
  const rows = await all(`
    SELECT j.*, s.name AS shop_name
    FROM ozon_category_sync_jobs j
    LEFT JOIN shops s ON s.id = j.shop_id
    ORDER BY j.started_at DESC, j.id DESC
    LIMIT ?
  `, [limit]);
  return rows.map(normalizeOzonCategorySyncJobRow);
}

export async function refreshOzonCategoryCache(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const mode = String(body.mode || "scheduled").trim();
  const shop = await resolveOzonApiShop(body.shop_id || body.shopId);
  const jobId = await startOzonCategorySyncJob({
    jobType: mode,
    shopId: shop.id,
    payload: body,
    session
  });
  const stats = {
    categories: 0,
    categoriesFailed: 0,
    attributes: 0,
    attributesFailed: 0,
    values: 0,
    valuesFailed: 0,
    usedCategoryCount: 0
  };
  try {
    const categoryResult = await syncListingOzonCategories({ shop_id: shop.id, language: body.language || "ZH_HANS" }, session);
    stats.categories = Number(categoryResult.saved || 0);

    const usedCategories = await usedOzonCategoriesForSync(body);
    stats.usedCategoryCount = usedCategories.length;
    for (const category of usedCategories) {
      try {
        const attrResult = await syncListingOzonCategoryAttributes({
          shop_id: shop.id,
          description_category_id: category.descriptionCategoryId,
          type_id: category.typeId,
          language: body.language || "ZH_HANS",
          sync_values: true,
          value_limit: body.value_limit || 200
        }, session);
        stats.attributes += Number(attrResult.saved || 0);
        stats.values += Number(attrResult.values_saved || 0);
      } catch (error) {
        stats.attributesFailed += 1;
        await appendOzonCategorySyncJobWarning(jobId, {
          category,
          message: error.message
        });
      }
    }
    await finishOzonCategorySyncJob(jobId, "success", stats);
    return { ok: true, jobId, shopId: Number(shop.id), shopName: shop.name, ...stats };
  } catch (error) {
    await finishOzonCategorySyncJob(jobId, "failed", stats, error);
    throw error;
  }
}

export async function syncListingOzonAttributeValues(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const descriptionCategoryId = Number(body.description_category_id || body.descriptionCategoryId || 0);
  const typeId = Number(body.type_id || body.typeId || 0);
  const attributeId = Number(body.attribute_id || body.attributeId || 0);
  if (!descriptionCategoryId || !typeId || !attributeId) throw new Error("缺少类目或属性 ID，无法同步属性值");
  const shop = await resolveOzonApiShop(body.shop_id || body.shopId);
  const keyword = String(body.keyword || body.value || "").trim();
  const values = keyword
    ? await searchOzonCategoryAttributeValues(shop, { descriptionCategoryId, typeId, attributeId, value: keyword, language: body.language || "ZH_HANS", limit: body.limit || 80 })
    : await fetchOzonCategoryAttributeValues(shop, { descriptionCategoryId, typeId, attributeId, language: body.language || "ZH_HANS", limit: body.limit || 1000 });
  let saved = 0;
  for (const item of values) {
    const dictionaryValueId = Number(item.id || item.dictionary_value_id || item.value_id || 0);
    const value = String(item.value || item.name || item.title || "").trim();
    if (!dictionaryValueId && !value) continue;
    await run(`
      INSERT INTO ozon_attribute_values
      (description_category_id, type_id, attribute_id, dictionary_value_id, value, info, source_shop_id, raw_json, status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        info = VALUES(info),
        source_shop_id = VALUES(source_shop_id),
        raw_json = VALUES(raw_json),
        status = 'active',
        synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `, [
      descriptionCategoryId,
      typeId,
      attributeId,
      dictionaryValueId,
      value,
      String(item.info || item.description || "").trim(),
      shop.id,
      JSON.stringify(item)
    ]);
    saved += 1;
  }
  return {
    ok: true,
    shopId: Number(shop.id),
    shopName: shop.name,
    descriptionCategoryId,
    typeId,
    attributeId,
    saved,
    values: await listingOzonAttributeValues({ description_category_id: descriptionCategoryId, type_id: typeId, attribute_id: attributeId, limit: body.limit || 80 }, session)
  };
}

export async function registerListingMediaAssetFromFile(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const sourcePath = path.resolve(String(body.filePath || body.file_path || ""));
  const buffer = await fs.readFile(sourcePath);
  const extension = path.extname(sourcePath).toLowerCase() || ".jpg";
  const contentType = body.mime_type || LISTING_MEDIA_TYPES.get(extension) || mimeTypeForListingMediaExtension(extension);
  const role = sanitizeListingMediaFilename(body.role || "asset").replace(/\.[^.]+$/, "").slice(0, 32) || "asset";
  const sourceName = sanitizeListingMediaFilename(body.original_name || path.basename(sourcePath));
  await fs.mkdir(LISTING_MEDIA_ROOT, { recursive: true });
  const storedName = `${Date.now()}-${crypto.randomUUID()}-${role}${extension}`;
  const targetPath = path.join(LISTING_MEDIA_ROOT, storedName);
  await fs.copyFile(sourcePath, targetPath);
  const url = `/uploads/listing-media/${storedName}`;
  const publishUrl = buildListingMediaPublishUrl(url);
  return registerListingMediaAsset({
    ...body,
    media_type: body.media_type || (String(contentType).startsWith("video/") ? "video" : "image"),
    role,
    local_path: path.relative(process.cwd(), targetPath).replace(/\\/g, "/"),
    source_path: path.relative(process.cwd(), sourcePath).replace(/\\/g, "/"),
    preview_url: url,
    publish_url: publishUrl || "",
    original_name: sourceName,
    storage_name: storedName,
    mime_type: contentType,
    file_size: buffer.length,
    hash_sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    status: publishUrl ? "public_ready" : "local_only"
  }, session);
}

export async function registerListingMediaAsset(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const payload = normalizeListingMediaAssetPayload(body, session);
  const id = await insert(`
    INSERT INTO listing_media_assets
    (source_module, source_id, batch_id, shop_id, template_id, variant_id, media_type, role,
     local_path, source_path, preview_url, publish_url, original_name, storage_name, mime_type,
     file_size, width, height, hash_sha256, sort_order, status, metadata_json, created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    payload.source_module,
    payload.source_id,
    payload.batch_id,
    payload.shop_id,
    payload.template_id,
    payload.variant_id,
    payload.media_type,
    payload.role,
    payload.local_path,
    payload.source_path,
    payload.preview_url,
    payload.publish_url,
    payload.original_name,
    payload.storage_name,
    payload.mime_type,
    payload.file_size,
    payload.width,
    payload.height,
    payload.hash_sha256,
    payload.sort_order,
    payload.status,
    JSON.stringify(payload.metadata),
    personId(session)
  ]);
  return normalizeListingMediaAssetRow({ id, ...payload, metadata_json: JSON.stringify(payload.metadata) });
}

export async function validateListingTemplatePublish(body = {}, session = null) {
  const template = body.template || body;
  const editable = normalizeEditablePayload(template.editable_payload || template.editablePayload || {});
  const attributes = normalizeAttributes(template.attributes || editable.attributes || []);
  const images = normalizeImages(template.images || editable.images || []).map((image) => ({
    ...image,
    url: publishableListingMediaUrl(image.url)
  }));
  const variants = normalizeArray(editable.variants || template.variants || []).map(normalizeVariantMediaForPublish);
  const facts = {
    title: String(template.title || editable.title || template.template_name || "").trim(),
    categoryId: String(template.ozon_category_id || editable.category_id || "").trim(),
    descriptionCategoryId: String(editable.description_category_id || template.description_category_id || "").trim(),
    typeId: String(editable.type_id || template.type_id || "").trim(),
    price: objectValue(editable.price || {}),
    dimensions: objectValue(editable.dimensions || {}),
    richContent: normalizeRichContentMediaForPublish(editable.rich_content_json || editable.rich_content || ""),
    attributes,
    images,
    variants
  };
  const errors = [];
  const warnings = [];
  if (!facts.title) errors.push("缺少标题");
  if (!facts.categoryId || facts.categoryId.startsWith("pending:") || facts.categoryId.startsWith("sku:")) errors.push("缺少真实 Ozon 类目");
  if (!facts.descriptionCategoryId || !facts.typeId) errors.push("缺少 Ozon 后台 description_category_id/type_id");
  if (!numberFromOzonValue(facts.price.value || facts.price.price)) errors.push("缺少售价");
  if (!numberFromOzonValue(facts.dimensions.weight_g)) errors.push("缺少包装重量");
  if (!numberFromOzonValue(facts.dimensions.length_cm) || !numberFromOzonValue(facts.dimensions.width_cm) || !numberFromOzonValue(facts.dimensions.height_cm)) {
    errors.push("缺少包装长宽高");
  }
  if (!images.length && !variants.some((item) => normalizeImages(item.images || []).length)) errors.push("缺少商品图片");
  const missingRequired = attributes.filter((item) => item.required && !normalizeAttributeValue(item.value));
  for (const item of missingRequired.slice(0, 20)) errors.push(`缺少必填属性：${item.name || item.attribute_id}`);
  const localMedia = [
    ...images.map((item) => item.url),
    ...variants.flatMap((item) => normalizeImages(item.images || []).map((image) => image.url)),
    ...variants.flatMap((item) => normalizeStringList(item.video_urls || item.videos || item.video_url)),
    ...variants.flatMap((item) => normalizeStringList(item.video_cover_urls || item.cover_video_urls || item.video_cover))
  ].filter(isLocalImportMedia);
  if (localMedia.length) warnings.push("存在本地素材 URL，正式提交 Ozon 前需要转换为公网可访问地址或上传到 Ozon 支持的素材地址");

  const payload = buildOzonImportPreviewPayload(facts, template);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    missing_required_attributes: missingRequired,
    payload,
    payload_note: "这是按当前模板生成的 Ozon product/import 预览结构，正式提交前仍需按店铺、offer_id、媒体公网地址和 Ozon 类目属性校验补齐。"
  };
}

export async function publishListingTemplateToOzon(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const shopIds = [...new Set((body.shop_ids || body.shopIds || body.template?.shop_ids || []).map(Number).filter(Boolean))];
  if (!shopIds.length) throw new Error("请至少选择一个上架店铺");

  const validation = await validateListingTemplatePublish(body.template || body, session);
  const localMedia = collectLocalImportMedia(validation.payload);
  if (localMedia.length) {
    validation.errors.push("正式提交 Ozon 前需要先把图片/视频转为公网 URL，本地 /uploads 地址无法被 Ozon 拉取");
    validation.ok = false;
  }
  if (!validation.ok) {
    const error = new Error(validation.errors[0] || "发布前校验未通过");
    error.status = 400;
    error.validation = validation;
    throw error;
  }

  const shops = await all(
    `SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint FROM shops WHERE id IN (${shopIds.map(() => "?").join(",")}) AND status <> 'deleted'`,
    shopIds
  );
  if (!shops.length) throw new Error("没有可用的目标店铺");

  const results = [];
  for (const shop of shops) {
    let recordId = null;
    try {
      recordId = await insert(`
        INSERT INTO listing_publish_records
        (draft_id, shop_id, offer_id, status, request_json, created_by_person_id, updated_at)
        VALUES (0, ?, ?, 'submitted', ?, ?, CURRENT_TIMESTAMP)
      `, [
        shop.id,
        firstOfferId(validation.payload),
        JSON.stringify(validation.payload),
        personId(session)
      ]);
      const response = await importOzonProducts(shop, validation.payload);
      const taskId = response?.result?.task_id || response?.task_id || response?.result?.taskId || "";
      let importInfo = null;
      if (taskId) {
        importInfo = await fetchOzonProductImportInfo(shop, taskId).catch((error) => ({ error: error.message }));
      }
      await updatePublishRecordAfterSubmit(recordId, {
        taskId,
        response,
        importInfo,
        status: importInfo?.error ? "submitted" : importInfoStatus(importInfo)
      });
      results.push({
        record_id: recordId,
        shop_id: shop.id,
        shop_name: shop.name,
        ok: true,
        task_id: taskId,
        response,
        import_info: importInfo
      });
    } catch (error) {
      if (recordId) {
        await run(`
          UPDATE listing_publish_records
          SET status = 'failed', error_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [JSON.stringify({ message: error.message }), recordId]).catch(() => null);
      }
      results.push({
        record_id: recordId,
        shop_id: shop.id,
        shop_name: shop.name,
        ok: false,
        error: error.message
      });
    }
  }

  return {
    ok: results.some((item) => item.ok),
    validation,
    results
  };
}

export async function listingPublishRecords(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const limit = Math.min(Math.max(Number(query.limit || 80), 1), 300);
  const rows = await all(`
    SELECT r.*, s.name AS shop_name
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    ORDER BY r.updated_at DESC, r.id DESC
    LIMIT ?
  `, [limit]);
  return rows.map(normalizePublishRecordRow);
}

export async function refreshListingPublishRecord(id, session = null) {
  await ensureListingAutomationSchema();
  const record = await row(`
    SELECT r.*, s.name AS shop_name, s.ozon_client_id, COALESCE(NULLIF(s.ozon_api_key, ''), s.api_key_hint) AS api_key_hint
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  if (!record) throw new Error("发布记录不存在");
  if (!record.task_id) return normalizePublishRecordRow(record);
  const importInfo = await fetchOzonProductImportInfo(record, record.task_id);
  await updatePublishRecordAfterSubmit(Number(id), {
    taskId: record.task_id,
    response: parseJson(record.response_json, {}),
    importInfo,
    status: importInfoStatus(importInfo)
  });
  const updated = await row(`
    SELECT r.*, s.name AS shop_name
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  return normalizePublishRecordRow(updated);
}

export async function updateListingCategoryTemplate(id, body, session) {
  await ensureListingAutomationSchema();
  const current = await listingCategoryTemplate(id, session);
  if (!current) throw new Error("类目模板不存在");

  const payload = normalizeTemplateUpdatePayload(body, current);
  await mysqlExecute(`
    UPDATE listing_category_templates
    SET ozon_category_id = ?, category_name = ?, template_name = ?, required_attributes_json = ?,
        ai_rules_json = ?, title_prompt = ?, description_prompt = ?, image_rules_json = ?,
        editable_payload_json = ?, title = ?, description = ?, attributes_json = ?, images_json = ?,
        source_raw_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status <> 'deleted'
  `, [
    payload.ozon_category_id,
    payload.category_name,
    payload.template_name,
    JSON.stringify(payload.required_attributes),
    JSON.stringify(payload.ai_rules),
    payload.title_prompt,
    payload.description_prompt,
    JSON.stringify(payload.image_rules),
    JSON.stringify(payload.editable_payload),
    payload.title,
    payload.description,
    JSON.stringify(payload.attributes),
    JSON.stringify(payload.images),
    JSON.stringify(payload.source_raw),
    Number(id)
  ]);

  return listingCategoryTemplate(id, session);
}

export async function listingDrafts(query = {}, session) {
  await ensureListingAutomationSchema();
  return all(`
    SELECT d.*, t.category_name, t.template_name, t.ozon_category_id, p.name AS created_by_name,
      (SELECT COUNT(*) FROM listing_shop_copies c WHERE c.draft_id = d.id) AS shop_copy_count
    FROM listing_drafts d
    LEFT JOIN listing_category_templates t ON t.id = d.template_id
    LEFT JOIN people p ON p.id = d.created_by_person_id
    WHERE d.status <> 'deleted'
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT 100
  `).then((rows) => rows.map(normalizeDraftRow));
}

export async function createListingDraft(body, session) {
  await ensureListingAutomationSchema();
  const payload = normalizeDraftPayload(body);
  if (!payload.template_id) throw new Error("请先选择类目模板");
  if (!payload.product_name) throw new Error("商品名称不能为空");

  const template = await row("SELECT * FROM listing_category_templates WHERE id = ? AND status <> 'deleted'", [payload.template_id]);
  if (!template) throw new Error("类目模板不存在");
  const normalizedTemplate = normalizeTemplateRow(template);
  const manualFacts = {
    ...(normalizedTemplate.editable_payload || {}),
    attributes: normalizedTemplate.attributes || [],
    images: normalizedTemplate.images || [],
    user_facts: payload.manual_facts
  };

  const id = await insert(`
    INSERT INTO listing_drafts
    (template_id, product_name, internal_code, source_urls_json, source_images_json, cost_price, sale_price,
     length_cm, width_cm, height_cm, weight_g, color, spec, quantity, manual_facts_json, created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    payload.template_id,
    payload.product_name,
    payload.internal_code,
    JSON.stringify(payload.source_urls),
    JSON.stringify(payload.source_images),
    payload.cost_price,
    payload.sale_price,
    payload.length_cm,
    payload.width_cm,
    payload.height_cm,
    payload.weight_g,
    payload.color,
    payload.spec,
    payload.quantity,
    JSON.stringify(manualFacts),
    personId(session)
  ]);
  return listingDraft(id, session);
}

export async function generateListingShopCopies(draftId, body, session) {
  await ensureListingAutomationSchema();
  const draft = await assertDraftAccess(draftId, session);
  const shopIds = [...new Set((body?.shop_ids || body?.shopIds || []).map((id) => Number(id)).filter(Boolean))];
  if (!shopIds.length) throw new Error("请至少选择一个店铺");

  const shops = await all(
    `SELECT id, name, watermark_path FROM shops WHERE id IN (${shopIds.map(() => "?").join(",")}) AND status <> 'deleted'`,
    shopIds
  );
  if (!shops.length) throw new Error("没有可用店铺");

  const copies = shops.map((shop) => buildShopCopy(draft, shop, session));
  await withMysqlTransaction(async (connection) => {
    for (const copy of copies) {
      await connection.execute(`
        INSERT INTO listing_shop_copies
        (draft_id, shop_id, offer_id, title, price, stock_quantity, watermark_path, images_json, validation_json,
         status, created_by_person_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          offer_id = VALUES(offer_id),
          title = VALUES(title),
          price = VALUES(price),
          stock_quantity = VALUES(stock_quantity),
          watermark_path = VALUES(watermark_path),
          images_json = VALUES(images_json),
          validation_json = VALUES(validation_json),
          status = VALUES(status),
          updated_at = CURRENT_TIMESTAMP
      `, copy);
    }
    await connection.execute("UPDATE listing_drafts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [draft.id]);
  });

  return listingShopCopies(draft.id, session);
}

export async function listingShopCopies(draftId, session) {
  await ensureListingAutomationSchema();
  await assertDraftAccess(draftId, session);
  return all(`
    SELECT c.*, s.name AS shop_name
    FROM listing_shop_copies c
    LEFT JOIN shops s ON s.id = c.shop_id
    WHERE c.draft_id = ?
    ORDER BY c.updated_at DESC, c.id DESC
  `, [Number(draftId)]).then((rows) => rows.map((item) => ({
    ...item,
    images: parseJson(item.images_json, []),
    validation: parseJson(item.validation_json, {})
  })));
}

async function listingCategoryTemplate(id, session) {
  const template = await row(`
    SELECT t.*, p.name AS created_by_name
    FROM listing_category_templates t
    LEFT JOIN people p ON p.id = t.created_by_person_id
    WHERE t.id = ?
  `, [id]);
  return template ? normalizeTemplateRow(template) : null;
}

async function listingCopyJob(id) {
  const job = await row(`
    SELECT j.*, s.name AS shop_name, p.name AS created_by_name
    FROM listing_ozon_copy_jobs j
    LEFT JOIN shops s ON s.id = j.shop_id
    LEFT JOIN people p ON p.id = j.created_by_person_id
    WHERE j.id = ?
  `, [Number(id)]);
  return job ? normalizeCopyJobRow(job) : null;
}

async function applyOzonProductDetailToTemplate(templateId, detail, context = {}, session) {
  const current = await listingCategoryTemplate(templateId, session);
  if (!current) return null;
  const parsed = parseOzonProductDetail(detail, current);
  const mergedAttributes = mergeCategoryAttributeDefinitions(parsed.attributes, context.categoryAttributes || []);
  const sourceRaw = {
    ...(current.source_raw || {}),
    import_info: context.importInfo || null,
    product_detail: detail,
    category_attributes: context.categoryAttributes || [],
    product_refs: context.refs || null
  };
  const editablePayload = {
    ...(current.editable_payload || {}),
    ...parsed.editable_payload,
    attributes: mergedAttributes,
    source_raw: sourceRaw
  };
  console.info("Ozon copy detail parsed", {
    templateId,
    category: parsed.category_name || parsed.ozon_category_id,
    attributes: mergedAttributes.length,
    images: parsed.images.length,
    variants: parsed.editable_payload?.variants?.length || 0,
    dimensions: parsed.editable_payload?.dimensions || {}
  });
  await mysqlExecute(`
    UPDATE listing_category_templates
    SET ozon_category_id = ?, category_name = ?, template_name = ?, editable_payload_json = ?,
        title = ?, description = ?, attributes_json = ?, images_json = ?, source_raw_json = ?, category_attributes_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status <> 'deleted'
  `, [
    parsed.ozon_category_id || current.ozon_category_id,
    parsed.category_name || current.category_name,
    parsed.template_name || current.template_name,
    JSON.stringify(editablePayload),
    parsed.title || current.title,
    parsed.description ?? current.description,
    JSON.stringify(mergedAttributes.length ? mergedAttributes : current.attributes),
    JSON.stringify(parsed.images.length ? parsed.images : current.images),
    JSON.stringify(sourceRaw),
    JSON.stringify(context.categoryAttributes || []),
    Number(templateId)
  ]);
  return listingCategoryTemplate(templateId, session);
}

async function fetchOzonCategoryAttributesForProduct(shop, detail = {}) {
  const descriptionCategoryId = Number(detail.description_category_id || detail.descriptionCategoryId || 0);
  const typeId = Number(detail.type_id || detail.typeId || 0);
  const categoryId = Number(detail.category_id || 0);
  return fetchOzonCategoryAttributes(shop, {
    descriptionCategoryId,
    typeId,
    categoryId
  });
}

function extractImportedProductRefs(response, job = {}) {
  const result = response?.result || response || {};
  const items = normalizeArray(result.items || result.products || result.product_info || result);
  const productIds = [];
  const offerIds = [];
  for (const item of items) {
    const productId = Number(item?.product_id || item?.id || item?.productId || 0);
    const offerId = String(item?.offer_id || item?.offerId || "").trim();
    const status = String(item?.status || result.status || "").toLowerCase();
    if (productId && (!status || status.includes("import") || status.includes("success") || status.includes("done"))) productIds.push(productId);
    if (offerId) offerIds.push(offerId);
  }
  if (job.offer_id) offerIds.push(String(job.offer_id));
  return {
    productIds: [...new Set(productIds)],
    offerIds: [...new Set(offerIds.filter(Boolean))]
  };
}

function parseOzonProductDetail(detail = {}, current = {}) {
  const source = unwrapOzonProductDetail(detail);
  const descriptionCategoryId = String(source.description_category_id || source.descriptionCategoryId || "").trim();
  const typeId = String(source.type_id || source.typeId || "").trim();
  const legacyCategoryId = String(source.category_id || source.categoryId || "").trim();
  const categoryId = buildOzonCategoryKey({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    category_id: legacyCategoryId,
    fallback: current.ozon_category_id
  });
  const categoryName = String(source.category_name || source.description_category_name || source.type_name || source.category || (categoryId ? `Ozon 类目 ${categoryId}` : current.category_name || "")).trim();
  const title = String(source.name || source.name_ru || current.title || current.template_name || "").trim();
  const images = extractImageUrls(source).map((url, index) => ({ url, sort_order: index + 1 }));
  const attributes = normalizeOzonDetailAttributes(source.attributes || source.attribute_values || source.characteristics || []);
  const dimensions = extractOzonDimensions(source, attributes);
  const brandValue = attributeValueByNames(attributes, ["品牌", "Бренд"], [85]);
  const colorValue = attributeValueByNames(attributes, ["颜色", "Цвет"], [8229]);
  const modelValue = attributeValueByNames(attributes, ["型号", "Модель"], [9048]);
  const tagsValue = attributeValueByNames(attributes, ["主图标签", "ключевые слова", "тег"], [10096]);
  const descriptionText = extractOzonDescriptionText(source, attributes, current);
  const richContent = extractOzonRichContent(source, attributes);
  const enrichedAttributes = enrichTemplateAttributes(attributes, {
    title,
    brand: brandValue || "无品牌",
    model: modelValue,
    tags: tagsValue,
    description: descriptionText,
    richJson: richContent.text
  });
  const variantSources = normalizeArray(source.sources || source.skus || source.variants);
  const variants = (variantSources.length ? variantSources : [source]).map((item, index) => ({
    sku: String(item.sku || item.fbo_sku || item.fbs_sku || source.sku || "").trim(),
    source_sku: String(item.sku || item.fbo_sku || item.fbs_sku || source.sku || "").trim(),
    source_offer_id: String(item.offer_id || source.offer_id || "").trim(),
    offer_id: "",
    name: item.name || item.title || title,
    title: item.name || item.title || title,
    images: extractImageUrls(item).length ? extractImageUrls(item).map((url, imageIndex) => ({ url, sort_order: imageIndex + 1 })) : images,
    barcode: String(normalizeArray(source.barcodes || source.barcode || item.barcode || item.barcodes)[0] || "").trim(),
    cost_price: 0,
    price: numberFromOzonValue(item.price || source.price || source.marketing_price || 0),
    old_price: numberFromOzonValue(item.old_price || source.old_price || 0),
    color: colorValue,
    spec: modelValue,
    main_tags: splitTagValue(tagsValue),
    weight_g: dimensions.weight_g || 0,
    length_mm: dimensions.length_cm || 0,
    width_mm: dimensions.width_cm || 0,
    height_mm: dimensions.height_cm || 0,
    stock: 0,
    sort_order: index + 1
  }));
  return {
    ozon_category_id: categoryId,
    category_name: categoryName,
    template_name: title,
    title,
    description: descriptionText,
    images,
    attributes: enrichedAttributes,
    editable_payload: {
      sku: String(source.sku || current.source_ozon_sku || ""),
      product_id: String(source.id || source.product_id || ""),
      offer_id: String(source.offer_id || ""),
      title,
      description: descriptionText,
      rich_content: richContent.value,
      rich_content_json: richContent.text,
      category_id: categoryId,
      legacy_category_id: legacyCategoryId,
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      category_name: categoryName,
      price: {
        value: numberFromOzonValue(source.price || source.marketing_price || 0),
        old_price: numberFromOzonValue(source.old_price || 0),
        currency_code: source.currency_code || source.currency || "RUB",
        vat: source.vat || "0"
      },
      dimensions,
      logistics: {
        brand: brandValue || "无品牌",
        color: colorValue,
        spec: modelValue,
        tags: splitTagValue(tagsValue),
        quantity: 0
      },
      images,
      attributes: enrichedAttributes,
      variants
    }
  };
}

async function listingDraft(id, session) {
  const draft = await assertDraftAccess(id, session);
  return normalizeDraftRow(draft);
}

async function assertDraftAccess(draftId, session) {
  const draft = await row(`
    SELECT d.*, t.category_name, t.template_name, t.ozon_category_id, p.name AS created_by_name
    FROM listing_drafts d
    LEFT JOIN listing_category_templates t ON t.id = d.template_id
    LEFT JOIN people p ON p.id = d.created_by_person_id
    WHERE d.id = ? AND d.status <> 'deleted'
  `, [Number(draftId)]);
  if (!draft) throw new Error("上架草稿不存在");
  return normalizeDraftRow(draft);
}

function buildShopCopy(draft, shop, session) {
  const prefix = String(shop.name || `SHOP${shop.id}`).replace(/\s+/g, "").slice(0, 8).toUpperCase();
  const code = draft.internal_code || `DRAFT${draft.id}`;
  const offerId = `${prefix}-${code}`.replace(/[^A-Z0-9_-]/gi, "-").slice(0, 64);
  const images = (draft.source_images || []).map((url, index) => ({
    source_url: url,
    generated_url: url,
    watermark_path: shop.watermark_path || "",
    status: shop.watermark_path ? "watermark_pending" : "missing_watermark",
    sort_order: index + 1
  }));
  const validation = validateShopCopy(draft, shop, images);
  return [
    draft.id,
    shop.id,
    offerId,
    draft.product_name,
    Number(draft.sale_price || 0),
    Number(draft.quantity || 0),
    shop.watermark_path || "",
    JSON.stringify(images),
    JSON.stringify(validation),
    validation.blocked ? "blocked" : "prepared",
    personId(session)
  ];
}

function validateShopCopy(draft, shop, images) {
  const errors = [];
  const warnings = [];
  if (!shop.watermark_path) warnings.push("店铺还没有绑定水印，后续无法生成专属图片");
  if (!images.length) errors.push("缺少商品图片");
  if (!Number(draft.sale_price || 0)) warnings.push("未填写售价");
  if (!Number(draft.weight_g || 0)) errors.push("缺少重量");
  if (!Number(draft.length_cm || 0) || !Number(draft.width_cm || 0) || !Number(draft.height_cm || 0)) errors.push("缺少尺寸");
  if (!draft.color) warnings.push("未填写颜色");
  if (!draft.spec) warnings.push("未填写规格");
  return {
    blocked: errors.length > 0,
    level: errors.length ? "red" : warnings.length ? "yellow" : "green",
    errors,
    warnings
  };
}

export async function ensureListingAutomationSchema() {
  if (config.dbClient !== "mysql") throw new Error("多店铺上架自动化仅支持 MySQL 模式");
  if (mysqlSchemaReady) return;
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS listing_category_templates (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        ozon_category_id VARCHAR(128) NOT NULL,
        category_name VARCHAR(255) NOT NULL,
        template_name VARCHAR(255) NOT NULL,
        required_attributes_json LONGTEXT NOT NULL,
        ai_rules_json LONGTEXT NOT NULL,
        title_prompt TEXT NOT NULL,
        description_prompt TEXT NOT NULL,
        image_rules_json LONGTEXT NOT NULL,
        source_type VARCHAR(64) NOT NULL DEFAULT 'manual',
        source_ozon_sku VARCHAR(128) NOT NULL DEFAULT '',
        source_shop_id BIGINT NULL,
        source_raw_json LONGTEXT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        created_by_person_id BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_listing_templates_category (ozon_category_id, status)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await ensureMysqlColumn("listing_category_templates", "source_type", "VARCHAR(64) NOT NULL DEFAULT 'manual'");
    await ensureMysqlColumn("listing_category_templates", "source_ozon_sku", "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureMysqlColumn("listing_category_templates", "source_shop_id", "BIGINT NULL");
    await ensureMysqlColumn("listing_category_templates", "source_raw_json", "LONGTEXT NULL");
    await ensureMysqlColumn("listing_category_templates", "editable_payload_json", "LONGTEXT NULL");
    await ensureMysqlColumn("listing_category_templates", "title", "VARCHAR(500) NOT NULL DEFAULT ''");
    await ensureMysqlColumn("listing_category_templates", "description", "LONGTEXT NULL");
    await ensureMysqlColumn("listing_category_templates", "attributes_json", "LONGTEXT NULL");
    await ensureMysqlColumn("listing_category_templates", "images_json", "LONGTEXT NULL");
    await ensureMysqlColumn("listing_category_templates", "category_attributes_json", "LONGTEXT NULL");
    await ensureMysqlColumn("shops", "ozon_api_key", "TEXT NULL");
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
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS ozon_category_attributes (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        description_category_id BIGINT NOT NULL,
        type_id BIGINT NOT NULL,
        attribute_id BIGINT NOT NULL,
        name VARCHAR(500) NOT NULL DEFAULT '',
        description TEXT NULL,
        is_required TINYINT(1) NOT NULL DEFAULT 0,
        attribute_type VARCHAR(128) NOT NULL DEFAULT '',
        dictionary_id BIGINT NOT NULL DEFAULT 0,
        is_collection TINYINT(1) NOT NULL DEFAULT 0,
        group_name VARCHAR(255) NOT NULL DEFAULT '',
        sort_order INT NOT NULL DEFAULT 0,
        source_shop_id BIGINT NULL,
        raw_json LONGTEXT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        synced_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ozon_category_attribute (description_category_id, type_id, attribute_id),
        INDEX idx_ozon_category_attribute_required (description_category_id, type_id, is_required, status),
        INDEX idx_ozon_category_attribute_name (name(120))
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS ozon_attribute_values (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        description_category_id BIGINT NOT NULL,
        type_id BIGINT NOT NULL,
        attribute_id BIGINT NOT NULL,
        dictionary_value_id BIGINT NOT NULL DEFAULT 0,
        value VARCHAR(1000) NOT NULL DEFAULT '',
        info TEXT NULL,
        source_shop_id BIGINT NULL,
        raw_json LONGTEXT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        synced_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ozon_attribute_value (description_category_id, type_id, attribute_id, dictionary_value_id),
        INDEX idx_ozon_attribute_value_lookup (description_category_id, type_id, attribute_id, status),
        INDEX idx_ozon_attribute_value_text (value(160))
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS listing_drafts (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        template_id BIGINT NULL,
        product_name VARCHAR(255) NOT NULL,
        internal_code VARCHAR(128) NOT NULL DEFAULT '',
        source_urls_json LONGTEXT NOT NULL,
        source_images_json LONGTEXT NOT NULL,
        cost_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        sale_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        length_cm DECIMAL(10,2) NOT NULL DEFAULT 0,
        width_cm DECIMAL(10,2) NOT NULL DEFAULT 0,
        height_cm DECIMAL(10,2) NOT NULL DEFAULT 0,
        weight_g DECIMAL(10,2) NOT NULL DEFAULT 0,
        color VARCHAR(128) NOT NULL DEFAULT '',
        spec VARCHAR(255) NOT NULL DEFAULT '',
        quantity INT NOT NULL DEFAULT 0,
        manual_facts_json LONGTEXT NOT NULL,
        ai_payload_json LONGTEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'draft',
        created_by_person_id BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_listing_drafts_owner_status (created_by_person_id, status, updated_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS listing_shop_copies (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        draft_id BIGINT NOT NULL,
        shop_id BIGINT NOT NULL,
        offer_id VARCHAR(128) NOT NULL DEFAULT '',
        title VARCHAR(500) NOT NULL DEFAULT '',
        price DECIMAL(12,2) NOT NULL DEFAULT 0,
        stock_quantity INT NOT NULL DEFAULT 0,
        watermark_path TEXT NULL,
        images_json LONGTEXT NOT NULL,
        validation_json LONGTEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'prepared',
        created_by_person_id BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_listing_shop_copy (draft_id, shop_id),
        INDEX idx_listing_shop_copies_draft (draft_id, status)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await ensureMysqlColumn("listing_shop_copies", "ozon_product_id", "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureMysqlColumn("listing_shop_copies", "ozon_sku", "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureMysqlColumn("listing_shop_copies", "product_url", "TEXT NULL");
    await ensureMysqlColumn("listing_shop_copies", "publish_response_json", "LONGTEXT NULL");
    await ensureMysqlColumn("listing_shop_copies", "published_at", "TIMESTAMP NULL");
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS listing_ozon_copy_jobs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        shop_id BIGINT NOT NULL,
        ozon_sku VARCHAR(128) NOT NULL,
        offer_id VARCHAR(128) NOT NULL DEFAULT '',
        task_id VARCHAR(128) NOT NULL DEFAULT '',
        template_id BIGINT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'submitted',
        request_json LONGTEXT NOT NULL,
        response_json LONGTEXT NOT NULL,
        created_by_person_id BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_listing_copy_jobs_sku (ozon_sku, updated_at),
        INDEX idx_listing_copy_jobs_task (task_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await ensureMysqlColumn("listing_ozon_copy_jobs", "product_id", "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureMysqlColumn("listing_ozon_copy_jobs", "product_detail_json", "LONGTEXT NULL");
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS listing_publish_records (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        draft_id BIGINT NOT NULL,
        shop_copy_id BIGINT NULL,
        shop_id BIGINT NOT NULL,
        offer_id VARCHAR(128) NOT NULL DEFAULT '',
        ozon_product_id VARCHAR(128) NOT NULL DEFAULT '',
        ozon_sku VARCHAR(128) NOT NULL DEFAULT '',
        product_url TEXT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'pending',
        request_json LONGTEXT NULL,
        response_json LONGTEXT NULL,
        error_json LONGTEXT NULL,
        created_by_person_id BIGINT NULL,
        published_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_listing_publish_draft (draft_id, status),
        INDEX idx_listing_publish_shop_product (shop_id, ozon_product_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await ensureMysqlColumn("listing_publish_records", "task_id", "VARCHAR(128) NOT NULL DEFAULT ''");
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS listing_collected_product_details (
        id VARCHAR(160) NOT NULL,
        tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin',
        platform VARCHAR(32) NOT NULL DEFAULT 'Ozon',
        sku VARCHAR(128) NOT NULL DEFAULT '',
        title VARCHAR(500) NOT NULL DEFAULT '',
        template_id BIGINT NULL,
        payload_json LONGTEXT NOT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'saved',
        error_message TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id, tenant_id),
        INDEX idx_listing_collected_template (template_id),
        INDEX idx_listing_collected_sku (sku, updated_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS listing_media_assets (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        source_module VARCHAR(64) NOT NULL DEFAULT '',
        source_id VARCHAR(128) NOT NULL DEFAULT '',
        batch_id VARCHAR(128) NOT NULL DEFAULT '',
        shop_id BIGINT NULL,
        template_id BIGINT NULL,
        variant_id BIGINT NULL,
        media_type VARCHAR(32) NOT NULL DEFAULT 'image',
        role VARCHAR(64) NOT NULL DEFAULT '',
        local_path TEXT NULL,
        source_path TEXT NULL,
        preview_url TEXT NULL,
        publish_url TEXT NULL,
        original_name VARCHAR(255) NOT NULL DEFAULT '',
        storage_name VARCHAR(255) NOT NULL DEFAULT '',
        mime_type VARCHAR(128) NOT NULL DEFAULT '',
        file_size BIGINT NOT NULL DEFAULT 0,
        width INT NOT NULL DEFAULT 0,
        height INT NOT NULL DEFAULT 0,
        hash_sha256 VARCHAR(128) NOT NULL DEFAULT '',
        sort_order INT NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        metadata_json LONGTEXT NULL,
        created_by_person_id BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_listing_media_source (source_module, source_id, batch_id),
        INDEX idx_listing_media_shop_role (shop_id, role, status),
        INDEX idx_listing_media_hash (hash_sha256),
        INDEX idx_listing_media_updated (updated_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
  mysqlSchemaReady = true;
}

async function ensureMysqlColumn(table, column, definition) {
  try {
    await mysqlExecute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
}

function normalizeTemplatePayload(body = {}) {
  const editable = normalizeEditablePayload(body.editable_payload || body.editablePayload || {});
  return {
    ozon_category_id: String(body.ozon_category_id || body.ozonCategoryId || "").trim(),
    category_name: String(body.category_name || body.categoryName || "").trim(),
    template_name: String(body.template_name || body.templateName || "").trim(),
    required_attributes: splitLines(body.required_attributes || body.requiredAttributes),
    ai_rules: objectValue(body.ai_rules || body.aiRules),
    title_prompt: String(body.title_prompt || body.titlePrompt || "").trim(),
    description_prompt: String(body.description_prompt || body.descriptionPrompt || "").trim(),
    image_rules: objectValue(body.image_rules || body.imageRules),
    editable_payload: editable,
    title: String(body.title || editable.title || "").trim(),
    description: String(body.description || editable.description || "").trim(),
    attributes: normalizeAttributes(body.attributes || editable.attributes),
    images: normalizeImages(body.images || editable.images)
  };
}

function buildTemplatePayloadFromCollectedProduct(body = {}) {
  const source = unwrapCollectedPayload(body);
  const editPayload = objectValue(source.editPayload || source.edit_payload || source.editable_payload || {});
  const followPayload = objectValue(source.followEditPayload || source.follow_edit_payload || editPayload.followEditPayload || {});
  const rows = normalizeArray(source.rows || editPayload.rows || followPayload.rows || source.editorVariants || source.variants);
  const attributes = normalizeAttributes(source.attributes || editPayload.attributes || followPayload.attributes || []);
  const hashtags = normalizeTagList(source.hashtags || editPayload.hashtags || followPayload.hashtags);
  const images = normalizeImages(
    source.images ||
    editPayload.images ||
    [source.mainImage || source.main_image || editPayload.mainImage || editPayload.main_image].concat(rows.flatMap((item) => item.images || []))
  );
  const title = String(source.title || source.productTitle || source.name || editPayload.title || rows[0]?.title || "").trim();
  const description = String(source.description || editPayload.description || rows[0]?.description || "").trim();
  const jsonContent = source.jsonContent ?? source.json_content ?? editPayload.jsonContent ?? editPayload.json_content ?? followPayload.json_content ?? "";
  const richText = typeof jsonContent === "string" ? jsonContent : (jsonContent ? JSON.stringify(jsonContent, null, 2) : "");
  const dimensions = normalizeCollectedDimensions(source, editPayload, rows[0]);
  const variants = rows.length ? rows.map((item, index) => normalizeCollectedVariant(item, source, dimensions, hashtags, index)) : [
    normalizeCollectedVariant({
      sku: source.sku || source.productId || "",
      title,
      images,
      price: source.price || editPayload.price,
      old_price: source.originalPrice || source.old_price,
      hashtags
    }, source, dimensions, hashtags, 0)
  ];
  const sku = String(source.sku || source.productId || editPayload.sku || variants[0]?.source_sku || "").trim();
  const descriptionCategoryId = String(
    body.ozon_category_id ||
    body.ozonCategoryId ||
    body.description_category_id ||
    body.descriptionCategoryId ||
    source.description_category_id ||
    source.descriptionCategoryId ||
    editPayload.description_category_id ||
    editPayload.descriptionCategoryId ||
    ""
  ).trim();
  const typeId = String(body.type_id || body.typeId || source.type_id || source.typeId || editPayload.type_id || editPayload.typeId || "").trim();
  const legacyCategoryId = String(source.ozon_category_id || source.category_id || editPayload.category_id || "").trim();
  const fallbackCategoryId = buildOzonCategoryKey({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    category_id: legacyCategoryId,
    fallback: `frontend:${sku || source.collectionId || source.id || Date.now()}`
  });
  const categoryId = descriptionCategoryId || legacyCategoryId || fallbackCategoryId;
  const categoryName = String(body.category_name || body.categoryName || source.category || source.category_name || source.categoryName || (categoryId ? `Ozon 类目 ${categoryId}` : "")).trim();
  const enrichedAttributes = enrichTemplateAttributes(attributes, {
    title,
    brand: attributeValueByNames(attributes, ["品牌", "Бренд"], [85]) || source.brand || "无品牌",
    model: attributeValueByNames(attributes, ["型号", "Модель"], [9048]) || rows[0]?.spec || "",
    tags: hashtags,
    description,
    richJson: richText
  });
  return {
    ozon_category_id: fallbackCategoryId,
    category_name: categoryName || "Ozon 前台采集模板",
    template_name: String(body.template_name || body.templateName || source.local_template_name || source.template_name || title || `Ozon ${sku} 采集模板`).trim(),
    source_ozon_sku: sku,
    source_raw: {
      source_type: "ozon_frontend_collect",
      collected_product: body
    },
    required_attributes: [],
    ai_rules: {},
    image_rules: {},
    title,
    description,
    attributes: enrichedAttributes,
    images,
    editable_payload: {
      sku,
      product_id: String(source.productId || source.product_id || ""),
      title,
      description,
      rich_content: jsonContent || null,
      rich_content_json: richText,
      category_id: fallbackCategoryId,
      legacy_category_id: legacyCategoryId,
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      category_name: categoryName || "Ozon 前台采集模板",
      price: {
        value: numberFromOzonValue(source.price || editPayload.price || rows[0]?.price || 0),
        old_price: numberFromOzonValue(source.originalPrice || source.old_price || rows[0]?.old_price || 0),
        currency_code: source.currency || editPayload.currency || followPayload.currecny || "RUB",
        vat: String(source.vat || editPayload.vat || "0")
      },
      dimensions,
      logistics: {
        brand: attributeValueByNames(enrichedAttributes, ["品牌", "Бренд"], [85]) || "无品牌",
        color: attributeValueByNames(enrichedAttributes, ["颜色", "Цвет"], [8229]) || "",
        spec: attributeValueByNames(enrichedAttributes, ["型号", "Модель"], [9048]) || "",
        tags: hashtags,
        quantity: 0
      },
      images,
      attributes: enrichedAttributes,
      variants
    }
  };
}

function unwrapCollectedPayload(body = {}) {
  const data = body.data || body.detail || body.normalized || body.payload || body;
  if (data?.editPayload && Object.keys(data).length <= 3) return { ...data.editPayload, collectionId: data.collectionId || data.id };
  return data;
}

function normalizeCollectedDimensions(...sources) {
  const list = sources.filter(Boolean);
  const firstValue = (...keys) => {
    for (const source of list) {
      for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && value !== "") return value;
      }
    }
    return "";
  };
  const rawDims = firstValue("dimensions", "real_dimensions", "custom_volume");
  const dims = objectValue(rawDims);
  const parsedDims = parseCollectedDimensionText(rawDims);
  return {
    length_cm: numberFromOzonValue(firstValue("length_mm", "depth", "length") || dims.depth || dims.length || parsedDims.length || 0),
    width_cm: numberFromOzonValue(firstValue("width_mm", "width") || dims.width || parsedDims.width || 0),
    height_cm: numberFromOzonValue(firstValue("height_mm", "height") || dims.height || parsedDims.height || 0),
    weight_g: numberFromOzonValue(firstValue("weight_g", "weight", "custom_weight") || 0)
  };
}

function parseCollectedDimensionText(value) {
  if (!value || typeof value === "object") return {};
  const text = String(value).replace(/,/g, ".").replace(/\s+/g, "");
  const match = text.match(/(\d+(?:\.\d+)?)[xX×*](\d+(?:\.\d+)?)[xX×*](\d+(?:\.\d+)?)/);
  if (!match) return {};
  return {
    length: Number(match[1]) || 0,
    width: Number(match[2]) || 0,
    height: Number(match[3]) || 0
  };
}

function normalizeCollectedVariant(item = {}, source = {}, dimensions = {}, tags = [], index = 0) {
  const rowDimensions = normalizeCollectedDimensions(item, dimensions);
  const imageValues = normalizeImages([
    item.cover_image || item.coverImage || item.primary_image || item.mainImage || "",
    ...(normalizeArray(item.images || item.image_urls || item.imageUrls))
  ]);
  const sku = String(item.sku || item.source_sku || "").trim();
  return {
    sku,
    source_sku: sku,
    source_offer_id: String(item.source_offer_id || item.seller_offer_id || item.offer_id || "").trim(),
    offer_id: "",
    name: String(item.name || item.title || source.title || "").trim(),
    title: String(item.title || item.name || source.title || "").trim(),
    images: imageValues,
    video_cover_urls: normalizeStringList(item.video_cover_urls || item.cover_video_urls || item.cover_video || item.video_cover),
    video_urls: normalizeStringList(item.video_urls || item.videos || item.videoUrls || item.video_url),
    barcode: String(item.barcode || normalizeArray(item.barcodes)[0] || "").trim(),
    cost_price: 0,
    price: numberFromOzonValue(item.price || item.sell_price || item.cardPrice || source.price || 0),
    old_price: numberFromOzonValue(item.old_price || item.originalPrice || 0),
    color: String(item.color || "").trim(),
    spec: String(item.spec || item.searchable_text || "").trim(),
    main_tags: normalizeTagList(item.hashtags || item.main_tags || tags),
    weight_g: rowDimensions.weight_g || dimensions.weight_g || 0,
    length_mm: rowDimensions.length_cm || dimensions.length_cm || 0,
    width_mm: rowDimensions.width_cm || dimensions.width_cm || 0,
    height_mm: rowDimensions.height_cm || dimensions.height_cm || 0,
    stock: Number(item.stock || item.quantity || 0),
    sort_order: Number(item.sort_order || index + 1)
  };
}

function normalizeTagList(value) {
  return normalizeStringList(value).map((item) => item.startsWith("#") ? item : `#${item}`);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeStringList(item));
  if (value && typeof value === "object") return normalizeStringList(value.value || value.name || value.text || "");
  return String(value || "").split(/[,，\s\r\n]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeVariantMediaForPublish(variant = {}) {
  return {
    ...variant,
    images: normalizeImages(variant.images || []).map((image) => ({
      ...image,
      url: publishableListingMediaUrl(image.url)
    })),
    video_urls: normalizeStringList(variant.video_urls || variant.videos || variant.video_url).map(publishableListingMediaUrl),
    video_cover_urls: normalizeStringList(variant.video_cover_urls || variant.cover_video_urls || variant.video_cover).map(publishableListingMediaUrl)
  };
}

function normalizeRichContentMediaForPublish(value) {
  if (!value) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(rewriteListingMediaInObject(JSON.parse(trimmed)));
      } catch {
        return rewriteListingMediaInText(value);
      }
    }
    return rewriteListingMediaInText(value);
  }
  return rewriteListingMediaInObject(value);
}

function rewriteListingMediaInObject(value) {
  if (Array.isArray(value)) return value.map(rewriteListingMediaInObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteListingMediaInObject(item)]));
  }
  if (typeof value === "string") return publishableListingMediaUrl(value);
  return value;
}

function rewriteListingMediaInText(value) {
  return String(value || "").replace(/(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)?\/uploads\/listing-media\/[^\s"'<>),\]]+/gi, (match) => publishableListingMediaUrl(match));
}

function buildOzonCategoryKey({ description_category_id = "", type_id = "", category_id = "", fallback = "" } = {}) {
  const descriptionCategoryId = String(description_category_id || "").trim();
  const typeId = String(type_id || "").trim();
  if (descriptionCategoryId && typeId) return `${descriptionCategoryId}:${typeId}`;
  if (descriptionCategoryId) return descriptionCategoryId;
  return String(category_id || fallback || "").trim();
}

function buildOzonImportPreviewPayload(facts = {}, template = {}) {
  const baseImages = facts.images.map((item) => item.url).filter(Boolean);
  const attrs = facts.attributes
    .filter((item) => item.attribute_id && normalizeAttributeValue(item.value))
    .map((item) => ({
      id: Number(item.attribute_id),
      values: normalizeAttributeValuesForOzon(item)
    }));
  const variants = facts.variants.length ? facts.variants : [{ title: facts.title, images: facts.images }];
  return {
    items: variants.map((variant, index) => {
      const variantImages = normalizeImages(variant.images || []).map((item) => item.url).filter(Boolean);
      const finalImages = variantImages.length ? variantImages : baseImages;
      const primaryImage = finalImages[0] || "";
      return {
        offer_id: String(variant.offer_id || variant.sku || `NEW-OFFER-${index + 1}`).trim(),
        name: String(variant.title || variant.name || facts.title || "").trim(),
        price: String(numberFromOzonValue(variant.price || facts.price.value || 0)),
        old_price: String(numberFromOzonValue(variant.old_price || facts.price.old_price || facts.price.value || 0)),
        currency_code: facts.price.currency_code || "RUB",
        vat: String(facts.price.vat || "0"),
        description_category_id: Number(facts.descriptionCategoryId || 0) || undefined,
        type_id: Number(facts.typeId || 0) || undefined,
        depth: Number(variant.length_mm || facts.dimensions.length_cm || 0),
        width: Number(variant.width_mm || facts.dimensions.width_cm || 0),
        height: Number(variant.height_mm || facts.dimensions.height_cm || 0),
        dimension_unit: "mm",
        weight: Number(variant.weight_g || facts.dimensions.weight_g || 0),
        weight_unit: "g",
        primary_image: primaryImage,
        images: finalImages.filter((url) => url !== primaryImage),
        attributes: attrs,
        complex_attributes: buildOzonComplexAttributesPreview(variant, facts)
      };
    })
  };
}

function normalizeAttributeValuesForOzon(item = {}) {
  const values = Array.isArray(item.value) ? item.value : String(item.value || "").split(/[,;\n]+/);
  return values.map((value) => {
    const text = String(value || "").trim();
    const option = normalizeArray(item.values).find((candidate) => String(candidate.value || candidate.name || "") === text);
    if (option?.id) return { dictionary_value_id: Number(option.id), value: text };
    return { value: text };
  }).filter((value) => value.value || value.dictionary_value_id);
}

function buildOzonComplexAttributesPreview(variant = {}, facts = {}) {
  const result = [];
  const videos = normalizeStringList(variant.video_urls || variant.videos || variant.video_url);
  if (videos.length) {
    result.push({
      attributes: [
        {
          complex_id: 100001,
          id: 21841,
          values: videos.map((url) => ({ value: url }))
        },
        {
          complex_id: 100001,
          id: 21837,
          values: videos.map((url, index) => ({ value: videoNameFromUrl(url, index) }))
        }
      ]
    });
  }
  const videoCovers = normalizeStringList(variant.video_cover_urls || variant.cover_video_urls || variant.video_cover);
  if (videoCovers.length) {
    result.push({
      attributes: [
        {
          complex_id: 100002,
          id: 21845,
          values: videoCovers.map((url) => ({ dictionary_value_id: 0, value: url }))
        }
      ]
    });
  }
  const richContent = facts.richContent;
  if (richContent) {
    result.push({
      id: "rich_content_json",
      values: [{ value: typeof richContent === "string" ? richContent : JSON.stringify(richContent) }]
    });
  }
  return result;
}

function videoNameFromUrl(url, index = 0) {
  const fallback = `video_${index + 1}`;
  try {
    const parsed = new URL(String(url || ""));
    const name = parsed.pathname.split("/").filter(Boolean).pop() || fallback;
    return name.replace(/\.[^.]+$/, "").slice(0, 80) || fallback;
  } catch {
    return fallback;
  }
}

function collectLocalImportMedia(payload = {}) {
  return normalizeArray(payload.items).flatMap((item) => [
    item.primary_image,
    ...normalizeArray(item.images),
    ...normalizeArray(item.complex_attributes).flatMap((attr) => normalizeArray(attr.values).map((value) => value.value))
  ]).filter(isLocalImportMedia);
}

function isLocalImportMedia(url) {
  const value = String(url || "").trim();
  return value.startsWith("/") || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(value);
}

function publishableListingMediaUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  const path = listingMediaPathFromUrl(value);
  if (!path) return value;
  return buildListingMediaPublishUrl(path) || value;
}

function listingMediaPathFromUrl(url) {
  const value = String(url || "").trim();
  if (value.startsWith("/uploads/listing-media/")) return value;
  try {
    const parsed = new URL(value);
    return parsed.pathname.startsWith("/uploads/listing-media/") ? parsed.pathname : "";
  } catch {
    return "";
  }
}

function buildListingMediaPublishUrl(relativeUrl) {
  const base = String(config.listingMediaPublicBaseUrl || config.appBaseUrl || "").trim();
  if (!base || isLocalImportMedia(base)) return "";
  try {
    const url = new URL(relativeUrl, base.endsWith("/") ? base : `${base}/`);
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeListingMediaAssetPayload(body = {}, session = null) {
  const previewUrl = String(body.preview_url || body.previewUrl || "").trim();
  const publishUrl = String(body.publish_url || body.publishUrl || publishableListingMediaUrl(previewUrl) || "").trim();
  return {
    source_module: String(body.source_module || body.sourceModule || "manual").trim().slice(0, 64),
    source_id: String(body.source_id || body.sourceId || "").trim().slice(0, 128),
    batch_id: String(body.batch_id || body.batchId || "").trim().slice(0, 128),
    shop_id: nullableNumber(body.shop_id ?? body.shopId),
    template_id: nullableNumber(body.template_id ?? body.templateId),
    variant_id: nullableNumber(body.variant_id ?? body.variantId),
    media_type: String(body.media_type || body.mediaType || "image").trim().slice(0, 32),
    role: String(body.role || "").trim().slice(0, 64),
    local_path: String(body.local_path || body.localPath || "").trim(),
    source_path: String(body.source_path || body.sourcePath || "").trim(),
    preview_url: previewUrl,
    publish_url: publishUrl,
    original_name: String(body.original_name || body.originalName || "").trim().slice(0, 255),
    storage_name: String(body.storage_name || body.storageName || "").trim().slice(0, 255),
    mime_type: String(body.mime_type || body.mimeType || "").trim().slice(0, 128),
    file_size: Number(body.file_size || body.fileSize || 0),
    width: Number(body.width || 0),
    height: Number(body.height || 0),
    hash_sha256: String(body.hash_sha256 || body.hash || "").trim().slice(0, 128),
    sort_order: Number(body.sort_order || body.sortOrder || 0),
    status: String(body.status || (publishUrl ? "public_ready" : "local_only")).trim().slice(0, 32),
    metadata: objectValue(body.metadata || body.metadata_json || body.metadataJson || {}),
    created_by_person_id: personId(session)
  };
}

function normalizeListingMediaAssetRow(row = {}) {
  const metadata = row.metadata || parseJson(row.metadata_json, {});
  const previewUrl = row.preview_url || row.previewUrl || "";
  const publishUrl = row.publish_url || row.publishUrl || "";
  return {
    id: Number(row.id || 0),
    source_module: row.source_module || row.sourceModule || "",
    sourceModule: row.source_module || row.sourceModule || "",
    source_id: row.source_id || row.sourceId || "",
    sourceId: row.source_id || row.sourceId || "",
    batch_id: row.batch_id || row.batchId || "",
    batchId: row.batch_id || row.batchId || "",
    shop_id: nullableNumber(row.shop_id ?? row.shopId),
    shopId: nullableNumber(row.shop_id ?? row.shopId),
    template_id: nullableNumber(row.template_id ?? row.templateId),
    templateId: nullableNumber(row.template_id ?? row.templateId),
    variant_id: nullableNumber(row.variant_id ?? row.variantId),
    variantId: nullableNumber(row.variant_id ?? row.variantId),
    media_type: row.media_type || row.mediaType || "image",
    mediaType: row.media_type || row.mediaType || "image",
    role: row.role || "",
    local_path: row.local_path || row.localPath || "",
    localPath: row.local_path || row.localPath || "",
    source_path: row.source_path || row.sourcePath || "",
    sourcePath: row.source_path || row.sourcePath || "",
    preview_url: previewUrl,
    previewUrl,
    publish_url: publishUrl,
    publishUrl,
    url: publishUrl || previewUrl,
    original_name: row.original_name || row.originalName || "",
    originalName: row.original_name || row.originalName || "",
    storage_name: row.storage_name || row.storageName || "",
    storageName: row.storage_name || row.storageName || "",
    mime_type: row.mime_type || row.mimeType || "",
    mimeType: row.mime_type || row.mimeType || "",
    file_size: Number(row.file_size || row.fileSize || 0),
    fileSize: Number(row.file_size || row.fileSize || 0),
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    hash_sha256: row.hash_sha256 || row.hash || "",
    hash: row.hash_sha256 || row.hash || "",
    sort_order: Number(row.sort_order || row.sortOrder || 0),
    sortOrder: Number(row.sort_order || row.sortOrder || 0),
    status: row.status || "",
    metadata,
    created_at: row.created_at || row.createdAt || "",
    updated_at: row.updated_at || row.updatedAt || ""
  };
}

function mimeTypeForListingMediaExtension(extension) {
  const ext = String(extension || "").toLowerCase();
  if (LISTING_MEDIA_TYPES.has(ext)) return LISTING_MEDIA_TYPES.get(ext);
  if (ext === ".gif") return "image/gif";
  return ext === ".mp4" ? "video/mp4" : "image/jpeg";
}

function nullableNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeTemplateUpdatePayload(body = {}, current = {}) {
  const editable = normalizeEditablePayload(body.editable_payload || body.editablePayload || current.editable_payload || {});
  const attributes = normalizeAttributes(body.attributes || editable.attributes || current.attributes);
  const images = normalizeImages(body.images || editable.images || current.images);
  const title = String(body.title ?? editable.title ?? current.title ?? "").trim();
  const description = String(body.description ?? editable.description ?? current.description ?? "").trim();
  return {
    ozon_category_id: String(body.ozon_category_id ?? body.ozonCategoryId ?? current.ozon_category_id ?? "").trim(),
    category_name: String(body.category_name ?? body.categoryName ?? current.category_name ?? "").trim(),
    template_name: String(body.template_name ?? body.templateName ?? current.template_name ?? "").trim(),
    required_attributes: splitLines(body.required_attributes ?? body.requiredAttributes ?? current.required_attributes),
    ai_rules: objectValue(body.ai_rules ?? body.aiRules ?? current.ai_rules),
    title_prompt: String(body.title_prompt ?? body.titlePrompt ?? current.title_prompt ?? "").trim(),
    description_prompt: String(body.description_prompt ?? body.descriptionPrompt ?? current.description_prompt ?? "").trim(),
    image_rules: objectValue(body.image_rules ?? body.imageRules ?? current.image_rules),
    source_raw: objectValue(body.source_raw ?? body.sourceRaw ?? current.source_raw),
    editable_payload: {
      ...editable,
      title,
      description,
      attributes,
      images,
      dimensions: objectValue(editable.dimensions || {}),
      logistics: objectValue(editable.logistics || {}),
      price: objectValue(editable.price || {})
    },
    title,
    description,
    attributes,
    images
  };
}

function normalizeDraftPayload(body = {}) {
  return {
    template_id: Number(body.template_id || body.templateId || 0),
    product_name: String(body.product_name || body.productName || "").trim(),
    internal_code: String(body.internal_code || body.internalCode || "").trim(),
    source_urls: splitLines(body.source_urls || body.sourceUrls),
    source_images: splitLines(body.source_images || body.sourceImages),
    cost_price: Number(body.cost_price || body.costPrice || 0),
    sale_price: Number(body.sale_price || body.salePrice || 0),
    length_cm: Number(body.length_cm || body.lengthCm || 0),
    width_cm: Number(body.width_cm || body.widthCm || 0),
    height_cm: Number(body.height_cm || body.heightCm || 0),
    weight_g: Number(body.weight_g || body.weightG || 0),
    color: String(body.color || "").trim(),
    spec: String(body.spec || "").trim(),
    quantity: Number(body.quantity || 0),
    manual_facts: objectValue(body.manual_facts || body.manualFacts)
  };
}

function normalizeTemplateRow(row) {
  const editable = normalizeEditablePayload(parseJson(row.editable_payload_json, {}));
  const attributes = normalizeAttributes(parseJson(row.attributes_json, editable.attributes || []));
  const images = normalizeImages(parseJson(row.images_json, editable.images || []));
  return {
    ...row,
    required_attributes: parseJson(row.required_attributes_json, []),
    ai_rules: parseJson(row.ai_rules_json, {}),
    image_rules: parseJson(row.image_rules_json, {}),
    category_attributes: parseJson(row.category_attributes_json, []),
    source_raw: parseJson(row.source_raw_json, {}),
    editable_payload: {
      ...editable,
      title: row.title || editable.title || row.template_name || "",
      description: row.description || editable.description || "",
      attributes,
      images
    },
    title: row.title || editable.title || row.template_name || "",
    description: row.description || editable.description || "",
    attributes,
    images
  };
}

function normalizeOzonCategoryRow(row = {}) {
  const descriptionCategoryId = Number(row.description_category_id || row.descriptionCategoryId || 0);
  const typeId = Number(row.type_id || row.typeId || 0);
  const nameZh = row.name_zh || row.nameZh || "";
  const nameRu = row.name_ru || row.nameRu || "";
  const pathZh = row.path_zh || row.pathZh || "";
  const pathRu = row.path_ru || row.pathRu || "";
  return {
    id: Number(row.id || 0),
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    descriptionCategoryId,
    typeId,
    ozon_category_id: buildOzonCategoryKey({ description_category_id: descriptionCategoryId, type_id: typeId }),
    name_zh: nameZh,
    name_ru: nameRu,
    path_zh: pathZh,
    path_ru: pathRu,
    label: pathZh || nameZh || pathRu || nameRu || `${descriptionCategoryId}:${typeId}`,
    name: nameZh || nameRu,
    subLabel: [nameRu, descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : ""].filter(Boolean).join(" · "),
    parent_description_category_id: Number(row.parent_description_category_id || 0),
    is_auto: Boolean(row.is_auto),
    source_shop_id: row.source_shop_id ? Number(row.source_shop_id) : null,
    synced_at: row.synced_at || null,
    raw: parseJson(row.raw_json, row.raw || {})
  };
}

function normalizeOzonCategoryAttributeRow(row = {}) {
  const raw = parseJson(row.raw_json, row.raw || {});
  const attributeId = Number(row.attribute_id || row.attributeId || row.id || raw.id || 0);
  return {
    id: attributeId,
    attribute_id: attributeId,
    name: row.name || raw.name || "",
    description: row.description || raw.description || raw.hint || "",
    required: Boolean(row.is_required ?? raw.is_required ?? raw.required),
    is_required: Boolean(row.is_required ?? raw.is_required ?? raw.required),
    type: row.attribute_type || raw.type || raw.attribute_type || "String",
    dictionary_id: Number(row.dictionary_id || raw.dictionary_id || 0),
    is_collection: Boolean(row.is_collection ?? raw.is_collection),
    group: row.group_name || raw.group_name || raw.group || "",
    sort_order: Number(row.sort_order || 0),
    source: "ozon_schema_cache",
    values: [],
    raw
  };
}

function normalizeOzonAttributeValueRow(row = {}) {
  const raw = parseJson(row.raw_json, row.raw || {});
  const dictionaryValueId = Number(row.dictionary_value_id || row.dictionaryValueId || raw.id || raw.dictionary_value_id || 0);
  const value = row.value || raw.value || raw.name || "";
  return {
    id: dictionaryValueId,
    dictionary_value_id: dictionaryValueId,
    value,
    label: value,
    info: row.info || raw.info || raw.description || "",
    raw
  };
}

function normalizePublishRecordRow(row = {}) {
  return {
    ...row,
    id: Number(row.id || 0),
    draft_id: Number(row.draft_id || 0),
    shop_id: Number(row.shop_id || 0),
    response: parseJson(row.response_json, {}),
    request: parseJson(row.request_json, {}),
    error: parseJson(row.error_json, null)
  };
}

function firstOfferId(payload = {}) {
  const first = normalizeArray(payload.items)[0] || {};
  return String(first.offer_id || "").trim();
}

async function updatePublishRecordAfterSubmit(recordId, { taskId = "", response = null, importInfo = null, status = "submitted" } = {}) {
  if (!recordId) return;
  const refs = extractImportedProductRefs(importInfo || response || {}, {});
  await run(`
    UPDATE listing_publish_records
    SET task_id = ?, status = ?, response_json = ?, error_json = ?, ozon_product_id = ?, offer_id = COALESCE(NULLIF(offer_id, ''), ?), updated_at = CURRENT_TIMESTAMP,
        published_at = CASE WHEN ? IN ('imported', 'published', 'success') THEN CURRENT_TIMESTAMP ELSE published_at END
    WHERE id = ?
  `, [
    String(taskId || ""),
    status || "submitted",
    JSON.stringify({ submit: response, import_info: importInfo }),
    importInfo?.error ? JSON.stringify({ message: importInfo.error }) : null,
    refs.productIds[0] ? String(refs.productIds[0]) : "",
    refs.offerIds[0] || "",
    status || "submitted",
    Number(recordId)
  ]);
}

function importInfoStatus(info = {}) {
  if (!info || info.error) return "submitted";
  const result = info.result || info;
  const rawStatus = String(result.status || normalizeArray(result.items || result.products)[0]?.status || "").toLowerCase();
  if (rawStatus.includes("fail") || rawStatus.includes("error") || rawStatus.includes("rejected")) return "failed";
  if (rawStatus.includes("import") || rawStatus.includes("success") || rawStatus.includes("done")) return "imported";
  if (rawStatus.includes("pending") || rawStatus.includes("process") || rawStatus.includes("moderation")) return "processing";
  return rawStatus || "submitted";
}

async function resolveOzonApiShop(shopId = 0) {
  const id = Number(shopId || 0);
  const rows = await all(`
    SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint
    FROM shops
    WHERE status <> 'deleted'
      AND ozon_client_id IS NOT NULL AND ozon_client_id <> ''
      AND api_key_hint IS NOT NULL AND api_key_hint <> ''
      AND api_key_hint NOT LIKE 'demo%'
      ${id ? "AND id = ?" : ""}
    ORDER BY id DESC
    LIMIT 1
  `, id ? [id] : []);
  const shop = rows[0];
  if (!shop) throw new Error("没有找到带真实 Ozon API 凭证的店铺，无法同步真实类目");
  return shop;
}

async function attachCachedAttributeValues(attributes = [], descriptionCategoryId, typeId, limit = 120) {
  const dictionaryAttrs = attributes.filter((item) => Number(item.dictionary_id || 0) > 0);
  for (const attr of dictionaryAttrs) {
    const rows = await all(`
      SELECT *
      FROM ozon_attribute_values
      WHERE description_category_id = ? AND type_id = ? AND attribute_id = ? AND status = 'active'
      ORDER BY value ASC, dictionary_value_id ASC
      LIMIT ?
    `, [descriptionCategoryId, typeId, Number(attr.attribute_id || attr.id || 0), Math.min(Math.max(Number(limit || 120), 1), 500)]);
    attr.values = rows.map(normalizeOzonAttributeValueRow);
  }
}

function flattenOzonCategoryTree(tree) {
  const roots = normalizeArray(tree?.items || tree?.result || tree);
  const rows = [];
  const walk = (node, parents = []) => {
    if (!node || typeof node !== "object") return;
    const rawName = String(node.category_name || node.name || node.title || node.type_name || "").trim();
    const descriptionCategoryId = Number(node.description_category_id || node.descriptionCategoryId || node.category_id || 0);
    const typeId = Number(node.type_id || node.typeId || 0);
    const path = [...parents, rawName].filter(Boolean);
    if (descriptionCategoryId && typeId) {
      rows.push({
        descriptionCategoryId,
        typeId,
        nameRu: rawName,
        nameZh: rawName,
        pathRu: path.join(" / "),
        pathZh: path.join(" / "),
        parentDescriptionCategoryId: Number(node.parent_description_category_id || node.parent_id || 0),
        isAuto: node.is_auto !== undefined ? Boolean(node.is_auto) : true,
        raw: node
      });
    }
    for (const child of normalizeArray(node.children || node.childs || node.items || node.types)) {
      walk(child, path);
    }
  };
  for (const root of roots) walk(root, []);
  return rows;
}

function buildEditableTemplatePayload({ sku, name, price, categoryName, request }) {
  return {
    sku: String(sku || ""),
    title: String(name || ""),
    description: "",
    category_name: String(categoryName || ""),
    offer_id: request?.offer_id || "",
    price: {
      value: Number(price || 0),
      old_price: Number(request?.old_price || price || 0),
      currency_code: request?.currency_code || "RUB",
      vat: request?.vat || "0"
    },
    dimensions: {
      length_cm: 0,
      width_cm: 0,
      height_cm: 0,
      weight_g: 0
    },
    logistics: {
      color: "",
      spec: "",
      quantity: 0
    },
    images: [],
    attributes: [
      { name: "品牌", value: "", required: false },
      { name: "材质", value: "", required: false },
      { name: "适用车型/场景", value: "", required: false }
    ],
    raw_request: request || {}
  };
}

function normalizeEditablePayload(value) {
  const payload = objectValue(value);
  return {
    ...payload,
    price: objectValue(payload.price || {}),
    dimensions: objectValue(payload.dimensions || {}),
    logistics: objectValue(payload.logistics || {}),
    attributes: normalizeAttributes(payload.attributes),
    images: normalizeImages(payload.images)
  };
}

function normalizeAttributes(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { name: item, value: "", type: "text", required: false, values: [], sort_order: index + 1 };
    }
    return {
      name: String(item?.name || item?.attribute_name || "").trim(),
      value: normalizeAttributeValue(item?.value ?? item?.attribute_value ?? ""),
      required: Boolean(item?.required),
      attribute_id: item?.attribute_id || item?.id || "",
      type: String(item?.type || item?.value_type || (item?.dictionary_id ? "select" : "text")).trim(),
      dictionary_id: item?.dictionary_id || "",
      is_collection: Boolean(item?.is_collection || item?.collection),
      group: String(item?.group || item?.group_name || "").trim(),
      hint: String(item?.hint || item?.description || "").trim(),
      source: String(item?.source || "ozon_copy").trim(),
      values: Array.isArray(item?.values) ? item.values.map((option) => ({
        id: option?.id ?? option?.value_id ?? "",
        value: String(option?.value ?? option?.name ?? option ?? "").trim()
      })).filter((option) => option.value) : [],
      raw: item?.raw || item,
      sort_order: Number(item?.sort_order || index + 1)
    };
  }).filter((item) => item.name || item.value);
}

function normalizeImages(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.trim().startsWith("[") ? parseJson(value, []) : normalizeArray(value));
  return list.flat().map((item, index) => {
    if (typeof item === "string") return { url: item, sort_order: index + 1 };
    return {
      url: String(item?.url || item?.src || "").trim(),
      name: String(item?.name || "").trim(),
      sort_order: Number(item?.sort_order || index + 1)
    };
  }).filter((item) => item.url);
}

function normalizeOzonDetailAttributes(value) {
  return normalizeArray(value).map((item, index) => {
    const values = normalizeArray(item.values || item.value || item.attribute_values).map((option) => ({
      id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
      value: String(option?.value ?? option?.name ?? option?.text ?? option ?? "").trim()
    })).filter((option) => option.value);
    const fallbackValue = normalizeAttributeValue(item.value ?? item.attribute_value ?? "");
    return {
      name: String(item.name || item.attribute_name || item.title || (item.id || item.attribute_id ? `属性 ${item.id || item.attribute_id}` : "")).trim(),
      value: values.map((option) => option.value).join(", ") || fallbackValue,
      required: Boolean(item.required || item.is_required),
      attribute_id: item.attribute_id || item.id || "",
      type: item.is_collection ? "multiselect" : (values.length ? "select" : "text"),
      dictionary_id: item.dictionary_id || "",
      is_collection: Boolean(item.is_collection || item.collection),
      group: String(item.group || item.group_name || "").trim(),
      hint: String(item.hint || item.description || "").trim(),
      source: "ozon_product_detail",
      values,
      raw: item,
      sort_order: Number(item.sort_order || index + 1)
    };
  }).filter((item) => item.name || item.value);
}

function normalizeAttributeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object") return item.value ?? item.name ?? item.text ?? JSON.stringify(item);
      return item;
    }).map((item) => String(item || "").trim()).filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "").trim();
}

function enrichTemplateAttributes(attributes = [], facts = {}) {
  let result = normalizeArray(attributes).slice();
  const add = (names, value, defaults = {}) => {
    if (value === undefined || value === null || value === "") return;
    const existing = findAttributeByNames(result, names, defaults.attributeIds || []);
    if (existing) {
      if (!existing.value) existing.value = Array.isArray(value) ? value.join(",") : String(value);
      return;
    }
    result.push({
      name: defaults.name || names[0],
      value: Array.isArray(value) ? value.join(",") : String(value),
      required: Boolean(defaults.required),
      attribute_id: defaults.attribute_id || "",
      type: defaults.type || "text",
      values: [],
      source: "ozon_fixed_mapping",
      sort_order: result.length + 1
    });
  };
  add(["标题", "Название"], facts.title, { name: "标题", required: true });
  add(["品牌", "Бренд"], facts.brand, { name: "品牌", required: true, attributeIds: [85], attribute_id: 85 });
  add(["型号", "Модель"], facts.model, { name: "型号名称", required: true, attributeIds: [9048], attribute_id: 9048 });
  add(["主图标签", "ключевые слова", "тег"], facts.tags, { name: "主图标签", attributeIds: [10096], attribute_id: 10096, type: "multiselect" });
  add(["简介", "Аннотация", "Описание"], facts.description, { name: "简介", attributeIds: [4191], attribute_id: 4191, type: "textarea" });
  add(["JSON富内容", "Rich", "rich"], facts.richJson, { name: "JSON富内容", attributeIds: [11254], attribute_id: 11254, type: "rich_json" });
  return result;
}

function findAttributeByNames(attributes = [], names = [], ids = []) {
  const nameList = Array.isArray(names) ? names : [names];
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id)).filter(Boolean));
  return normalizeArray(attributes).find((item) => {
    const itemId = String(item.attribute_id || item.id || "");
    if (itemId && idSet.has(itemId)) return true;
    return nameList.some((name) => String(item.name || "").toLowerCase().includes(String(name || "").toLowerCase()));
  });
}

function mergeCategoryAttributeDefinitions(valueAttributes = [], definitions = []) {
  const normalizedValues = normalizeArray(valueAttributes);
  const valuesById = new Map(normalizedValues
    .map((item) => [String(item.attribute_id || item.id || ""), item])
    .filter(([id]) => id));
  const valuesByName = new Map(normalizedValues
    .map((item) => [normalizeAttributeNameKey(item.name || item.attribute_name), item])
    .filter(([name]) => name));
  const merged = [];
  for (const definition of normalizeArray(definitions)) {
    const id = String(definition.id || definition.attribute_id || "");
    const definitionName = normalizeAttributeNameKey(definition.name || definition.attribute_name);
    const value = (id && valuesById.get(id)) || (definitionName && valuesByName.get(definitionName)) || null;
    if (id) valuesById.delete(id);
    if (definitionName) valuesByName.delete(definitionName);
    merged.push({
      name: String(definition.name || definition.attribute_name || value?.name || (id ? `属性 ${id}` : "")).trim(),
      value: value?.value || "",
      required: Boolean(definition.is_required || definition.required || value?.required),
      attribute_id: id || value?.attribute_id || "",
      type: categoryAttributeType(definition, value),
      dictionary_id: definition.dictionary_id || value?.dictionary_id || "",
      is_collection: Boolean(definition.is_collection || definition.collection || value?.is_collection),
      group: String(definition.group_name || definition.group || value?.group || "").trim(),
      hint: String(definition.description || definition.hint || value?.hint || "").trim(),
      source: value ? "ozon_product_detail+category_definition" : "ozon_category_definition",
      values: value?.values || [],
      raw: { definition, value: value?.raw || value || null },
      sort_order: Number(definition.sort_order || value?.sort_order || merged.length + 1)
    });
  }
  for (const item of valuesById.values()) merged.push(item);
  for (const item of valuesByName.values()) {
    if (!item?.attribute_id && !merged.some((mergedItem) => normalizeAttributeNameKey(mergedItem.name) === normalizeAttributeNameKey(item.name))) {
      merged.push(item);
    }
  }
  return merged.filter((item) => item.name || item.value || item.attribute_id);
}

function normalizeAttributeNameKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function categoryAttributeType(definition = {}, value = {}) {
  if (definition.is_collection || value?.is_collection) return "multiselect";
  const raw = String(definition.type || definition.value_type || value?.type || "").toLowerCase();
  if (raw.includes("integer") || raw.includes("decimal") || raw.includes("number")) return "number";
  if (raw.includes("boolean")) return "boolean";
  if (definition.dictionary_id || value?.dictionary_id) return "select";
  return value?.type || "text";
}

function extractImageUrls(detail = {}) {
  const values = [
    detail.primary_image,
    detail.primary_image_url,
    detail.image,
    detail.main_image,
    detail.color_image,
    ...normalizeArray(detail.images),
    ...normalizeArray(detail.images360),
    ...normalizeArray(detail.images_360)
  ];
  return [...new Set(values.map((item) => {
    if (typeof item === "string") return item;
    return item?.url || item?.file_name || item?.src || "";
  }).map((item) => String(item || "").trim()).filter(Boolean))];
}

function attributeValueByName(attributes, name) {
  return normalizeArray(attributes).find((item) => String(item.name || "").includes(name))?.value || "";
}

function attributeValueByNames(attributes, names, ids = []) {
  const list = Array.isArray(names) ? names : [names];
  return findAttributeByNames(attributes, list, ids)?.value || "";
}

function extractOzonDescriptionText(source = {}, attributes = [], current = {}) {
  return String(
    source.description ||
    source.annotation ||
    source.description_text ||
    source.short_description ||
    attributeValueByNames(attributes, ["简介", "Аннотация", "Описание"], [4191]) ||
    current.description ||
    ""
  ).trim();
}

function extractOzonRichContent(source = {}, attributes = []) {
  const value = source.rich_content_json ||
    source.rich_content ||
    source.richContentJson ||
    source.richContent ||
    source.json_content ||
    source.jsonContent ||
    attributeValueByNames(attributes, ["JSON富内容", "Rich", "rich"], [11254]) ||
    "";
  if (!value) return { value: null, text: "" };
  if (typeof value === "string") return { value, text: value };
  return { value, text: JSON.stringify(value, null, 2) };
}

function splitTagValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function unwrapOzonProductDetail(detail = {}) {
  if (Array.isArray(detail)) return detail[0] || {};
  if (Array.isArray(detail?.items)) return detail.items[0] || {};
  if (Array.isArray(detail?.result?.items)) return detail.result.items[0] || {};
  if (Array.isArray(detail?.result)) return detail.result[0] || {};
  return detail?.result && typeof detail.result === "object" ? detail.result : detail;
}

function extractOzonDimensions(detail = {}, attributes = []) {
  const unit = String(detail.dimension_unit || detail.dimensions_unit || "").toLowerCase();
  const lengthRaw = detail.depth ?? detail.length ?? detail.package_length ?? attributeValueByNames(attributes, ["长度", "Длина"]);
  const widthRaw = detail.width ?? detail.package_width ?? attributeValueByNames(attributes, ["宽度", "Ширина"]);
  const heightRaw = detail.height ?? detail.package_height ?? attributeValueByNames(attributes, ["高度", "Высота"]);
  const weightUnit = String(detail.weight_unit || "").toLowerCase();
  return {
    length_cm: normalizeDimensionToMm(lengthRaw, unit),
    width_cm: normalizeDimensionToMm(widthRaw, unit),
    height_cm: normalizeDimensionToMm(heightRaw, unit),
    weight_g: normalizeWeightToGram(detail.weight ?? detail.package_weight ?? attributeValueByNames(attributes, ["重量", "Вес"]), weightUnit)
  };
}

function normalizeDimensionToMm(value, unit = "") {
  const number = numberFromOzonValue(value);
  if (!number) return 0;
  if (unit.includes("cm") || unit.includes("сm") || unit.includes("см")) return number * 10;
  if (unit.includes("m") && !unit.includes("mm") && !unit.includes("мм")) return number * 1000;
  return number;
}

function normalizeWeightToGram(value, unit = "") {
  const number = numberFromOzonValue(value);
  if (!number) return 0;
  if (unit.includes("kg") || unit.includes("кг")) return number * 1000;
  return number;
}

function numberFromOzonValue(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") return numberFromOzonValue(value.value ?? value.amount ?? value.price ?? "");
  const normalized = String(value || "").replace(",", ".").replace(/[^\d.-]/g, "");
  return Number(normalized || 0);
}

function importStatus(response) {
  const raw = response?.result?.status || response?.status || "";
  const text = String(raw || "").toLowerCase();
  if (text.includes("fail") || text.includes("error")) return "failed";
  if (text.includes("import") || text.includes("success") || text.includes("done")) return "imported";
  return text || "submitted";
}

function normalizeDraftRow(row) {
  return {
    ...row,
    source_urls: parseJson(row.source_urls_json, []),
    source_images: parseJson(row.source_images_json, []),
    manual_facts: parseJson(row.manual_facts_json, {}),
    ai_payload: parseJson(row.ai_payload_json, {})
  };
}

function normalizeCopyJobRow(row) {
  const response = parseJson(row.response_json, {});
  const detail = parseJson(row.product_detail_json, {});
  const detailError = detail?.error || "";
  return {
    ...row,
    request: parseJson(row.request_json, {}),
    response,
    product_detail: detailError ? null : detail,
    detail_error: detailError,
    unmatched_sku_list: response?.result?.unmatched_sku_list || response?.unmatched_sku_list || [],
    has_product_detail: Boolean(row.product_detail_json && !detailError),
    template_synced: row.status === "template_synced" || Boolean(row.product_detail_json && !detailError)
  };
}

function splitLines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  if (value == null || value === "") return [];
  return [value];
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function readListingMediaMultipart(req) {
  const contentType = String(req.headers["content-type"] || "");
  const match = contentType.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    const error = new Error("请使用 multipart/form-data 上传素材");
    error.status = 400;
    throw error;
  }
  const body = await readRequestBuffer(req, LISTING_MEDIA_MAX_BYTES + 1024 * 1024);
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  for (const part of splitMultipartBuffer(body, boundary)) {
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headerText = part.subarray(0, separator).toString("utf8");
    if (!/name="file"/i.test(headerText)) continue;
    return {
      filename: headerText.match(/filename="([^"]*)"/i)?.[1] || "upload",
      contentType: headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "",
      buffer: part.subarray(separator + 4)
    };
  }
  const error = new Error("未找到上传字段 file");
  error.status = 400;
  throw error;
}

async function readRequestBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("上架素材不能超过 200MB");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function splitMultipartBuffer(body, boundary) {
  const parts = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    let end = next;
    if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2;
    parts.push(body.subarray(start, end));
    start = next;
  }
  return parts;
}

function sanitizeListingMediaFilename(value) {
  const fallback = "upload";
  return path.basename(String(value || fallback)).replace(/[^\w.\-()\u4e00-\u9fa5]+/g, "_").slice(0, 160) || fallback;
}

function personId(session) {
  return Number(session?.personId || 0);
}

async function all(sql, params = []) {
  return mysqlQuery(sql, params);
}

async function row(sql, params = []) {
  const rows = await mysqlQuery(sql, params);
  return rows[0] || null;
}

async function insert(sql, params = []) {
  const result = await mysqlExecute(sql, params);
  return Number(result.insertId);
}

async function run(sql, params = []) {
  return mysqlExecute(sql, params);
}

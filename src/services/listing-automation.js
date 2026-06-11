import { config } from "../config.js";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { shanghaiDateKey } from "../shanghai-time.js";
import {
  createOzonProductBySku,
  fetchOzonCategoryAttributeValues,
  fetchOzonCategoryAttributes,
  fetchOzonDescriptionCategoryTree,
  fetchOzonProductImportInfo,
  fetchOzonProductContentRating,
  fetchOzonProductInfoAttributes,
  fetchOzonProductsByIds,
  importOzonProducts,
  searchOzonCategoryAttributeValues
} from "../ozonClient.js";
import { chatWithAiProvider } from "./ai-provider-settings.js";
import {
  createProductMysql,
  onlineProductEditDraftMysql,
  selectionProductMysql
} from "./mysql-cutover.js";
import {
  listingDraftToTemplatePayload,
  prepareListingDraftFromCollectedSource
} from "./listing-draft-preparer.js";
import { normalizeCollectedListingDraft } from "./listing-collected-normalizer.js";
import { standardizeListingTemplatePayload } from "./listing-template-standardizer.js";
import { getAiTaskFile } from "../server/services/ai/aiWorkflowService.js";

let mysqlSchemaReady = false;
const LISTING_MEDIA_ROOTS = resolveListingMediaRoots();
const LISTING_MEDIA_ROOT = LISTING_MEDIA_ROOTS[0];
const SHOP_WATERMARK_ROOTS = [
  path.resolve(process.cwd(), "uploads", "shop-watermarks"),
  path.resolve(process.cwd(), "..", "..", "uploads", "shop-watermarks")
];
const LISTING_MEDIA_MAX_BYTES = 200 * 1024 * 1024;
const LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS = 20000;
const LISTING_MEDIA_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"]
]);
const PRICE_STRATEGY_MULTIPLY_ON_PUBLISH = "multiply_on_publish";
const PRICE_STRATEGY_FINALIZED = "finalized";
const ATTRIBUTE_VALUE_CACHE_TTL_MS = 5 * 60 * 1000;
const COLOR_ATTRIBUTE_VALUE_CACHE_TTL_MS = 30 * 60 * 1000;
const COLOR_ATTRIBUTE_IDS = new Set([10096, 22814]);
const LISTING_PUBLISH_SHOP_SELECT = `
  SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint,
    watermark_path, watermark_name, watermark_position, watermark_x_percent, watermark_y_percent,
    watermark_scale_percent, watermark_opacity_percent
  FROM shops
`;
const attributeValueMemoryCache = new Map();

function listingPublishRecordNotFoundError() {
  const error = new Error("\u4e0a\u67b6\u8bb0\u5f55\u4e0d\u5b58\u5728");
  error.status = 404;
  return error;
}

function resolveListingMediaRoots() {
  const roots = [];
  const add = (target) => {
    const resolved = path.resolve(target);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  add(path.resolve(process.cwd(), "public", "uploads", "listing-media"));
  const workspaceRoot = path.resolve(process.cwd(), "..", "..");
  if (fsSync.existsSync(path.join(workspaceRoot, "package.json")) && fsSync.existsSync(path.join(workspaceRoot, "src", "server.js"))) {
    add(path.join(workspaceRoot, "public", "uploads", "listing-media"));
  }
  return roots;
}

async function writeListingMediaFile(storedName, buffer) {
  let primaryPath = "";
  for (const root of LISTING_MEDIA_ROOTS) {
    await fs.mkdir(root, { recursive: true });
    const targetPath = path.join(root, storedName);
    await fs.writeFile(targetPath, buffer);
    if (!primaryPath) primaryPath = targetPath;
  }
  return primaryPath;
}

export async function listingCategoryTemplates(session) {
  await ensureListingAutomationSchema();
  return all(`
    SELECT t.id, t.ozon_category_id, t.category_name, t.template_name, t.source_type,
      t.source_ozon_sku, t.source_shop_id, t.title, t.updated_at, t.status,
      p.name AS created_by_name
    FROM listing_category_templates t
    LEFT JOIN people p ON p.id = t.created_by_person_id
    WHERE t.status <> 'deleted'
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT 100
  `).then((rows) => rows.map(compactListingTemplateReference));
}

export async function listingCategoryTemplateDetail(id, session, query = {}) {
  await ensureListingAutomationSchema();
  const editorMode = query?.mode === "editor" || query?.editor === "1" || query?.compact === "1";
  const template = autoFillCategoryTypeAttribute(await listingCategoryTemplate(id, session));
  if (!template) throw new Error("Listing category template not found");
  if (editorMode) return compactTemplateForEditor(template);
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
  if (!Number.isFinite(sku) || sku <= 0) throw new Error("璇疯緭鍏?Ozon 鍓嶅彴 SKU");
  if (!shopId) throw new Error("Please select a shop for product copy");

  const shop = await row("SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint FROM shops WHERE id = ? AND status <> 'deleted'", [shopId]);
  if (!shop) throw new Error("Shop not found");

  const offerId = String(body?.offer_id || body?.offerId || `COPY-${sku}-${Date.now().toString(36)}`).slice(0, 128);
  const name = String(body?.name || body?.product_name || `Ozon SKU ${sku} 鏈湴妯℃澘`).trim();
  const templateName = String(body?.template_name || body?.templateName || body?.local_template_name || body?.localTemplateName || `SKU ${sku} 妯℃澘`).trim();
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
  if (!job) throw new Error("Copy job not found");
  if (!job.task_id) return job;
  const shop = await row("SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint FROM shops WHERE id = ?", [job.shop_id]);
  if (!shop) throw new Error("Shop not found");
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
  const totalStarted = Date.now();
  const traceId = aiVariantSaveTraceId(body);
  logAiVariantSavePerf(traceId, "backend.template.create.start", totalStarted, {
    templateName: String(body?.template_name || body?.templateName || "").slice(0, 120)
  });
  let stageStarted = Date.now();
  await ensureListingAutomationSchema();
  logAiVariantSavePerf(traceId, "backend.template.ensure_schema", stageStarted);
  stageStarted = Date.now();
  let payload = normalizeTemplatePayload(body);
  logAiVariantSavePerf(traceId, "backend.template.normalize", stageStarted, {
    imageCount: normalizeArray(payload.images).length,
    variantCount: normalizeArray(payload.editable_payload?.variants).length
  });
  if (!payload.ozon_category_id) throw new Error("Ozon 绫荤洰 ID 涓嶈兘涓虹┖");
  if (!payload.category_name) throw new Error("绫荤洰鍚嶇О涓嶈兘涓虹┖");
  if (!payload.template_name) throw new Error("妯℃澘鍚嶇О涓嶈兘涓虹┖");

  stageStarted = Date.now();
  payload = await materializeAiOptimizationTemplateMedia(payload, session);
  logAiVariantSavePerf(traceId, "backend.template.materialize_media", stageStarted, {
    imageCount: normalizeArray(payload.images).length,
    variantCount: normalizeArray(payload.editable_payload?.variants).length
  });

  stageStarted = Date.now();
  const id = await insert(`
    INSERT INTO listing_category_templates
    (ozon_category_id, category_name, template_name, required_attributes_json, ai_rules_json, title_prompt,
     description_prompt, image_rules_json, source_type, source_ozon_sku, source_raw_json,
     editable_payload_json, title, description, attributes_json, images_json,
     created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    payload.ozon_category_id,
    payload.category_name,
    payload.template_name,
    JSON.stringify(payload.required_attributes),
    JSON.stringify(payload.ai_rules),
    payload.title_prompt,
    payload.description_prompt,
    JSON.stringify(payload.image_rules),
    payload.source_type || "manual",
    payload.source_ozon_sku || "",
    JSON.stringify(payload.source_raw || {}),
    JSON.stringify(payload.editable_payload),
    payload.title,
    payload.description,
    JSON.stringify(payload.attributes),
    JSON.stringify(payload.images),
    personId(session)
  ]);
  logAiVariantSavePerf(traceId, "backend.template.insert", stageStarted, { templateId: id });
  stageStarted = Date.now();
  await recordOzonCategoryUsage({
    sourceModule: "listing_template",
    sourceId: String(id),
    ozonCategoryId: payload.ozon_category_id,
    categoryName: payload.category_name
  });
  logAiVariantSavePerf(traceId, "backend.template.record_category_usage", stageStarted, { templateId: id });
  stageStarted = Date.now();
  const detail = await listingCategoryTemplate(id, session);
  logAiVariantSavePerf(traceId, "backend.template.detail", stageStarted, { templateId: id });
  logAiVariantSavePerf(traceId, "backend.template.create.done", totalStarted, { templateId: id });
  return detail;
}

export async function createListingTemplateFromCollectedProduct(body, session) {
  await ensureListingAutomationSchema();
  const payload = buildTemplatePayloadFromCollectedProduct(body || {});
  if (!payload.ozon_category_id) throw new Error("閲囬泦鏁版嵁缂哄皯绫荤洰 ID锛岃鎵嬪姩琛ュ厖鍚庡啀瀵煎叆");
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
  await recordOzonCategoryUsage({
    sourceModule: "listing_template",
    sourceId: String(id),
    ozonCategoryId: payload.ozon_category_id,
    categoryName: payload.category_name
  });

  return {
    ok: true,
    reused: false,
    template: await listingCategoryTemplate(id, session)
  };
}

function firstCollectedValue(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function collectedNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/\s+/g, "").replace(",", ".");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectedDate(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return shanghaiDateKey();
  return shanghaiDateKey(parsed);
}

function collectedDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value || "").slice(0, 10);
  return shanghaiDateKey(parsed);
}

function normalizePluginCollectedProduct(product = {}, tenantId = "admin") {
  const sku = String(firstCollectedValue(product, ["sku", "product_id", "productId", "id"]) || "").trim();
  const image = firstCollectedValue(product, ["productImage", "mainImage", "primary_image", "photo", "image_url", "imageUrl"]) ||
    (Array.isArray(product.images) ? product.images.find(Boolean) : "");
  const collectedAt = String(product.collectedAt || product.collected_at || new Date().toISOString());
  const viewCount = collectedNumber(firstCollectedValue(product, ["qtyViewPdp", "views", "hitsView", "hits_view", "sessionCount"]));
  const soldCount = collectedNumber(firstCollectedValue(product, ["soldCount", "orders", "orderCount", "avgOrdersOnAccDays"]));
  const clickRate = collectedNumber(firstCollectedValue(product, ["custom_click_rate", "clickRate", "click_rate"]));
  const conversionRate = collectedNumber(firstCollectedValue(product, ["convViewToOrder", "conversionRate", "conversion_rate"]));

  return {
    tenant_id: String(tenantId || "admin").trim() || "admin",
    sku,
    product_id: String(firstCollectedValue(product, ["product_id", "productId", "id"]) || sku).trim(),
    title: String(firstCollectedValue(product, ["productTitle", "name", "title", "displayName", "display_name"]) || "").trim(),
    product_url: String(firstCollectedValue(product, ["productUrl", "productLink", "link"]) || "").trim(),
    image_url: String(image || "").trim(),
    category_name: deriveCollectedCategoryName(product),
    price: collectedNumber(firstCollectedValue(product, ["price", "productPrice", "sell_price", "cardPrice", "webPrice"])),
    currency: String(firstCollectedValue(product, ["currency", "priceCurrency"]) || "RUB").trim(),
    sold_count: soldCount,
    view_count: viewCount,
    click_rate: clickRate,
    conversion_rate: conversionRate,
    stock_count: collectedNumber(firstCollectedValue(product, ["stock", "fbsStock", "fboStock", "availableStock", "totalStock", "sumItemsInStock"])),
    commission_rate: collectedNumber(firstCollectedValue(product, ["commission_rate", "commissionRate", "commission_percent", "commissionPercent", "commission"])),
    collect_date: collectedDate(collectedAt),
    collected_at: collectedAt
  };
}

function deriveCollectedCategoryName(source = {}) {
  const candidates = [
    source.category_name,
    source.categoryName,
    source.category,
    source.description_category_name,
    source.descriptionCategoryName,
    source.type_name,
    source.typeName,
    source.category3,
    source.category2,
    source.path_zh,
    source.pathZh,
    source.path_ru,
    source.pathRu
  ];
  const arrayCandidates = [
    source.category_names,
    source.categoryNames,
    source.categories,
    source.category_path
  ];
  for (const values of arrayCandidates) {
    if (Array.isArray(values)) {
      const text = values.map((item) => String(item || "").trim()).filter(Boolean).join("/");
      if (text) candidates.push(text);
    }
  }
  return String(candidates.find((value) => String(value || "").trim()) || "").trim();
}

function parseCollectedPayloadJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function buildPluginCollectedProductPayload(row = {}) {
  const raw = parseCollectedPayloadJson(row.payload_json);
  return {
    ...raw,
    id: row.sku || raw.id || raw.sku,
    sku: row.sku || raw.sku || "",
    product_id: row.product_id || raw.product_id || raw.productId || "",
    productTitle: row.title || raw.productTitle || raw.name || raw.title || "",
    name: row.title || raw.name || raw.productTitle || raw.title || "",
    productUrl: row.product_url || raw.productUrl || raw.productLink || "",
    productImage: row.image_url || raw.productImage || raw.mainImage || "",
    category: row.category_name || raw.category || raw.categoryName || "",
    price: row.price ?? raw.price ?? raw.productPrice ?? "",
    currency: row.currency || raw.currency || "RUB",
    soldCount: row.sold_count ?? raw.soldCount ?? "",
    qtyViewPdp: row.view_count ?? raw.qtyViewPdp ?? "",
    custom_click_rate: row.click_rate ?? raw.custom_click_rate ?? "",
    convViewToOrder: row.conversion_rate ?? raw.convViewToOrder ?? "",
    stock: row.stock_count ?? raw.stock ?? "",
    commission_rate: row.commission_rate ?? raw.commission_rate ?? raw.commissionRate ?? "",
    collectDate: collectedDateKey(row.collect_date),
    collectedAt: row.collected_at || raw.collectedAt || raw.collected_at || ""
  };
}

function buildCollectorBoxRow(row = {}) {
  const hasRawPayload = Object.prototype.hasOwnProperty.call(row, "payload_json");
  const hasEditPayload = Object.prototype.hasOwnProperty.call(row, "edit_payload_json");
  const rawPayload = hasRawPayload ? parseCollectedPayloadJson(row.payload_json) : {};
  const editPayload = hasEditPayload ? parseCollectedPayloadJson(row.edit_payload_json) : {};
  const imageUrl = collectorBoxDisplayImageUrl(row, editPayload, rawPayload);
  return {
    tenant_id: row.tenant_id || "admin",
    sku: String(row.sku || ""),
    product_id: String(row.product_id || ""),
    title: String(row.title || ""),
    product_url: String(row.product_url || ""),
    image_url: imageUrl,
    original_image_url: String(row.image_url || ""),
    category_name: String(row.category_name || deriveCollectedCategoryName(editPayload) || deriveCollectedCategoryName(rawPayload) || "").trim(),
    category_hint: deriveCollectedCategoryName(editPayload) || deriveCollectedCategoryName(rawPayload) || "",
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    currency: String(row.currency || "RUB"),
    sold_count: row.sold_count === null || row.sold_count === undefined ? null : Number(row.sold_count),
    view_count: row.view_count === null || row.view_count === undefined ? null : Number(row.view_count),
    click_rate: row.click_rate === null || row.click_rate === undefined ? null : Number(row.click_rate),
    conversion_rate: row.conversion_rate === null || row.conversion_rate === undefined ? null : Number(row.conversion_rate),
    stock_count: row.stock_count === null || row.stock_count === undefined ? null : Number(row.stock_count),
    commission_rate: row.commission_rate === null || row.commission_rate === undefined ? null : Number(row.commission_rate),
    collect_date: collectedDateKey(row.collect_date),
    collected_at: row.collected_at || "",
    status: row.status || "collected",
    selection_product_id: row.selection_product_id || null,
    listing_template_id: row.listing_template_id || null,
    editPayload,
    edited_at: row.edited_at || "",
    created_at: row.created_at || "",
    updated_at: row.updated_at || ""
  };
}

function collectorBoxDisplayImageUrl(row = {}, editPayload = {}, rawPayload = {}) {
  const candidates = collectorBoxImageSources({ image_url: row.image_url, editPayload, rawPayload });
  return String(candidates.map((item) => item?.url || item).find(Boolean) || "").trim();
}

function collectorBoxTemplateSnapshot(detail = {}) {
  return objectValue(detail.templateSnapshot || detail.template_snapshot || detail.listingTemplate || detail.listing_template || detail.template);
}

function collectorBoxTemplateImages(detail = {}) {
  const template = collectorBoxTemplateSnapshot(detail);
  const editable = objectValue(template.editable_payload || template.editablePayload);
  return normalizeImages([
    ...normalizeArray(template.images || template.images_json),
    ...normalizeArray(editable.images)
  ]);
}

function collectorBoxImageSources(detail = {}, editInput = null) {
  const payload = objectValue(detail.payload || {});
  const raw = objectValue(detail.rawPayload || detail.raw_payload || {});
  const editPayload = objectValue(editInput || detail.editPayload || detail.edit_payload || {});
  const templateImages = collectorBoxTemplateImages(detail);
  const editedImages = normalizeImages(editPayload.images || editPayload.image_urls || editPayload.imageUrls || []);
  const editedVariantImages = normalizeArray(editPayload.variants || editPayload.editorVariants || editPayload.editor_variants)
    .flatMap((variant) => normalizeImages(variant?.images || variant?.image_urls || variant?.imageUrls || []));
  const rawImages = normalizeImages(raw.images || raw.image_urls || raw.imageUrls || payload.images || []);
  const groups = [
    templateImages,
    [...editedImages, ...editedVariantImages],
    rawImages,
    [detail.image_url, raw.productImage, raw.mainImage]
  ];
  return groups.find((items) => items.some((item) => String(item?.url || item || "").trim())) || [];
}

function normalizeCollectorBoxSummary(row = {}) {
  return {
    total: Number(row.total || 0),
    todayCount: Number(row.today_count || 0),
    titledCount: Number(row.titled_count || 0)
  };
}

function percentToNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? (value > 1 ? value / 100 : value) : 0;
  const text = String(value).trim();
  const number = Number(text.replace("%", "").replace(",", "."));
  if (!Number.isFinite(number)) return 0;
  return text.includes("%") || number > 1 ? number / 100 : number;
}

function buildCollectorSelectionNote(detail = {}) {
  const parts = [
    "Source: Ozon collector box",
    detail.sku ? `SKU: ${detail.sku}` : "",
    detail.product_url ? `Link: ${detail.product_url}` : "",
    detail.collect_date ? `Collected at: ${detail.collect_date}` : ""
  ].filter(Boolean);
  return parts.join("\n");
}

function selectionTextValue(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(selectionTextValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return String(value.display_value_zh || value.displayValueZh || value.zh || value.label || value.name || value.text || value.display_value || value.displayValue || value.value || "").trim();
  }
  return String(value || "").trim();
}

function selectionAttributeValue(attributes = [], names = [], ids = []) {
  const field = findAttributeByNames(attributes, Array.isArray(names) ? names : [names], ids);
  if (!field) return "";
  return translateCommonSelectionValue(selectionTextValue(
    field.selected_values?.length ? field.selected_values :
      field.selectedValues?.length ? field.selectedValues :
        field.values?.length ? field.values :
          field.value
  ));
}

function selectionAttributeSummary(attributes = []) {
  return normalizeAttributes(attributes)
    .map((item) => {
      const name = String(item.name || item.attribute_name || item.attributeId || item.attribute_id || "").trim();
      const value = selectionTextValue(item.value || item.values || item.selected_values || item.selectedValues);
      return name && value ? `${name}锛?{value}` : "";
    })
    .filter(Boolean)
    .slice(0, 30)
    .join("\n");
}

function translateCommonSelectionValue(value = "") {
  const text = String(value || "").trim();
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const map = new Map([
    ["abs 锌谢邪褋褌懈泻", "ABS濉戞枡"],
    ["abs-锌谢邪褋褌懈泻", "ABS濉戞枡"],
    ["锌谢邪褋褌懈泻", "濉戞枡"],
    ["褌械褉屑芯锌谢邪褋褌懈褔薪褘泄 锌芯谢懈褍褉械褌邪薪", "鐑鎬ц仛姘ㄩ叝"],
    ["褌锌褍", "TPU"],
    ["tpu", "TPU"],
    ["褔械褉薪褘泄", "榛戣壊"],
    ["褔褢褉薪褘泄", "榛戣壊"],
    ["斜械谢褘泄", "鐧借壊"],
    ["褋懈薪懈泄", "钃濊壊"],
    ["泻褉邪褋薪褘泄", "绾㈣壊"],
    ["褋械褉褘泄", "鐏拌壊"],
    ["褋械褉械斜褉懈褋褌褘泄", "閾惰壊"],
    ["蟹芯谢芯褌芯泄", "閲戣壊"],
    ["锌褉芯蟹褉邪褔薪褘泄", "閫忔槑"]
  ]);
  return map.get(normalized) || text;
}

function safeSelectionColorValue(value = "") {
  const text = translateCommonSelectionValue(value);
  if (!text) return "";
  if (text.length > 24) return "";
  if (/褔械褏芯谢|斜褉械谢|邪胁褌芯褋懈谐薪邪谢|屑芯写械谢|褕褌\.|写谢褟\s/i.test(text)) return "";
  return text;
}

function collectorCategoryFields(detail = {}, body = {}) {
  const payload = objectValue(detail.payload || {});
  const raw = objectValue(detail.rawPayload || detail.raw_payload || {});
  const normalized = objectValue(raw.normalized || payload.normalized || detail.normalized || {});
  const editInput = objectValue(body.editPayload || body.edit_payload || detail.editPayload || detail.edit_payload || {});
  const descriptionCategoryId = String(
    body.ozon_description_category_id || body.description_category_id ||
    editInput.ozon_description_category_id || editInput.description_category_id || editInput.descriptionCategoryId ||
    raw.ozon_description_category_id || raw.description_category_id || raw.descriptionCategoryId ||
    payload.ozon_description_category_id || payload.description_category_id || payload.descriptionCategoryId ||
    normalized.ozon_description_category_id || normalized.description_category_id || normalized.descriptionCategoryId ||
    ""
  ).trim();
  const typeId = String(
    body.ozon_type_id || body.type_id ||
    editInput.ozon_type_id || editInput.type_id || editInput.typeId ||
    raw.ozon_type_id || raw.type_id || raw.typeId ||
    payload.ozon_type_id || payload.type_id || payload.typeId ||
    normalized.ozon_type_id || normalized.type_id || normalized.typeId ||
    ""
  ).trim();
  const categoryId = String(
    body.ozon_category_id || editInput.ozon_category_id ||
    raw.ozon_category_id || raw.category_id || raw.categoryId ||
    payload.ozon_category_id || payload.category_id || payload.categoryId ||
    normalized.ozon_category_id || normalized.category_id || normalized.categoryId ||
    (descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : "")
  ).trim();
  return {
    ozon_category_id: categoryId,
    ozon_description_category_id: descriptionCategoryId,
    ozon_type_id: typeId,
    ozon_category_name: String(
      body.ozon_category_name || body.category_name ||
      editInput.ozon_category_name || editInput.category_name || editInput.categoryName ||
      detail.category_name || raw.category_name || raw.categoryName || raw.category ||
      payload.category_name || payload.categoryName || payload.category ||
      normalized.category_name || normalized.categoryName || ""
    ).trim()
  };
}

function buildCollectorSelectionVariants(detail = {}, body = {}) {
  const payload = objectValue(detail.payload || {});
  const raw = objectValue(detail.rawPayload || detail.raw_payload || {});
  const editInput = objectValue(body.editPayload || body.edit_payload || detail.editPayload || detail.edit_payload || {});
  const rows = collectCollectedVariantRows(detail, editInput, raw);
  const baseImages = normalizeImages(collectorBoxImageSources(detail, editInput));
  const baseDimensions = normalizeCollectedDimensions(editInput, payload, raw, detail);
  const baseTags = normalizeTagList(editInput.tags || editInput.hashtags || raw.hashtags || payload.hashtags || []);
  const source = {
    ...raw,
    ...payload,
    ...detail,
    title: editInput.title || payload.productTitle || raw.title || detail.title,
    images: baseImages
  };
  if (rows.length) {
    return rows.map((item, index) => ({
      ...normalizeCollectedVariant({
        ...item,
        images: collectedVariantImages(item, baseImages, rows.length > 1)
      }, source, baseDimensions, baseTags, index),
      selection_key: variantSelectionKey(item, index)
    }));
  }
  return [normalizeCollectedVariant({
    sku: detail.sku || raw.sku || payload.sku || "",
    title: editInput.title || payload.productTitle || raw.title || detail.title || "",
    images: baseImages,
    price: detail.price || raw.price || raw.productPrice || payload.price,
    old_price: raw.originalPrice || raw.old_price,
    hashtags: baseTags,
    description: editInput.description || raw.description || payload.description || ""
  }, source, baseDimensions, baseTags, 0)];
}

function variantSelectionKey(variant = {}, index = 0) {
  return String(variant.selection_key || variant.sku || variant.source_sku || variant.offer_id || variant.source_offer_id || variant.variantId || variant.variant_id || variant.id || index).trim();
}

function selectedCollectorVariants(variants = [], body = {}) {
  const requestSelections = normalizeArray(body.variantSelections || body.variant_selections || body.variants);
  const explicitSelections = requestSelections.length
    ? requestSelections.filter((item) => item?.selected !== false && item?.enabled !== false)
    : [];
  const selectedKeys = new Set([
    ...normalizeArray(body.selectedVariantKeys || body.selected_variant_keys),
    ...explicitSelections.map((item, index) => item.key || item.sku || item.source_sku || item.offer_id || item.variantId || item.variant_id || index)
  ].map((item) => String(item || "").trim()).filter(Boolean));
  let selected = selectedKeys.size
    ? variants.filter((variant, index) => selectedKeys.has(variantSelectionKey(variant, index)))
    : variants;
  const requestedCount = Number(body.variantCount || body.variant_count || 0);
  if (requestedCount > 0) selected = selected.slice(0, requestedCount);
  return selected.length ? selected : variants.slice(0, 1);
}

export function buildSelectionProductBodiesFromCollectorBox(detail = {}, body = {}, session = null) {
  const payload = objectValue(detail.payload || {});
  const raw = objectValue(detail.rawPayload || detail.raw_payload || {});
  const editInput = objectValue(body.editPayload || body.edit_payload || body || {});
  const variants = buildCollectorSelectionVariants(detail, body);
  const selectedVariants = selectedCollectorVariants(variants, body);
  const baseDimensions = normalizeCollectedDimensions(editInput, payload, raw, detail);
  const baseImages = normalizeImages(collectorBoxImageSources(detail, editInput))
    .map((item) => String(item?.url || item || "").trim())
    .filter(Boolean);
  const baseAttributes = normalizeAttributes(raw.attributes || payload.attributes || editInput.attributes || []);
  const numberOrFallback = (value, fallback = 0) => {
    if (value === "" || value === null || value === undefined) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  return selectedVariants.map((variant, index) => {
    const variantImages = normalizeImages(variant.images || []).map((item) => String(item?.url || item || "").trim()).filter(Boolean);
    const imageUrls = variantImages.length ? variantImages : baseImages;
    const attributes = mergeAttributesByKey(baseAttributes, variant.attributes || []);
    const attributeSummary = selectionAttributeSummary(attributes);
    const variantTitle = String(variant.title || variant.name || payload.productTitle || detail.title || `Ozon ${variant.sku || detail.sku}`).trim();
    const tags = normalizeTagList(variant.main_tags || variant.hashtags || editInput.tags || raw.hashtags || payload.hashtags || []);
    const description = String(variant.description || editInput.description || raw.description || payload.description || "").trim();
    const dims = normalizeCollectedDimensions(variant, baseDimensions);
    const categoryFields = collectorCategoryFields(detail, body);
    const materialValue = translateCommonSelectionValue(body.material || editInput.material || variant.material || selectionAttributeValue(attributes, ["鏉愯川", "鏉愭枡", "袦邪褌械褉懈邪谢"], [7199, 8224, 22861]) || raw.material || "");
    const colorValue = safeSelectionColorValue(body.color || editInput.color || selectionAttributeValue(attributes, ["鍟嗗搧棰滆壊", "棰滆壊", "笑胁械褌"], [10096, 8229, 22814]) || raw.color || "");
    const vehicleModelValue = String(
      body.vehicle_model || body.vehicleModel || editInput.vehicle_model || editInput.vehicleModel ||
      variant.vehicle_model || variant.vehicleModel ||
      selectionAttributeValue(attributes, ["杞﹀瀷", "姹借溅鍨嬪彿", "袦芯写械谢褜 邪胁褌芯屑芯斜懈谢褟", "袦芯写械谢褜 孝小"], [7212])
    ).trim();
    const selectionNote = [
      buildCollectorSelectionNote(detail),
      selectedVariants.length > 1 ? `鍙樹綋锛?{index + 1}/${selectedVariants.length}` : "",
      variant.sku ? `鍙樹綋SKU锛?{variant.sku}` : "",
      attributeSummary ? `鍙鐢ㄥ睘鎬э細\n${attributeSummary}` : "",
      body.supplier_note || body.operation_note || ""
    ].filter(Boolean).join("\n");
    return {
      name: String(body.name || body.internal_product_name || variantTitle).trim(),
      image_url: imageUrls[0] || body.image_url || detail.image_url || "",
      detail_image_urls: imageUrls.slice(1),
      purchase_url: body.purchase_url || detail.product_url || payload.productUrl || "",
      source_platform: body.source_platform || "Ozon",
      supplier_note: selectionNote,
      ozon_category_id: categoryFields.ozon_category_id,
      ozon_description_category_id: categoryFields.ozon_description_category_id,
      ozon_type_id: categoryFields.ozon_type_id,
      ozon_category_name: categoryFields.ozon_category_name,
      material: materialValue,
      color: colorValue,
      vehicle_brand: body.vehicle_brand || body.vehicleBrand || editInput.brand || selectionAttributeValue(attributes, ["袦邪褉泻邪", "斜褉械薪写 邪胁褌芯屑芯斜懈谢褟", "閫傜敤鍝佺墝", "鍝佺墝"], [85]) || raw.brand || "",
      vehicle_model: vehicleModelValue,
      selling_points: body.selling_points || editInput.selling_points || description || raw.description || "",
      listing_title_ru: body.listing_title_ru || body.listingTitleRu || variantTitle,
      listing_tags_ru: body.listing_tags_ru || body.listingTagsRu || tags.join("\n"),
      listing_description_ru: body.listing_description_ru || body.listingDescriptionRu || description,
      purchase_cost: numberOrFallback(body.purchase_cost, 0),
      domestic_shipping: numberOrFallback(body.domestic_shipping, 0),
      handling_fee: numberOrFallback(body.handling_fee, 0),
      purchase_quantity: numberOrFallback(body.purchase_quantity || body.quantity || editInput.purchase_quantity || editInput.quantity || variant.stock, 1),
      package_weight_g: numberOrFallback(body.package_weight_g || body.weight_g || variant.weight_g || dims.weight_g || raw.weight_g || raw.custom_weight, 0),
      length_cm: numberOrFallback(body.length_cm || variant.length_cm || dims.length_cm, 30),
      width_cm: numberOrFallback(body.width_cm || variant.width_cm || dims.width_cm, 20),
      height_cm: numberOrFallback(body.height_cm || variant.height_cm || dims.height_cm, 10),
      listing_price_rub: numberOrFallback(body.listing_price_rub || body.label_price || variant.price || detail.price || raw.price || raw.productPrice, 0),
      air_sale_price_rmb: numberOrFallback(body.sale_price || raw.priceCny || raw.soldSumCny, 0),
      exchange_rate: numberOrFallback(body.exchange_rate, undefined),
      advertising_rate: percentToNumber(raw.drr || raw.advertising_rate || 0),
      return_rate: percentToNumber(raw.nullableRedemptionRate || raw.return_rate || 0.05),
      product_type: "selection",
      selection_status: "draft",
      created_by_person_id: session?.personId || null,
      owner_person_id: body.owner_person_id || session?.personId || null,
      variant_type: selectedVariants.length > 1 ? "collector_box_variant" : "",
      variant_result_id: String(variant.sku || variant.source_sku || ""),
      __variant: variant
    };
  });
}

function normalizeCollectorBoxEditPayload(input = {}, detail = {}) {
  const raw = detail.rawPayload || {};
  const payload = detail.payload || {};
  const dims = normalizeCollectedDimensions(input, payload, raw);
  const images = normalizeImages(input.images || collectorBoxImageSources(detail, input));
  const attributes = normalizeAttributes(input.attributes || input.attribute_values || input.characteristics || []);
  const variants = normalizeArray(input.variants || input.editorVariants || input.editor_variants);
  const richContent = input.rich_content_json || input.richContentJson || input.rich_content || input.richContent || input.json_content || input.jsonContent || "";
  return {
    title: String(input.title || input.productTitle || detail.title || payload.productTitle || `Ozon ${detail.sku || ""}`).trim(),
    template_name: String(input.template_name || input.templateName || input.title || detail.title || `Ozon ${detail.sku || ""} 涓婃灦妯℃澘`).trim(),
    category_name: String(input.category_name || input.categoryName || detail.category_name || raw.category_name || raw.category || "").trim(),
    ozon_category_id: String(input.ozon_category_id || input.ozonCategoryId || raw.ozon_category_id || raw.category_id || "").trim(),
    description_category_id: String(input.description_category_id || input.descriptionCategoryId || raw.description_category_id || raw.descriptionCategoryId || "").trim(),
    type_id: String(input.type_id || input.typeId || raw.type_id || raw.typeId || "").trim(),
    brand: String(input.brand || raw.brand || "").trim(),
    model: String(input.model || input.spec || raw.model || "").trim(),
    color: String(input.color || raw.color || "").trim(),
    tags: normalizeStringList(input.tags || input.hashtags || raw.hashtags || []),
    description: String(input.description || input.summary || raw.description || "").trim(),
    operation_note: String(input.operation_note || input.operationNote || "").trim(),
    price: numberFromOzonValue(input.price || detail.price || raw.price || 0),
    old_price: numberFromOzonValue(input.old_price || input.oldPrice || raw.old_price || raw.originalPrice || 0),
    currency: String(input.currency || detail.currency || raw.currency || "RUB").trim() || "RUB",
    length_cm: Number(dims.length_cm || input.length_cm || 0),
    width_cm: Number(dims.width_cm || input.width_cm || 0),
    height_cm: Number(dims.height_cm || input.height_cm || 0),
    weight_g: Number(dims.weight_g || input.weight_g || 0),
    images,
    attributes,
    variants,
    rich_content_json: typeof richContent === "string" ? richContent : (richContent ? JSON.stringify(richContent) : ""),
    source_sku: String(detail.sku || input.sku || raw.sku || "").trim(),
    product_url: String(detail.product_url || input.product_url || raw.productUrl || "").trim(),
    updated_by_person_id: detail.updated_by_person_id || null
  };
}

function buildCollectorBoxEditAttributes(editPayload = {}, raw = {}) {
  const attributes = normalizeAttributes([
    ...normalizeArray(raw.attributes || raw.attribute_values || raw.characteristics || []),
    ...normalizeArray(raw.ozonProductIntelligence?.attributes || raw.ozonProductIntelligence?.attribute_values || []),
    ...normalizeArray(raw.ozonErpDetail?.attributes || raw.ozonErpDetail?.attribute_values || []),
    ...normalizeArray(editPayload.attributes || [])
  ]);
  const upsert = (name, value, defaults = {}) => {
    if (value === undefined || value === null || value === "") return;
    const matched = attributes.find((item) => {
      if (defaults.attribute_id && String(item.attribute_id || item.id || "") === String(defaults.attribute_id)) return true;
      return String(item.name || "").trim() === name;
    });
    if (matched) {
      matched.value = value;
      if (defaults.attribute_id && !matched.attribute_id) matched.attribute_id = defaults.attribute_id;
      if (defaults.type && !matched.type) matched.type = defaults.type;
    } else {
      attributes.push({ name, value, type: defaults.type || "text", attribute_id: defaults.attribute_id || "", source: "collector_edit" });
    }
  };
  const richContent = editPayload.rich_content_json || editPayload.richContentJson || editPayload.rich_content || editPayload.richContent || raw.rich_content_json || raw.richContentJson || raw.rich_content || raw.richContent || raw.json_content || raw.jsonContent;
  upsert("Brand", editPayload.brand || raw.brand || "No brand", { attribute_id: 85, fixed_candidate: true });
  upsert("鍨嬪彿鍚嶇О", editPayload.model, { attribute_id: 9048, fixed_candidate: true });
  upsert("棰滆壊", editPayload.color);
  upsert("浜у搧鏍囩", normalizeStringList(editPayload.tags).join(","), { attribute_id: 23171, type: "multiselect", fixed_candidate: true });
  upsert("Description", editPayload.description, { attribute_id: 4191, type: "textarea", fixed_candidate: true });
  upsert("Rich content JSON", typeof richContent === "string" ? richContent : (richContent ? JSON.stringify(richContent, null, 2) : ""), { attribute_id: 11254, type: "rich_json", fixed_candidate: true });
  return attributes;
}

function collectedCategoryCandidates(raw = {}, detail = {}, body = {}) {
  const candidates = [];
  const typeOnlyCandidates = [];
  const push = (descriptionCategoryId, typeId, source = "unknown") => {
    const descriptionId = Number(descriptionCategoryId || 0);
    const productTypeId = Number(typeId || 0);
    if (!descriptionId || !productTypeId) return;
    if (candidates.some((item) => item.descriptionCategoryId === descriptionId && item.typeId === productTypeId)) return;
    candidates.push({ descriptionCategoryId: descriptionId, typeId: productTypeId, source });
  };
  const pushTypeOnly = (typeId, source = "unknown") => {
    const productTypeId = Number(typeId || 0);
    if (!productTypeId || typeOnlyCandidates.some((item) => item.typeId === productTypeId)) return;
    typeOnlyCandidates.push({ typeId: productTypeId, source });
  };

  push(body.description_category_id || body.descriptionCategoryId, body.type_id || body.typeId, "request");
  push(raw.description_category_id || raw.descriptionCategoryId, raw.type_id || raw.typeId, "raw_direct");

  const rawIds = Array.isArray(raw.category_ids) ? raw.category_ids : [];
  if (raw.category2Id && raw.category3Id) push(raw.category2Id, raw.category3Id, "category2_3");
  if (rawIds.length >= 3) push(rawIds[rawIds.length - 2], rawIds[rawIds.length - 1], "category_ids_tail");
  if (rawIds.length >= 2) push(rawIds[0], rawIds[rawIds.length - 1], "category_ids_root_leaf");

  const productTypeId = collectedProductTypeDictionaryValueId(raw);
  if (productTypeId) pushTypeOnly(productTypeId, "attribute_8229_dictionary_value");

  const categoryText = String(detail.category_name || raw.category || raw.category_name || raw.categoryName || "").trim();
  const leafName = String(raw.category3 || raw.categoryName || "").trim();
  return { candidates, typeOnlyCandidates, categoryText, leafName };
}

function collectedProductTypeDictionaryValueId(raw = {}) {
  const attrs = normalizeArray(raw.attributes || raw.attribute_values || raw.characteristics || []);
  const productType = attrs.find((item) => Number(item?.attribute_id || item?.id || 0) === 8229);
  const firstValue = normalizeArray(productType?.values || productType?.value || productType?.attribute_values)[0] || {};
  return Number(firstValue.dictionary_value_id || firstValue.id || firstValue.value_id || 0);
}

async function resolveCollectorBoxListingCategory(detail = {}, body = {}) {
  const raw = detail.rawPayload || {};
  const { candidates, typeOnlyCandidates, categoryText, leafName } = collectedCategoryCandidates(raw, detail, body);
  for (const candidate of candidates) {
    const cached = await row(`
      SELECT *
      FROM ozon_category_mappings
      WHERE description_category_id = ? AND type_id = ? AND status = 'active'
      LIMIT 1
    `, [candidate.descriptionCategoryId, candidate.typeId]);
    if (!cached && candidate.source !== "attribute_8229_dictionary_value") continue;
    return cached ? normalizeOzonCategoryRow(cached) : {
      description_category_id: String(candidate.descriptionCategoryId),
      descriptionCategoryId: String(candidate.descriptionCategoryId),
      type_id: String(candidate.typeId),
      typeId: String(candidate.typeId),
      ozon_category_id: `${candidate.descriptionCategoryId}:${candidate.typeId}`,
      category_name: categoryText || leafName || ""
    };
  }

  for (const candidate of typeOnlyCandidates) {
    const cached = await row(`
      SELECT *
      FROM ozon_category_mappings
      WHERE type_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `, [candidate.typeId]);
    if (cached) return { ...normalizeOzonCategoryRow(cached), source: candidate.source };
  }

  if (categoryText || leafName) {
    const like = `%${leafName || categoryText.split("/").pop().trim()}%`;
    const cached = await row(`
      SELECT *
      FROM ozon_category_mappings
      WHERE status = 'active'
        AND (
          name_zh = ? OR path_zh = ? OR name_ru = ? OR path_ru = ?
          OR name_zh LIKE ? OR path_zh LIKE ?
        )
      ORDER BY
        CASE
          WHEN name_zh = ? THEN 1
          WHEN path_zh = ? THEN 2
          WHEN path_zh LIKE ? THEN 3
          ELSE 9
        END,
        updated_at DESC
      LIMIT 1
    `, [leafName, categoryText, leafName, categoryText, like, like, leafName, categoryText, like]);
    if (cached) return normalizeOzonCategoryRow(cached);
  }

  const sku = String(detail.sku || raw.sku || "").trim();
  if (!sku) return null;
  const resolved = await resolveOzonCategoryFromSku({
    sku,
    shop_id: body.shop_id || body.shopId
  }, null).catch(() => null);
  return resolved?.category || null;
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

export async function syncCollectedProductsFromPlugin(products = [], tenantId = "admin") {
  await ensureListingAutomationSchema();
  const items = Array.isArray(products) ? products : [];
  const normalizedTenantId = String(tenantId || "admin").trim() || "admin";
  const results = [];

  for (const product of items) {
    const item = normalizePluginCollectedProduct(product, normalizedTenantId);
    if (!item.sku) {
      results.push({ success: false, error: "SKU_REQUIRED", product });
      continue;
    }
    await mysqlExecute(`
      INSERT INTO ozon_plugin_collected_products
      (
        tenant_id, sku, product_id, title, product_url, image_url, category_name,
        price, currency, sold_count, view_count, click_rate, conversion_rate,
        stock_count, commission_rate, collect_date, collected_at, payload_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        product_id = VALUES(product_id),
        title = VALUES(title),
        product_url = VALUES(product_url),
        image_url = VALUES(image_url),
        category_name = VALUES(category_name),
        price = VALUES(price),
        currency = VALUES(currency),
        sold_count = VALUES(sold_count),
        view_count = VALUES(view_count),
        click_rate = VALUES(click_rate),
        conversion_rate = VALUES(conversion_rate),
        stock_count = VALUES(stock_count),
        commission_rate = VALUES(commission_rate),
        collect_date = VALUES(collect_date),
        collected_at = VALUES(collected_at),
        payload_json = VALUES(payload_json),
        status = 'collected',
        updated_at = CURRENT_TIMESTAMP
    `, [
      item.tenant_id,
      item.sku,
      item.product_id,
      item.title,
      item.product_url,
      item.image_url,
      item.category_name,
      item.price,
      item.currency,
      item.sold_count,
      item.view_count,
      item.click_rate,
      item.conversion_rate,
      item.stock_count,
      item.commission_rate,
      item.collect_date,
      item.collected_at,
      JSON.stringify(product || {})
    ]);
    results.push({
      success: true,
      sku: item.sku,
      collectDate: item.collect_date,
      product: buildPluginCollectedProductPayload(item)
    });
  }

  return {
    importedCount: results.filter((item) => item.success).length,
    failedCount: results.filter((item) => !item.success).length,
    results
  };
}

export async function lookupCollectedProductFromPlugin(sku, tenantId = "admin") {
  await ensureListingAutomationSchema();
  const normalizedSku = String(sku || "").trim();
  if (!normalizedSku) return { found: false, needsRefresh: true, error: "SKU_REQUIRED" };
  const detail = await row(`
    SELECT *
    FROM ozon_plugin_collected_products
    WHERE tenant_id = ? AND sku = ? AND status <> 'deleted'
    ORDER BY collected_at DESC, updated_at DESC
    LIMIT 1
  `, [String(tenantId || "admin"), normalizedSku]);
  if (!detail) return { found: false, needsRefresh: true, collectDate: "", product: null };
  const collectDate = collectedDateKey(detail.collect_date);
  return {
    found: true,
    needsRefresh: collectDate !== shanghaiDateKey(),
    collectDate,
    collectedAt: detail.collected_at,
    status: detail.status || "collected",
    selectionProductId: detail.selection_product_id || null,
    listingTemplateId: detail.listing_template_id || null,
    product: buildPluginCollectedProductPayload(detail)
  };
}

export async function collectorBoxProducts(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(Math.max(1, Number(query.pageSize || 20)), 100);
  const offset = (page - 1) * pageSize;
  const summaryMode = String(query.summaryMode || query.summary_mode || "full").toLowerCase();
  const includeSummary = !["skip", "none", "false", "0"].includes(summaryMode);
  const search = String(query.query || query.search || "").trim().toLowerCase();
  const sku = String(query.sku || query.offer || query.offerId || "").trim().toLowerCase();
  const startDate = String(query.startDate || query.start_date || "").trim();
  const endDate = String(query.endDate || query.end_date || "").trim();
  const status = String(query.status || "all").trim();
  const tenantId = String(query.tenantId || query.tenant_id || "admin").trim() || "admin";
  const where = ["tenant_id = ?", "status <> 'deleted'"];
  const params = [tenantId];
  if (search) {
    where.push("(LOWER(sku) LIKE ? OR LOWER(product_id) LIKE ? OR LOWER(title) LIKE ? OR LOWER(category_name) LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (sku) {
    where.push("(LOWER(sku) LIKE ? OR LOWER(product_id) LIKE ?)");
    params.push(`%${sku}%`, `%${sku}%`);
  }
  if (startDate) {
    where.push("collect_date >= ?");
    params.push(startDate);
  }
  if (endDate) {
    where.push("collect_date <= ?");
    params.push(endDate);
  }
  if (status === "today") {
    where.push("collect_date = ?");
    params.push(shanghaiDateKey());
  } else if (status && status !== "all") {
    where.push("status = ?");
    params.push(status);
  }
  const whereSql = where.join(" AND ");
  const rowsSql = `
    SELECT
      sku AS id, tenant_id, 'Ozon' AS platform, sku, product_id, title, product_url, image_url, category_name,
      price, currency, sold_count, view_count, click_rate, conversion_rate, stock_count,
      commission_rate, collect_date, collected_at, status, selection_product_id,
      listing_template_id, edit_payload_json, edited_at, updated_at AS created_at, updated_at
    FROM ozon_plugin_collected_products
    WHERE ${whereSql}
    ORDER BY updated_at DESC, collected_at DESC
    LIMIT ? OFFSET ?
  `;
  const countSql = `
    SELECT COUNT(*) AS total
    FROM ozon_plugin_collected_products
    WHERE ${whereSql}
  `;
  const summarySql = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN collect_date = ? THEN 1 ELSE 0 END) AS today_count,
        SUM(CASE WHEN COALESCE(title, '') <> '' THEN 1 ELSE 0 END) AS titled_count
      FROM ozon_plugin_collected_products
      WHERE tenant_id = ? AND status <> 'deleted'
  `;
  const [rows, totalRow, summaryRows] = await Promise.all([
    all(rowsSql, [...params, pageSize, offset]),
    row(countSql, params),
    includeSummary ? all(summarySql, [shanghaiDateKey(), tenantId]) : Promise.resolve([])
  ]);
  return {
    rows: rows.map((item) => buildCollectorBoxRow(item)),
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    ...(includeSummary ? { summary: normalizeCollectorBoxSummary(summaryRows[0] || {}) } : {})
  };
}

export async function collectorBoxProductDetail(sku, session = null, tenantId = "admin") {
  await ensureListingAutomationSchema();
  const normalizedTenantId = String(tenantId || "admin").trim() || "admin";
  const detail = await row(`
    SELECT *
    FROM ozon_plugin_collected_products
    WHERE tenant_id = ? AND sku = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, [normalizedTenantId, String(sku || "").trim()]);
  if (!detail) return null;
  const normalized = {
    ...buildCollectorBoxRow(detail),
    payload: buildPluginCollectedProductPayload(detail),
    rawPayload: parseCollectedPayloadJson(detail.payload_json),
    editPayload: parseCollectedPayloadJson(detail.edit_payload_json)
  };
  if (normalized.listing_template_id) {
    const template = await listingCategoryTemplate(normalized.listing_template_id, session).catch(() => null);
    if (template) {
      normalized.templateSnapshot = compactTemplateForEditor(template);
      normalized.listingTemplate = normalized.templateSnapshot;
      const imageUrl = collectorBoxDisplayImageUrl({ ...normalized, image_url: detail.image_url }, normalized.editPayload, normalized.rawPayload);
      if (imageUrl) normalized.image_url = imageUrl;
    }
  }
  return normalized;
}

export async function deleteCollectorBoxProducts(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const tenantId = String(body.tenantId || body.tenant_id || "admin").trim() || "admin";
  const skus = normalizeArray(body.skus || body.sku)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const uniqueSkus = [...new Set(skus)];
  if (!uniqueSkus.length) throw new Error("璇烽€夋嫨瑕佸垹闄ょ殑閲囬泦鍟嗗搧");
  const placeholders = uniqueSkus.map(() => "?").join(", ");
  await mysqlExecute(`
    UPDATE ozon_plugin_collected_products
    SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = ? AND sku IN (${placeholders})
  `, [tenantId, ...uniqueSkus]);
  return {
    ok: true,
    deletedCount: uniqueSkus.length,
    skus: uniqueSkus
  };
}

export async function saveCollectorBoxEdit(sku, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const detail = await collectorBoxProductDetail(sku, session);
  if (!detail) throw new Error("閲囬泦绠卞晢鍝佷笉瀛樺湪");
  const editPayload = normalizeCollectorBoxEditPayload(body.editPayload || body.edit_payload || body || {}, detail);
  await mysqlExecute(`
    UPDATE ozon_plugin_collected_products
    SET edit_payload_json = ?, status = CASE WHEN status = 'selection_created' THEN status ELSE 'edited' END,
        edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = ? AND sku = ?
  `, [JSON.stringify(editPayload), detail.tenant_id || "admin", detail.sku]);
  return collectorBoxProductDetail(detail.sku, session);
}

export async function createListingTemplateFromCollectorBox(sku, body = {}, session = null) {
  const detail = await collectorBoxProductDetail(sku, session, body?.tenant_id || body?.tenantId || "admin");
  if (!detail) throw new Error("閲囬泦绠卞晢鍝佷笉瀛樺湪");
  const forceRebuild = Boolean(body?.force || body?.force_rebuild || body?.forceRebuild || body?.refresh || body?.rebuild);
  if (detail.listing_template_id && !forceRebuild) {
    const existingTemplate = await listingCategoryTemplate(detail.listing_template_id, session);
    if (existingTemplate) {
      return {
        ok: true,
        reused: true,
        template: body?.compact ? compactListingTemplateReference(existingTemplate) : existingTemplate,
        collectorProduct: body?.compact ? undefined : detail
      };
    }
  }

  const normalized = await normalizeCollectedListingDraft({ detail, body }, {
    sourceType: "collector_box",
    normalizeEditPayload: normalizeCollectorBoxEditPayload,
    resolveCategory: (currentDetail, currentBody) => resolveCollectorBoxListingCategory(currentDetail, currentBody).catch(() => null),
    buildAttributes: buildCollectorBoxEditAttributes,
    mergeAttributeDefinitions: mergeCachedCategoryAttributeDefinitions,
    collectVariantRows: collectCollectedVariantRows,
    normalizeVariant: normalizeCollectedVariant,
    variantImages: collectedVariantImages,
    normalizeImages,
    normalizeDimensions: (editPayload) => ({
      length_cm: Number(editPayload.length_cm || 0),
      width_cm: Number(editPayload.width_cm || 0),
      height_cm: Number(editPayload.height_cm || 0),
      weight_g: Number(editPayload.weight_g || 0)
    })
  });
  await repairCollectedVariantColorAxis(normalized);
  const editPayload = normalized.templatePayload?.editable_payload || normalized.editPayload;
  const result = await createListingTemplateFromCollectedProduct(normalized.templatePayload, session);
  const templateId = result.template?.id || null;
  await mysqlExecute(`
    UPDATE ozon_plugin_collected_products
    SET edit_payload_json = ?, listing_template_id = ?, status = CASE WHEN status = 'selection_created' THEN status ELSE 'listing_template_created' END,
        edited_at = COALESCE(edited_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = ? AND sku = ?
  `, [JSON.stringify(editPayload), templateId, detail.tenant_id || "admin", detail.sku]);
  if (body?.compact) {
    return {
      ok: true,
      reused: Boolean(result.reused),
      template: compactListingTemplateReference(result.template),
      normalization: normalized.diagnostics
    };
  }
  return {
    ...result,
    normalization: normalized.diagnostics,
    collectorProduct: await collectorBoxProductDetail(detail.sku, session, detail.tenant_id || body?.tenant_id || body?.tenantId || "admin")
  };
}

export async function collectorBoxMappingDiagnostics(sku, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const detail = await collectorBoxProductDetail(sku, session, body?.tenant_id || body?.tenantId || "admin");
  if (!detail) throw new Error("閲囬泦绠卞晢鍝佷笉瀛樺湪");
  const autoSyncAttributes = body?.auto_sync !== false && body?.autoSync !== false;
  const normalized = await normalizeCollectedListingDraft({ detail, body }, {
    sourceType: "collector_box",
    normalizeEditPayload: normalizeCollectorBoxEditPayload,
    resolveCategory: (currentDetail, currentBody) => resolveCollectorBoxListingCategory(currentDetail, currentBody).catch(() => null),
    buildAttributes: buildCollectorBoxEditAttributes,
    mergeAttributeDefinitions: (items, descriptionCategoryId, typeId) => mergeCachedCategoryAttributeDefinitions(items, descriptionCategoryId, typeId, { autoSync: autoSyncAttributes }),
    collectVariantRows: collectCollectedVariantRows,
    normalizeVariant: normalizeCollectedVariant,
    variantImages: collectedVariantImages,
    normalizeImages,
    normalizeDimensions: (editPayload) => ({
      length_cm: Number(editPayload.length_cm || 0),
      width_cm: Number(editPayload.width_cm || 0),
      height_cm: Number(editPayload.height_cm || 0),
      weight_g: Number(editPayload.weight_g || 0)
    })
  });
  await repairCollectedVariantColorAxis(normalized);
  return buildMappingDiagnostics({
    sourceType: "collector_box",
    sourceId: String(detail.sku || sku || ""),
    title: normalized.payload?.title || detail.title || "",
    category: normalized.draft?.category || {},
    attributes: normalized.draft?.attributes || normalized.payload?.attributes || [],
    variants: normalized.draft?.variants || normalized.payload?.variants || [],
    images: normalized.payload?.images || [],
    normalizationDiagnostics: normalized.diagnostics || {},
    autoSync: autoSyncAttributes
  });
}

export async function listingTemplateMappingDiagnostics(id, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const template = await listingCategoryTemplate(Number(id), session);
  if (!template) throw new Error("Listing category template not found");
  const editable = normalizeEditablePayload(template.editable_payload || {});
  return buildMappingDiagnostics({
    sourceType: template.source_type || "listing_template",
    sourceId: String(template.source_ozon_sku || template.id || ""),
    title: template.title || editable.title || template.template_name || "",
    category: {
      ozon_category_id: template.ozon_category_id || editable.category_id || "",
      category_name: template.category_name || editable.category_name || "",
      description_category_id: editable.description_category_id || template.description_category_id || "",
      type_id: editable.type_id || template.type_id || ""
    },
    attributes: template.attributes || editable.attributes || [],
    variants: editable.variants || template.variants || [],
    images: template.images || editable.images || [],
    normalizationDiagnostics: editable.normalization_diagnostics || template.source_raw?.normalization_diagnostics || {},
    shopId: body.shop_id || body.shopId,
    autoSync: body?.auto_sync !== false && body?.autoSync !== false
  });
}

export async function listingTemplateHealthCheck(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const includeTemplates = String(query.templates ?? "1") !== "0" && String(query.templates ?? "true").toLowerCase() !== "false";
  const includeRecords = String(query.records ?? "1") !== "0" && String(query.records ?? "true").toLowerCase() !== "false";
  const includeOnlineProducts = String(query.online_products || query.onlineProducts || "").toLowerCase() === "1"
    || String(query.online_products || query.onlineProducts || "").toLowerCase() === "true";
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  const autoSync = query?.auto_sync === true || query?.autoSync === true || String(query.auto_sync || query.autoSync || "").toLowerCase() === "true";
  const rows = [];

  if (includeTemplates) {
    const templates = await all(`
      SELECT id
      FROM listing_category_templates
      WHERE status <> 'deleted'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `, [limit]);
    for (const item of templates) {
      rows.push(await healthCheckSafeDiagnostic({
        sourceType: "listing_template",
        sourceId: Number(item.id),
        label: `妯℃澘 ${item.id}`,
        run: () => listingTemplateMappingDiagnostics(Number(item.id), { auto_sync: autoSync }, session)
      }));
    }
  }

  if (includeRecords) {
    const records = await all(`
      SELECT id
      FROM listing_publish_records
      WHERE status <> 'deleted'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `, [limit]);
    for (const item of records) {
      rows.push(await healthCheckSafeDiagnostic({
        sourceType: "listing_publish_record",
        sourceId: Number(item.id),
        label: `涓婃灦璁板綍 ${item.id}`,
        run: async () => {
          const detail = await listingPublishRecordDetail(Number(item.id), session);
          return detail.template_snapshot?.mapping_diagnostics || buildMappingDiagnostics({
            sourceType: "listing_publish_record",
            sourceId: String(item.id),
            title: detail.product_name || detail.offer_id || "",
            category: {
              description_category_id: detail.template_snapshot?.editable_payload?.description_category_id || detail.description_category_id,
              type_id: detail.template_snapshot?.editable_payload?.type_id || detail.type_id,
              category_name: detail.category_name || ""
            },
            attributes: detail.template_snapshot?.attributes || [],
            variants: detail.template_snapshot?.editable_payload?.variants || [],
            images: detail.template_snapshot?.images || detail.images || [],
            autoSync: false
          });
        }
      }));
    }
  }

  if (includeOnlineProducts) {
    const onlineProducts = await all(`
      SELECT id, offer_id
      FROM online_products
      WHERE status <> 'deleted'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `, [Math.min(limit, 10)]);
    for (const item of onlineProducts) {
      rows.push(await healthCheckSafeDiagnostic({
        sourceType: "online_product",
        sourceId: Number(item.id),
        label: `鍦ㄧ嚎鍟嗗搧 ${item.offer_id || item.id}`,
        run: async () => {
          const draft = await onlineProductListingEditDraft(Number(item.id), { diagnostics: true, auto_sync: autoSync }, session);
          return draft.mapping_diagnostics || draft.template?.mapping_diagnostics || null;
        }
      }));
    }
  }

  const summary = summarizeHealthCheckRows(rows);
  return {
    ok: summary.blockers === 0,
    summary,
    rows: rows.sort((left, right) => healthSeverityScore(right) - healthSeverityScore(left))
  };
}

async function healthCheckSafeDiagnostic({ sourceType = "", sourceId = "", label = "", run }) {
  try {
    const diagnostics = await run();
    const summary = diagnostics?.summary || {};
    return {
      ok: diagnostics?.ok !== false && Number(summary.blockers || 0) === 0,
      source_type: sourceType,
      source_id: sourceId,
      label,
      score: Number(diagnostics?.score || 0),
      blockers: Number(summary.blockers || 0),
      warnings: Number(summary.warnings || 0),
      issues: Number(summary.issues || 0),
      category_ok: Boolean(diagnostics?.category?.ok),
      category: diagnostics?.category || {},
      summary,
      top_issues: normalizeArray(diagnostics?.issues).slice(0, 5)
    };
  } catch (error) {
    return {
      ok: false,
      source_type: sourceType,
      source_id: sourceId,
      label,
      score: 0,
      blockers: 1,
      warnings: 0,
      issues: 1,
      category_ok: false,
      category: {},
      summary: { issues: 1, blockers: 1, warnings: 0 },
      top_issues: [{
        level: "blocker",
        code: "diagnostic_failed",
        title: "浣撴澶辫触",
        message: error?.message || String(error || "浣撴澶辫触")
      }]
    };
  }
}

function summarizeHealthCheckRows(rows = []) {
  return {
    total: rows.length,
    ok: rows.filter((item) => item.ok).length,
    blockers: rows.reduce((sum, item) => sum + Number(item.blockers || 0), 0),
    warnings: rows.reduce((sum, item) => sum + Number(item.warnings || 0), 0),
    issues: rows.reduce((sum, item) => sum + Number(item.issues || 0), 0),
    categories_missing: rows.filter((item) => !item.category_ok).length,
    by_source_type: rows.reduce((acc, item) => {
      const key = item.source_type || "unknown";
      acc[key] = acc[key] || { total: 0, blockers: 0, warnings: 0 };
      acc[key].total += 1;
      acc[key].blockers += Number(item.blockers || 0);
      acc[key].warnings += Number(item.warnings || 0);
      return acc;
    }, {})
  };
}

function healthSeverityScore(item = {}) {
  return Number(item.blockers || 0) * 1000 + Number(item.warnings || 0) * 100 + Number(item.issues || 0);
}

export async function repairListingTemplateMapping(id, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const template = await listingCategoryTemplate(Number(id), session);
  if (!template) throw new Error("Listing category template not found");
  const editable = normalizeEditablePayload(template.editable_payload || {});
  const sourceAttributes = firstNonEmptyAttributeArray(
    template.source_raw?.collected_product?.attributes,
    template.source_raw?.attributes,
    editable.source_raw?.attributes,
    template.attributes,
    editable.attributes
  );
  const originalAttributes = normalizeAttributes(sourceAttributes || []);
  const repairedCategory = await resolveTemplateRepairCategory(template, editable, originalAttributes);
  const descriptionCategoryId = Number(repairedCategory?.description_category_id || repairedCategory?.descriptionCategoryId || editable.description_category_id || template.description_category_id || 0);
  const typeId = Number(repairedCategory?.type_id || repairedCategory?.typeId || editable.type_id || template.type_id || 0);
  if (!descriptionCategoryId || !typeId) throw new Error("Missing description_category_id/type_id; cannot repair template mapping");
  const autoSync = body?.auto_sync !== false && body?.autoSync !== false;
  const definitions = await listingOzonCategoryAttributes({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    value_limit: Number(body.value_limit || body.valueLimit || 120),
    sync_values: autoSync,
    auto_sync: autoSync
  });
  const model = prepareOzonAttributeEditModel(originalAttributes, definitions, { includeUnmapped: false });
  const normalizedAttributes = await hydrateAttributeNamesFromAnyCategory(inferCollectedAttributeValues(model.attributes));
  const unmappedAttributes = normalizeArray(model.unmapped).filter((item) => item.name || item.value || item.attribute_id);
  const categoryName = repairedCategory?.path_zh || repairedCategory?.category_name || repairedCategory?.name_zh || template.category_name || editable.category_name || "";
  const categoryKey = buildOzonCategoryKey({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    fallback: template.ozon_category_id
  });
  const nextEditablePayload = {
    ...editable,
    category_id: categoryKey,
    ozon_category_id: categoryKey,
    category_name: categoryName,
    description_category_id: String(descriptionCategoryId),
    type_id: String(typeId),
    attributes: normalizedAttributes,
    mapping_repair: {
      repaired_at: new Date().toISOString(),
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      category_resolved_from: repairedCategory?.source || "",
      original_attribute_count: originalAttributes.length,
      normalized_attribute_count: normalizedAttributes.length,
      unmapped_attribute_count: unmappedAttributes.length
    }
  };
  const nextSourceRaw = {
    ...(template.source_raw || {}),
    mapping_repair: {
      repaired_at: nextEditablePayload.mapping_repair.repaired_at,
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      category_resolved_from: repairedCategory?.source || "",
      original_attribute_count: originalAttributes.length,
      normalized_attribute_count: normalizedAttributes.length,
      unmapped_attribute_count: unmappedAttributes.length,
      unmapped_attributes: unmappedAttributes
    }
  };
  const diagnostics = await buildMappingDiagnostics({
    sourceType: template.source_type || "listing_template",
    sourceId: String(template.source_ozon_sku || template.id || ""),
    title: template.title || editable.title || template.template_name || "",
    category: {
      ozon_category_id: categoryKey,
      category_name: categoryName,
      description_category_id: descriptionCategoryId,
      type_id: typeId
    },
    attributes: normalizedAttributes,
    variants: editable.variants || template.variants || [],
    images: template.images || editable.images || [],
    normalizationDiagnostics: nextEditablePayload.mapping_repair,
    autoSync: false
  });
  const preview = {
    ok: true,
    applied: false,
    template_id: Number(id),
    summary: {
      original_attribute_count: originalAttributes.length,
      normalized_attribute_count: normalizedAttributes.length,
      unmapped_attribute_count: unmappedAttributes.length,
      schema_attribute_count: definitions.length
    },
    diagnostics,
    unmapped_attributes: unmappedAttributes.slice(0, 120)
  };
  if (!body.apply) return preview;
  await mysqlExecute(`
    UPDATE listing_category_templates
    SET ozon_category_id = ?,
        category_name = ?,
        attributes_json = ?,
        editable_payload_json = ?,
        source_raw_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    categoryKey,
    categoryName,
    JSON.stringify(normalizedAttributes),
    JSON.stringify(nextEditablePayload),
    JSON.stringify(nextSourceRaw),
    Number(id)
  ]);
  return {
    ...preview,
    applied: true,
    template: await listingCategoryTemplate(Number(id), session)
  };
}

function firstNonEmptyAttributeArray(...items) {
  return items.find((item) => Array.isArray(item) && item.length) || [];
}

async function resolveTemplateRepairCategory(template = {}, editable = {}, attributes = []) {
  const currentDescriptionId = Number(editable.description_category_id || template.description_category_id || 0);
  const currentTypeId = Number(editable.type_id || template.type_id || 0);
  if (currentDescriptionId && currentTypeId) {
    const cached = await row(`
      SELECT *
      FROM ozon_category_mappings
      WHERE description_category_id = ? AND type_id = ? AND status = 'active'
      LIMIT 1
    `, [currentDescriptionId, currentTypeId]).catch(() => null);
    if (cached) return { ...normalizeOzonCategoryRow(cached), source: "current_template" };
  }

  const productTypeAttribute = normalizeArray(attributes).find((item) => Number(item.attribute_id || item.id || 0) === 8229);
  const selected = extractSelectedDictionaryValues(productTypeAttribute)
    || normalizeArray(productTypeAttribute?.values).filter((item) => Number(item?.dictionary_value_id || item?.id || item?.value_id || 0));
  for (const value of selected || []) {
    const typeId = Number(value.dictionary_value_id || value.id || value.value_id || 0);
    if (!typeId) continue;
    const cached = await row(`
      SELECT *
      FROM ozon_category_mappings
      WHERE type_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `, [typeId]).catch(() => null);
    if (cached) return { ...normalizeOzonCategoryRow(cached), source: "attribute_8229_dictionary_value" };
  }

  const categoryText = String(template.category_name || editable.category_name || template.source_raw?.collected_product?.category || template.source_raw?.collected_product?.category_name || "").trim();
  const leafName = categoryText.split("/").map((item) => item.trim()).filter(Boolean).at(-1) || "";
  if (leafName || categoryText) {
    const like = `%${leafName || categoryText}%`;
    const cached = await row(`
      SELECT *
      FROM ozon_category_mappings
      WHERE status = 'active'
        AND (name_zh = ? OR path_zh = ? OR name_ru = ? OR path_ru = ? OR name_zh LIKE ? OR path_zh LIKE ?)
      ORDER BY
        CASE
          WHEN name_zh = ? THEN 1
          WHEN path_zh = ? THEN 2
          WHEN path_zh LIKE ? THEN 3
          ELSE 9
        END,
        updated_at DESC
      LIMIT 1
    `, [leafName, categoryText, leafName, categoryText, like, like, leafName, categoryText, like]).catch(() => null);
    if (cached) return { ...normalizeOzonCategoryRow(cached), source: "category_name" };
  }

  return null;
}

function listingTemplateStandardizerOptions(options = {}) {
  const shouldBuildDiagnostics = options.diagnostics !== false;
  return {
    sourceType: options.sourceType || "",
    sourceId: options.sourceId || "",
    shopId: options.shopId || "",
    autoSync: options.autoSync !== false,
    syncValues: options.syncValues !== false,
    resolveCategory: (payload, attributes) => resolveTemplateRepairCategory(
      {
        ozon_category_id: payload.ozon_category_id || "",
        category_name: payload.category_name || "",
        description_category_id: payload.description_category_id || payload.editable_payload?.description_category_id || "",
        type_id: payload.type_id || payload.editable_payload?.type_id || "",
        source_raw: payload.source_raw || {}
      },
      payload.editable_payload || {},
      attributes
    ),
    mergeCategoryAttributeDefinitions: (attributes, descriptionCategoryId, typeId, mergeOptions) => mergeCachedCategoryAttributeDefinitions(attributes, descriptionCategoryId, typeId, mergeOptions),
    buildDiagnostics: shouldBuildDiagnostics ? (diagnosticInput) => buildMappingDiagnostics(diagnosticInput) : null
  };
}

export async function standardizeListingTemplateForAutomation(payload = {}, options = {}) {
  await ensureListingAutomationSchema();
  const template = await standardizeListingTemplatePayload(payload, listingTemplateStandardizerOptions(options));
  return autoFillCategoryTypeAttribute(template);
}

function autoFillCategoryTypeAttribute(template = {}) {
  if (!template || typeof template !== "object") return template;
  const editable = objectValue(template.editable_payload || {});
  const categoryKey = parseSelectedDictionaryCategoryKey(template.ozon_category_id || editable.ozon_category_id || editable.category_id || "");
  const typeId = Number(editable.type_id || template.type_id || categoryKey.type_id || 0);
  if (!typeId) return template;
  const attributes = normalizeAttributes(template.attributes || editable.attributes || []);
  let changed = false;
  const nextAttributes = attributes.map((attribute) => {
    if (!isCategoryTypeAttribute(attribute) || normalizeAttributeValue(attribute.value)) return attribute;
    const matched = normalizeArray(attribute.values).find((option) => Number(option?.dictionary_value_id || option?.id || option?.value_id || 0) === typeId);
    if (!matched) return attribute;
    const selected = {
      id: Number(matched.dictionary_value_id || matched.id || typeId),
      dictionary_value_id: Number(matched.dictionary_value_id || matched.id || typeId),
      value: String(matched.value || "").trim(),
      label: String(matched.display_value_zh || matched.label || matched.value || "").trim(),
      display_value_zh: String(matched.display_value_zh || "").trim()
    };
    changed = true;
    return {
      ...attribute,
      value: selected.value,
      selected_values: mergeSelectedDictionaryOptions([selected], attribute.selected_values || []),
      values: mergeSelectedDictionaryOptions([selected], attribute.values || [])
    };
  });
  if (!changed) return template;
  return {
    ...template,
    attributes: nextAttributes,
    editable_payload: {
      ...editable,
      attributes: nextAttributes
    }
  };
}

function isCategoryTypeAttribute(attribute = {}) {
  const id = Number(attribute.attribute_id || attribute.id || 0);
  if ([8229, 23379, 23188].includes(id)) return true;
  const name = String(attribute.name || attribute.name_zh || attribute.attribute_name || "").trim().toLowerCase();
  return Boolean(name) && /(绫诲瀷|鍟嗗搧绫诲瀷|褌懈锌 褌芯胁邪褉邪|褌芯胁邪褉薪.*褌懈锌|product type|category type)/i.test(name);
}

export async function createListingTemplateFromOnlineProduct(onlineProductId, body = {}, session = null) {
  const targetId = Number(onlineProductId || body?.online_product_id || body?.onlineProductId || body?.id || 0);
  if (!targetId) throw new Error("缂哄皯鍦ㄧ嚎鍟嗗搧 ID");
  const draft = await onlineProductListingEditDraft(targetId, {}, session);
  const template = draft?.template || {};
  const editable = template.editable_payload || {};
  const sourceRaw = editable.source_raw || template.source_raw || {};
  const offerId = String(draft?.offer_id || editable.sku || sourceRaw.offer_id || "").trim();
  const aiBundle = objectValue(body?.ai_bundle || body?.aiBundle || {});
  const aiMainImageUrl = String(aiBundle.mainImageUrl || "").trim();
  const aiDetailImageUrls = normalizeImages(aiBundle.detailImageUrls || []).map((item) => String(item?.url || item || "").trim()).filter(Boolean);
  const aiGeneratedTitle = String(aiBundle.generatedTitles?.[0] || "").trim();
  const aiGeneratedDescription = String(aiBundle.generatedDescription || "").trim();
  const aiGeneratedTags = normalizeStringList(aiBundle.generatedTags || []);
  const baseImages = normalizeImages(template.images || editable.images || []);
  const mergedImageUrls = [...new Set([
    aiMainImageUrl,
    ...aiDetailImageUrls,
    ...baseImages.map((item) => String(item?.url || item || "").trim())
  ].filter(Boolean))];
  const mergedImages = mergedImageUrls.map((url, index) => ({
    name: index === 0 ? "涓诲浘" : `璇︽儏鍥?${index}`,
    url
  }));
  const mergedAttributes = normalizeAttributes(template.attributes || editable.attributes || []).map((item) => ({ ...item }));
  const upsertAttribute = (name, value, defaults = {}) => {
    if (!String(value || "").trim()) return;
    const matched = mergedAttributes.find((item) => String(item.name || "").trim() === name || String(item.attribute_id || "") === String(defaults.attribute_id || ""));
    if (matched) {
      matched.value = value;
      if (defaults.attribute_id && !matched.attribute_id) matched.attribute_id = defaults.attribute_id;
      return;
    }
    mergedAttributes.push({
      name,
      value,
      required: false,
      attribute_id: defaults.attribute_id || "",
      source: "ai_workbench_online_product"
    });
  };
  upsertAttribute("浜у搧鏍囩", aiGeneratedTags.join(","), { attribute_id: 23171 });
  upsertAttribute("Description", aiGeneratedDescription, { attribute_id: 4191 });
  const payload = {
    ozon_category_id: String(template.ozon_category_id || editable.category_id || editable.legacy_category_id || "").trim(),
    category_name: String(template.category_name || editable.category_name || "").trim(),
    template_name: String(
      body.template_name
      || body.templateName
      || template.template_name
      || editable.title
      || `鍦ㄧ嚎鍟嗗搧缂栬緫 / ${offerId || targetId}`
    ).trim(),
    title: String(body.title || aiGeneratedTitle || template.title || editable.title || "").trim(),
    description: String(body.description || aiGeneratedDescription || template.description || editable.description || "").trim(),
    source_type: "online_product_live",
    source_ozon_sku: offerId,
    source_raw: {
      ...sourceRaw,
      source_type: "online_product_live",
      online_product_id: targetId,
      draft_source: draft?.draft_source || "online_product_live",
      ai_bundle: {
        mainImageUrl: aiMainImageUrl,
        detailImageUrls: aiDetailImageUrls,
        generatedTitle: aiGeneratedTitle,
        generatedTags: aiGeneratedTags,
        generatedDescription: aiGeneratedDescription
      }
    },
    editable_payload: {
      ...editable,
      title: String(body.title || aiGeneratedTitle || editable.title || template.title || "").trim(),
      description: String(body.description || aiGeneratedDescription || editable.description || template.description || "").trim(),
      images: mergedImages,
      attributes: mergedAttributes,
      source_raw: {
        ...sourceRaw,
        source_type: "online_product_live",
        online_product_id: targetId,
        draft_source: draft?.draft_source || "online_product_live",
        ai_bundle: {
          mainImageUrl: aiMainImageUrl,
          detailImageUrls: aiDetailImageUrls,
          generatedTitle: aiGeneratedTitle,
          generatedTags: aiGeneratedTags,
          generatedDescription: aiGeneratedDescription
        }
      }
    },
    attributes: mergedAttributes,
    images: mergedImages,
    required_attributes: Array.isArray(template.category_attributes) ? template.category_attributes : [],
    ai_rules: {}
  };
  const standardizedPayload = await standardizeListingTemplatePayload(payload, listingTemplateStandardizerOptions({
    sourceType: "online_product_live",
    sourceId: offerId,
    autoSync: body?.auto_sync !== false && body?.autoSync !== false
  }));
  if (!standardizedPayload.ozon_category_id) throw new Error("鍦ㄧ嚎鍟嗗搧缂栬緫绋跨己灏戠被鐩?ID锛岃鍏堝悓姝ュ湪绾垮晢鍝佸悗閲嶈瘯");
  const result = await createListingCategoryTemplate(standardizedPayload, session);
  return {
    ...result,
    ok: true,
    template: result,
    diagnostics: standardizedPayload.mapping_diagnostics || null,
    online_product_id: targetId,
    draft_source: draft?.draft_source || "online_product_live"
  };
}

export async function onlineProductListingEditDraft(onlineProductId, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const targetId = Number(onlineProductId || body?.online_product_id || body?.onlineProductId || body?.id || 0);
  if (!targetId) throw new Error("缂哄皯鍦ㄧ嚎鍟嗗搧 ID");
  const draft = await onlineProductEditDraftMysql(targetId);
  const latestSnapshot = await latestPublishRecordTemplateSnapshotForOnlineProduct({
    shopId: draft?.shop_id,
    offerId: draft?.offer_id || draft?.template?.editable_payload?.sku || draft?.template?.source_raw?.offer_id || "",
    onlineProductId: targetId,
    ozonProductId: draft?.ozon_product_id || draft?.template?.source_raw?.ozon_product_id || ""
  }).catch(() => null);
  const template = latestSnapshot?.template || draft?.template || {};
  const sourceRaw = {
    ...(template.source_raw || {}),
    source_type: "online_product_live",
    online_product_id: targetId,
    draft_source: latestSnapshot ? "listing_publish_record_snapshot" : (draft?.draft_source || "online_product_live"),
    ...(latestSnapshot?.recordId ? { source_publish_record_id: latestSnapshot.recordId } : {})
  };
  const standardizedTemplate = await standardizeListingTemplatePayload({
    ...template,
    source_type: "online_product_live",
    source_ozon_sku: draft?.offer_id || template.source_ozon_sku || template.editable_payload?.sku || sourceRaw.offer_id || "",
    source_raw: sourceRaw,
    editable_payload: {
      ...(template.editable_payload || {}),
      source_raw: {
        ...sourceRaw,
        ...(template.editable_payload?.source_raw || {})
      }
    }
  }, listingTemplateStandardizerOptions({
    sourceType: "online_product_live",
    sourceId: String(draft?.offer_id || template.editable_payload?.sku || sourceRaw.offer_id || targetId),
    shopId: draft?.shop_id || sourceRaw.shop_id || template.editable_payload?.source_raw?.shop_id || "",
    autoSync: body?.auto_sync !== false && body?.autoSync !== false,
    diagnostics: body?.diagnostics !== false
  }));
  return {
    ...draft,
    template: standardizedTemplate,
    mapping_diagnostics: standardizedTemplate.mapping_diagnostics || null
  };
}

async function latestPublishRecordTemplateSnapshotForOnlineProduct({ shopId = 0, offerId = "", onlineProductId = 0, ozonProductId = "" } = {}) {
  const normalizedShopId = Number(shopId || 0);
  const normalizedOfferId = String(offerId || "").trim();
  const normalizedOnlineProductId = Number(onlineProductId || 0);
  const normalizedOzonProductId = String(ozonProductId || "").trim();
  if (!normalizedShopId || (!normalizedOfferId && !normalizedOnlineProductId && !normalizedOzonProductId)) return null;
  const where = [
    "shop_id = ?",
    "status <> 'deleted'",
    "template_snapshot_json IS NOT NULL",
    "template_snapshot_json <> ''"
  ];
  const params = [normalizedShopId];
  const matches = [];
  if (normalizedOfferId) {
    matches.push("offer_id = ?");
    params.push(normalizedOfferId);
  }
  if (normalizedOnlineProductId) {
    matches.push("source_product_id = ?");
    params.push(normalizedOnlineProductId);
  }
  if (normalizedOzonProductId) {
    matches.push("ozon_product_id = ?");
    params.push(normalizedOzonProductId);
  }
  if (!matches.length) return null;
  where.push(`(${matches.join(" OR ")})`);
  const record = await row(`
    SELECT id, template_snapshot_json
    FROM listing_publish_records
    WHERE ${where.join(" AND ")}
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `, params);
  const snapshot = parseJson(record?.template_snapshot_json, null);
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    recordId: Number(record.id || 0),
    template: normalizeTemplatePayload(snapshot)
  };
}

function compactListingTemplateReference(template = null) {
  if (!template) return null;
  return {
    id: template.id,
    ozon_category_id: template.ozon_category_id || "",
    category_name: template.category_name || "",
    template_name: template.template_name || "",
    title: template.title || "",
    source_type: template.source_type || "",
    source_ozon_sku: template.source_ozon_sku || "",
    source_shop_id: template.source_shop_id || "",
    created_by_name: template.created_by_name || "",
    updated_at: template.updated_at || ""
  };
}

function compactTemplateForEditor(template = null) {
  if (!template) return null;
  const attributes = compactAttributesForEditor(template.attributes || template.editable_payload?.attributes || []);
  const variants = compactVariantsForEditor(template.editable_payload?.variants || template.variants || []);
  const editable = {
    ...(template.editable_payload || {}),
    attributes,
    variants
  };
  delete editable.source_raw;
  delete editable.raw_request;
  const compact = {
    ...template,
    attributes,
    variants,
    editable_payload: editable,
    source_raw: undefined,
    source_raw_omitted: true
  };
  delete compact.source_raw_json;
  delete compact.editable_payload_json;
  delete compact.attributes_json;
  delete compact.images_json;
  delete compact.category_attributes_json;
  delete compact.required_attributes_json;
  delete compact.ai_rules_json;
  delete compact.image_rules_json;
  return compact;
}

function compactVariantsForEditor(variants = []) {
  return normalizeArray(variants).map((variant, index) => {
    const {
      attributes,
      attribute_values,
      characteristics,
      raw,
      raw_request,
      source_raw,
      ...cleanVariant
    } = variant || {};
    return {
      ...cleanVariant,
      images: normalizeImages(cleanVariant.images || []).slice(0, 16),
      video_cover_urls: normalizeStringList(cleanVariant.video_cover_urls || cleanVariant.cover_video_urls || cleanVariant.video_cover).slice(0, 1),
      video_urls: normalizeStringList(cleanVariant.video_urls || cleanVariant.videos || cleanVariant.video_url).slice(0, 1),
      main_tags: normalizeStringList(cleanVariant.main_tags || cleanVariant.hashtags || cleanVariant.tags).slice(0, 20),
      dynamic_attributes: compactVariantDynamicAttributesForEditor(cleanVariant.dynamic_attributes || cleanVariant.dynamicAttributes),
      sort_order: Number(cleanVariant.sort_order || index + 1)
    };
  });
}

function compactVariantDynamicAttributesForEditor(value) {
  const entries = normalizeDynamicVariantAttributeEntries(value);
  const output = {};
  for (const entry of entries) {
    const id = String(entry.attribute_id || entry.id || "").trim();
    const key = id || String(entry.name || entry.attribute_name || "").trim();
    if (!key) continue;
    output[key] = {
      attribute_id: id,
      name: String(entry.name || entry.attribute_name || key).trim(),
      value: entry.value ?? editorAttributeOptionText(entry.values),
      values: normalizeArray(entry.values).slice(0, 120),
      selected_values: normalizeArray(entry.selected_values || entry.selectedValues).slice(0, 20),
      label: String(entry.label || entry.display_value_zh || "").trim(),
      display_value_zh: String(entry.display_value_zh || entry.label || "").trim(),
      dictionary_id: entry.dictionary_id || "",
      type: entry.type || "text",
      source: entry.source || "seller_variant"
    };
  }
  return output;
}

function compactAttributesForEditor(attributes = []) {
  return normalizeAttributes(attributes).map((field) => {
    const selectedValues = normalizeArray(field.selected_values || field.selectedValues);
    const values = compactAttributeValuesForEditor(field, selectedValues);
    const { raw, ...cleanField } = field;
    return {
      ...cleanField,
      values,
      selected_values: selectedValues.slice(0, 20)
    };
  });
}

function compactAttributeValuesForEditor(field = {}, selectedValues = []) {
  const selectedIds = new Set(selectedValues.map((item) => String(item?.dictionary_value_id || item?.id || item?.value_id || "").trim()).filter(Boolean));
  const selectedTexts = new Set([
    ...normalizeArray(field.value).map((item) => normalizeTranslationSource(editorAttributeOptionText(item))).filter(Boolean),
    ...selectedValues.flatMap(editorAttributeOptionValueCandidates).map(normalizeTranslationSource).filter(Boolean)
  ]);
  const picked = [];
  const pushOption = (option) => {
    if (!option) return;
    const key = String(option.dictionary_value_id || option.id || option.value_id || option.value || option.label || "").trim();
    if (!key || picked.some((item) => String(item.dictionary_value_id || item.id || item.value_id || item.value || item.label || "").trim() === key)) return;
    picked.push(option);
  };
  selectedValues.forEach(pushOption);
  normalizeArray(field.values).forEach((option) => {
    const optionId = String(option?.dictionary_value_id || option?.id || option?.value_id || "").trim();
    const optionTexts = editorAttributeOptionValueCandidates(option).map(normalizeTranslationSource).filter(Boolean);
    if ((optionId && selectedIds.has(optionId)) || optionTexts.some((text) => selectedTexts.has(text))) pushOption(option);
  });
  normalizeArray(field.values).slice(0, 8).forEach(pushOption);
  return picked.slice(0, 20);
}

function editorAttributeOptionText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    return String(value.value || value.label || value.name || value.text || value.id || value.dictionary_value_id || "").trim();
  }
  return String(value || "").trim();
}

function editorAttributeOptionValueCandidates(option = {}) {
  if (!option || typeof option !== "object") return [editorAttributeOptionText(option)].filter(Boolean);
  return [
    option.value,
    option.label,
    option.name,
    option.text,
    option.display_value_zh,
    option.zh,
    option.cn
  ].map(editorAttributeOptionText).filter(Boolean);
}
export async function createSelectionFromCollectorBox(sku, body = {}, session = null) {
  const detail = await collectorBoxProductDetail(sku, session, body?.tenant_id || body?.tenantId || "admin");
  if (!detail) throw new Error("閲囬泦绠卞晢鍝佷笉瀛樺湪");
  const editInput = body.editPayload || body.edit_payload || body || {};
  if (detail.listing_template_id && !collectorBoxTemplateSnapshot(detail).id) {
    const template = await listingCategoryTemplate(detail.listing_template_id, session).catch(() => null);
    if (template) {
      detail.templateSnapshot = compactTemplateForEditor(template);
      detail.listingTemplate = detail.templateSnapshot;
    }
  }
  const productBodies = buildSelectionProductBodiesFromCollectorBox(detail, body, session);
  const isVariantSplit = productBodies.length > 1 || normalizeArray(body.variantSelections || body.variant_selections || body.variants).length > 0;
  if (detail.selection_product_id) {
    let existingProduct = await selectionProductMysql(detail.selection_product_id);
    if (existingProduct && !isVariantSplit) {
      const productBody = productBodies[0] || {};
      const imageUrls = [productBody.image_url, ...normalizeArray(productBody.detail_image_urls)].filter(Boolean);
      if (imageUrls[0] && /\[object Object\]/i.test(`${existingProduct.image_url || ""} ${existingProduct.detail_image_urls || ""}`)) {
        await mysqlExecute(`
          UPDATE products
          SET image_url = ?, detail_image_urls = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [imageUrls[0], JSON.stringify(imageUrls.slice(1)), detail.selection_product_id]);
        existingProduct = await selectionProductMysql(detail.selection_product_id);
      }
      if (body.name || body.internal_product_name || body.title || body.editPayload || body.edit_payload) {
        const updatedName = String(body.name || body.internal_product_name || body.title || productBody.name || existingProduct.name || `Ozon ${detail.sku}`).trim();
        const selectionNote = [productBody.supplier_note || buildCollectorSelectionNote(detail), existingProduct.supplier_note || ""].filter(Boolean).join("\n");
        await mysqlExecute(`
          UPDATE products
          SET name = ?, image_url = ?, detail_image_urls = ?, ozon_category_name = ?, material = ?, color = ?,
              vehicle_brand = ?, vehicle_model = ?, selling_points = ?, purchase_url = ?, source_platform = ?,
              supplier_note = ?, purchase_cost = ?, domestic_shipping = ?, handling_fee = ?, purchase_quantity = ?,
              package_weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?, listing_price_rub = ?,
              air_sale_price_rmb = ?, listing_title_ru = ?, listing_tags_ru = ?, listing_description_ru = ?,
              exchange_rate = COALESCE(?, exchange_rate), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [
          updatedName,
          productBody.image_url || existingProduct.image_url || detail.image_url || "",
          JSON.stringify(imageUrls.slice(1)),
          productBody.ozon_category_name || existingProduct.ozon_category_name || detail.category_name || "",
          productBody.material || existingProduct.material || "",
          productBody.color || existingProduct.color || "",
          productBody.vehicle_brand || existingProduct.vehicle_brand || "",
          productBody.vehicle_model || existingProduct.vehicle_model || "",
          productBody.selling_points || existingProduct.selling_points || "",
          productBody.purchase_url || existingProduct.purchase_url || detail.product_url || "",
          productBody.source_platform || existingProduct.source_platform || "Ozon",
          selectionNote,
          productBody.purchase_cost || existingProduct.purchase_cost || 0,
          productBody.domestic_shipping || existingProduct.domestic_shipping || 0,
          productBody.handling_fee || existingProduct.handling_fee || 0,
          productBody.purchase_quantity || existingProduct.purchase_quantity || 1,
          productBody.package_weight_g || existingProduct.package_weight_g || 0,
          productBody.length_cm || existingProduct.length_cm || 30,
          productBody.width_cm || existingProduct.width_cm || 20,
          productBody.height_cm || existingProduct.height_cm || 10,
          productBody.listing_price_rub || existingProduct.listing_price_rub || 0,
          productBody.air_sale_price_rmb || existingProduct.air_sale_price_rmb || 0,
          productBody.listing_title_ru || existingProduct.listing_title_ru || "",
          productBody.listing_tags_ru || existingProduct.listing_tags_ru || "",
          productBody.listing_description_ru || existingProduct.listing_description_ru || "",
          productBody.exchange_rate || null,
          detail.selection_product_id
        ]);
        existingProduct = await selectionProductMysql(detail.selection_product_id);
      }
      await mysqlExecute(`
        UPDATE ozon_plugin_collected_products
        SET edit_payload_json = ?, status = 'selection_created', edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND sku = ?
      `, [JSON.stringify({ ...editInput, internal_product_name: body.internal_product_name || body.name || "" }), detail.tenant_id || "admin", detail.sku]);
      return {
        ok: true,
        reused: true,
        id: detail.selection_product_id,
        product: existingProduct,
        collectorProduct: detail
      };
    }
  }
  const created = [];
  for (const productBody of productBodies) {
    const { __variant, ...createBody } = productBody;
    const result = await createProductMysql(createBody);
    created.push({
      ...result,
      variant: __variant,
      product: await selectionProductMysql(result.id)
    });
  }
  const firstResult = created[0] || {};
  await mysqlExecute(`
    UPDATE ozon_plugin_collected_products
    SET edit_payload_json = ?, status = 'selection_created', selection_product_id = ?, edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = ? AND sku = ?
  `, [JSON.stringify({
    ...editInput,
    internal_product_name: body.internal_product_name || body.name || "",
    selection_product_ids: created.map((item) => item.id),
    created_variant_count: created.length
  }), firstResult.id, detail.tenant_id || "admin", detail.sku]);
  return {
    ...firstResult,
    products: created.map((item) => item.product).filter(Boolean),
    created_count: created.length,
    product: firstResult.product || await selectionProductMysql(firstResult.id),
    collectorProduct: await collectorBoxProductDetail(detail.sku, session, detail.tenant_id || body?.tenant_id || body?.tenantId || "admin")
  };
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
  if (!detail) throw new Error("Collected product detail not found");
  return createListingTemplateFromCollectedProduct(detail.payload, session);
}

export async function uploadListingMedia(req, options = {}) {
  await ensureListingAutomationSchema();
  const file = await readListingMediaMultipart(req);
  const safeName = sanitizeListingMediaFilename(file.filename || "upload");
  const extension = path.extname(safeName).toLowerCase();
  const expectedContentType = LISTING_MEDIA_TYPES.get(extension);
  if (!expectedContentType) {
    const error = new Error("涓婃灦绱犳潗浠呮敮鎸?jpg銆乯peg銆乸ng銆亀ebp銆乵p4銆乵ov銆亀ebm");
    error.status = 415;
    throw error;
  }
  if (!file.buffer?.length) {
    const error = new Error("涓婁紶鏂囦欢涓虹┖");
    error.status = 400;
    throw error;
  }
  if (file.buffer.length > LISTING_MEDIA_MAX_BYTES) {
    const error = new Error("涓婃灦绱犳潗涓嶈兘瓒呰繃 200MB");
    error.status = 413;
    throw error;
  }

  const storedName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const filePath = await writeListingMediaFile(storedName, file.buffer);
  const url = `/uploads/listing-media/${storedName}`;
  const configuredPublishUrl = buildListingMediaPublishUrl(url);
  const publishUrl = await ensureListingMediaPublicUrl({
    localPath: filePath,
    localUrl: url,
    publishUrl: configuredPublishUrl,
    filename: safeName,
    contentType: file.contentType || expectedContentType,
    metadata: {
      source_module: file.fields?.source_module || file.fields?.sourceModule || "listing_upload",
      source_id: file.fields?.source_id || file.fields?.sourceId || "",
      batch_id: file.fields?.batch_id || file.fields?.batchId || "",
      shop_id: file.fields?.shop_id ?? file.fields?.shopId ?? "",
      variant_id: file.fields?.variant_id ?? file.fields?.variantId ?? "",
      role: file.fields?.role || (expectedContentType.startsWith("video/") ? "video" : "image")
    },
    skipPublicSync: options.skipPublicSync || file.fields?.skip_public_sync === "1"
  });
  const asset = await registerListingMediaAsset({
    source_module: file.fields?.source_module || file.fields?.sourceModule || "listing_upload",
    source_id: file.fields?.source_id || file.fields?.sourceId || "",
    batch_id: file.fields?.batch_id || file.fields?.batchId || "",
    shop_id: nullableNumber(file.fields?.shop_id ?? file.fields?.shopId),
    variant_id: nullableNumber(file.fields?.variant_id ?? file.fields?.variantId),
    media_type: expectedContentType.startsWith("video/") ? "video" : "image",
    role: file.fields?.role || (expectedContentType.startsWith("video/") ? "video" : "image"),
    local_path: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
    preview_url: url,
    publish_url: publishUrl || "",
    original_name: safeName,
    storage_name: storedName,
    mime_type: file.contentType || expectedContentType,
    file_size: file.buffer.length,
    hash_sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    status: publishUrl ? "public_ready" : "local_only",
    metadata: {
      upload: "listing_media",
      assetVariantTitle: file.fields?.asset_variant_title || "",
      assetVariantSourceTitle: file.fields?.asset_variant_source_title || "",
      assetVariantOutputDir: file.fields?.asset_variant_output_dir || ""
    }
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

export async function watermarkListingMedia(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const shopId = Number(body.shop_id || body.shopId || 0);
  const images = normalizeArray(body.images || body.urls || body.image_urls)
    .map((item) => (typeof item === "string" ? { url: item } : item))
    .map((item) => ({
      url: String(item.url || item.previewUrl || item.preview_url || item.publishUrl || item.publish_url || "").trim(),
      name: String(item.name || item.original_name || item.filename || "").trim()
    }))
    .filter((item) => item.url);
  if (!shopId) {
    const error = new Error("璇烽€夋嫨瑕佷娇鐢ㄦ按鍗扮殑搴楅摵");
    error.status = 400;
    throw error;
  }
  if (!images.length) {
    const error = new Error("Please select images to watermark");
    error.status = 400;
    throw error;
  }
  const shop = await listingWatermarkShop(shopId);
  const watermarkPath = await resolveListingShopWatermarkPath(shop);
  const options = listingShopWatermarkOptions(shop);
  const results = [];
  for (const [index, image] of images.entries()) {
    const source = await readListingImageBuffer(image.url);
    const output = await applyListingWatermark(source.buffer, watermarkPath, options);
    const originalName = sanitizeListingMediaFilename(image.name || `watermarked-${index + 1}.png`).replace(/\.[^.]+$/, "");
    const storedName = `${Date.now()}-${crypto.randomUUID()}-watermarked.png`;
    const filePath = await writeListingMediaFile(storedName, output);
    const url = `/uploads/listing-media/${storedName}`;
    const publishUrl = buildListingMediaPublishUrl(url);
    const asset = await registerListingMediaAsset({
      source_module: body.source_module || body.sourceModule || "listing_watermark",
      source_id: body.source_id || body.sourceId || "",
      batch_id: body.batch_id || body.batchId || "",
      shop_id: shopId,
      media_type: "image",
      role: body.role || "watermarked",
      local_path: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
      source_path: image.url,
      preview_url: url,
      publish_url: publishUrl || "",
      original_name: `${originalName}.png`,
      storage_name: storedName,
      mime_type: "image/png",
      file_size: output.length,
      hash_sha256: crypto.createHash("sha256").update(output).digest("hex"),
      status: publishUrl ? "public_ready" : "local_only",
      metadata: {
        watermark: true,
        sourceUrl: image.url,
        shopId,
        shopName: shop.name || "",
        options
      }
    }, session);
    results.push({
      url: publishUrl || url,
      localUrl: url,
      previewUrl: url,
      publishUrl: publishUrl || "",
      name: `${originalName}.png`,
      assetId: asset.id,
      asset
    });
  }
  return {
    ok: true,
    shop: { id: Number(shop.id), name: shop.name || "" },
    images: results
  };
}

async function generateWatermarkedListingImages(images = [], shop = {}, session = null, options = {}) {
  const normalizedInput = normalizeArray(images)
    .map((item, index) => (typeof item === "string" ? { url: item, name: `image-${index + 1}` } : item))
    .map((item, index) => ({
      url: String(item.url || item.previewUrl || item.preview_url || item.publishUrl || item.publish_url || "").trim(),
      name: String(item.name || item.original_name || item.filename || `image-${index + 1}`).trim()
    }))
    .filter((item) => item.url);
  const normalized = await resolveOriginalWatermarkSources(normalizedInput);
  if (!normalized.length) return [];
  if (!shop?.watermark_path) {
    return normalized.map((item, index) => ({
      source_url: item.original_url || item.url,
      generated_url: item.url,
      preview_url: item.url,
      publish_url: item.url,
      watermark_path: "",
      status: "missing_watermark",
      sort_order: index + 1
    }));
  }
  const watermarked = await watermarkListingMedia({
    shop_id: shop.id,
    images: normalized,
    source_module: options.source_module || "listing_shop_copy",
    source_id: options.source_id || "",
    batch_id: options.batch_id || "",
    role: options.role || "shop_copy_watermark"
  }, session);
  return normalized.map((item, index) => {
    const next = watermarked.images?.[index] || {};
    return {
      source_url: item.original_url || item.url,
      generated_url: String(next.publishUrl || next.url || next.previewUrl || item.url).trim(),
      preview_url: String(next.previewUrl || next.url || item.url).trim(),
      publish_url: String(next.publishUrl || next.url || "").trim(),
      watermark_path: shop.watermark_path || "",
      status: next.url || next.previewUrl ? "watermark_ready" : "watermark_failed",
      sort_order: index + 1,
      asset_id: Number(next.assetId || next.asset?.id || 0) || null
    };
  });
}

async function resolveOriginalWatermarkSources(images = []) {
  const resolved = [];
  for (const item of normalizeArray(images)) {
    const originalUrl = String(item.url || "").trim();
    const sourceUrl = await originalSourceForWatermarkedListingMedia(originalUrl);
    resolved.push({
      ...item,
      original_url: originalUrl,
      url: sourceUrl || originalUrl
    });
  }
  return resolved;
}

async function originalSourceForWatermarkedListingMedia(url = "") {
  const value = String(url || "").trim();
  if (!value || !listingMediaPathFromUrl(value)) return "";
  const asset = await row(`
    SELECT source_path, metadata_json
    FROM listing_media_assets
    WHERE (publish_url = ? OR preview_url = ?)
      AND (role LIKE '%watermark%' OR metadata_json LIKE '%"watermark":true%')
    ORDER BY id DESC
    LIMIT 1
  `, [value, value]).catch(() => null);
  const metadata = parseJson(asset?.metadata_json, {});
  const source = String(asset?.source_path || metadata.sourceUrl || "").trim();
  if (!source || source === value) return "";
  return source;
}

async function applyShopWatermarkedImagesToPayload(payload = {}, shop = {}, session = null) {
  const next = {
    ...payload,
    items: normalizeArray(payload.items).map((item) => ({ ...item }))
  };
  if (!next.items.length || !shop?.id) return next;
  const uniqueImages = [];
  const seen = new Set();
  for (const item of next.items) {
    const current = [item.primary_image, ...normalizeArray(item.images)].map((value) => String(value || "").trim()).filter(Boolean);
    for (const url of current) {
      if (seen.has(url)) continue;
      seen.add(url);
      uniqueImages.push({ url, name: path.basename(url.split("?")[0] || `image-${uniqueImages.length + 1}.png`) });
    }
  }
  if (!uniqueImages.length || !shop.watermark_path) return next;
  const generated = await generateWatermarkedListingImages(uniqueImages, shop, session, {
    source_module: "listing_publish",
    source_id: String(shop.id || ""),
    role: "publish_watermark"
  });
  const urlMap = new Map(generated.map((item) => [String(item.source_url || "").trim(), String(item.generated_url || item.source_url || "").trim()]));
  next.items = next.items.map((item) => {
    const remapped = [item.primary_image, ...normalizeArray(item.images)]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((url) => urlMap.get(url) || url);
    const primaryImage = remapped[0] || String(item.primary_image || "").trim();
    return {
      ...item,
      primary_image: primaryImage,
      images: remapped.slice(primaryImage ? 1 : 0)
    };
  });
  next.watermark_summary = {
    shop_id: Number(shop.id || 0),
    shop_name: shop.name || "",
    total: generated.length,
    ready: generated.filter((item) => item.status === "watermark_ready").length
  };
  return next;
}

function shouldReusePreparedShopWatermarkMedia(body = {}, shop = {}) {
  if (body.skip_publish_watermark || body.skipPublishWatermark) return true;
  const template = body.template || body;
  const editable = objectValue(template.editable_payload || template.editablePayload);
  const sourceRaw = objectValue(template.source_raw || template.sourceRaw || editable.source_raw || editable.sourceRaw);
  const sourceType = String(template.source_type || template.sourceType || sourceRaw.source_type || sourceRaw.sourceType || "").trim();
  if (sourceType !== "asset_variant_engine") return false;
  const sourceShopId = Number(sourceRaw.shop_id || sourceRaw.shopId || template.source_shop_id || template.sourceShopId || 0);
  if (!sourceShopId || sourceShopId !== Number(shop.id || 0)) return false;
  if (sourceRaw.shop_watermark_applied === false || sourceRaw.publish_media_pre_watermarked === false) return false;
  return Boolean(sourceRaw.asset_variant_id || sourceRaw.shop_watermark_applied || sourceRaw.publish_media_pre_watermarked);
}

function preparedShopWatermarkSummary(payload = {}, shop = {}) {
  const imageCount = normalizeArray(payload.items).reduce((count, item) => {
    const images = [item.primary_image, ...normalizeArray(item.images)].map((value) => String(value || "").trim()).filter(Boolean);
    return count + new Set(images).size;
  }, 0);
  return {
    shop_id: Number(shop.id || 0),
    shop_name: shop.name || "",
    total: imageCount,
    ready: imageCount,
    skipped: true,
    reason: "prepared_shop_media"
  };
}

async function resolveShopTailImageUrl(shop = {}, session = null) {
  const shopId = Number(shop.id || shop.shop_id || 0);
  if (!shopId) return "";
  const rule = await row(`
    SELECT tail_image_url, tail_template_id
    FROM shop_variant_rules
    WHERE shop_id = ?
    LIMIT 1
  `, [shopId]).catch(() => null);
  const raw = String(rule?.tail_image_url || "").trim();
  if (raw) return materializeShopTailImageForPublish(raw, shop, session);
  const template = await row(`
    SELECT image_path
    FROM asset_tail_templates
    WHERE status <> 'deleted'
      AND (shop_id = ? OR shop_id IS NULL OR shop_id = 0)
      ${Number(rule?.tail_template_id || 0) ? "AND id = ?" : ""}
    ORDER BY
      CASE WHEN id = ? THEN 0 ELSE 1 END,
      CASE WHEN shop_id = ? THEN 0 ELSE 1 END,
      is_default DESC,
      sort_order ASC,
      id DESC
    LIMIT 1
  `, Number(rule?.tail_template_id || 0)
    ? [shopId, Number(rule.tail_template_id), Number(rule.tail_template_id), shopId]
    : [shopId, 0, shopId]).catch(() => null);
  return materializeShopTailImageForPublish(template?.image_path || "", shop, session);
}

function normalizeShopTailImageUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || /^data:image\//i.test(raw)) return raw;
  if (raw.startsWith("/uploads/")) return buildListingMediaPublishUrl(raw) || raw;
  const normalized = raw.replace(/\\/g, "/");
  const publicIndex = normalized.toLowerCase().lastIndexOf("/public/uploads/");
  if (publicIndex >= 0) {
    const relative = normalized.slice(publicIndex + "/public".length);
    return buildListingMediaPublishUrl(relative) || relative;
  }
  const uploadsIndex = normalized.toLowerCase().lastIndexOf("/uploads/");
  if (uploadsIndex >= 0) {
    const relative = normalized.slice(uploadsIndex);
    return buildListingMediaPublishUrl(relative) || relative;
  }
  const relative = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return buildListingMediaPublishUrl(relative) || relative;
}

async function materializeShopTailImageForPublish(value = "", shop = {}, session = null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const localPath = await resolveShopTailImageLocalPath(raw);
  if (!localPath) return normalizeShopTailImageUrl(raw);
  const buffer = await fs.readFile(localPath);
  if (!buffer.length) return "";
  const extension = LISTING_MEDIA_TYPES.has(path.extname(localPath).toLowerCase()) ? path.extname(localPath).toLowerCase() : ".png";
  const storedName = `${Date.now()}-${crypto.randomUUID()}-tail-template${extension}`;
  const filePath = await writeListingMediaFile(storedName, buffer);
  const localUrl = `/uploads/listing-media/${storedName}`;
  const publishUrl = buildListingMediaPublishUrl(localUrl) || localUrl;
  await registerListingMediaAsset({
    source_module: "listing_publish",
    source_id: String(shop.id || ""),
    shop_id: Number(shop.id || shop.shop_id || 0) || null,
    media_type: "image",
    role: "tail_template",
    local_path: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
    source_path: raw,
    preview_url: localUrl,
    publish_url: publishUrl,
    original_name: sanitizeListingMediaFilename(path.basename(localPath) || "tail-template.png"),
    storage_name: storedName,
    mime_type: mimeTypeForListingMediaExtension(extension),
    file_size: buffer.length,
    hash_sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    status: publishUrl && !isLocalImportMedia(publishUrl) ? "public_ready" : "local_only",
    metadata: {
      tailTemplate: true,
      shopId: Number(shop.id || shop.shop_id || 0) || 0,
      shopName: shop.name || ""
    }
  }, session).catch(() => null);
  return publishUrl;
}

async function resolveShopTailImageLocalPath(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = decodeURIComponent(new URL(raw).pathname);
    } catch {
      return "";
    }
  }
  const normalized = pathname.replace(/\\/g, "/").replace(/^\/+/, "");
  const candidates = [];
  const add = (target) => {
    const resolved = path.resolve(target);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };
  if (normalized.startsWith("public/uploads/")) add(path.join(process.cwd(), normalized));
  if (normalized.startsWith("uploads/")) add(path.join(process.cwd(), "public", normalized));
  const uploadsIndex = normalized.toLowerCase().lastIndexOf("uploads/asset-tail-templates/");
  if (uploadsIndex >= 0) add(path.join(process.cwd(), "public", normalized.slice(uploadsIndex)));
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return "";
}

function appendTailImageToPayload(payload = {}, tailImageUrl = "") {
  const tailUrl = String(tailImageUrl || "").trim();
  const next = {
    ...payload,
    items: normalizeArray(payload.items).map((item) => ({ ...item }))
  };
  if (!tailUrl || !next.items.length) return { payload: next, appended: 0 };
  let appended = 0;
  next.items = next.items.map((item) => {
    const ordered = [String(item.primary_image || "").trim(), ...normalizeArray(item.images).map((value) => String(value || "").trim())].filter(Boolean);
    if (!ordered.length) return item;
    const alreadyTail = ordered.some((url) => url === tailUrl);
    const finalImages = alreadyTail ? ordered : [...ordered, tailUrl];
    if (!alreadyTail) appended += 1;
    return {
      ...item,
      primary_image: finalImages[0] || "",
      images: finalImages.slice(1)
    };
  });
  return { payload: next, appended };
}

function appendTailImageToCopyImages(images = [], tailImageUrl = "") {
  const tailUrl = String(tailImageUrl || "").trim();
  const normalized = normalizeArray(images).map((item, index) => ({
    source_url: String(item?.source_url || item?.generated_url || "").trim(),
    generated_url: String(item?.generated_url || item?.source_url || "").trim(),
    preview_url: String(item?.preview_url || item?.generated_url || item?.source_url || "").trim(),
    publish_url: String(item?.publish_url || item?.generated_url || "").trim(),
    watermark_path: String(item?.watermark_path || "").trim(),
    status: String(item?.status || "").trim(),
    sort_order: Number(item?.sort_order || index + 1) || index + 1,
    asset_id: item?.asset_id || null
  })).filter((item) => item.generated_url || item.preview_url || item.source_url);
  if (!tailUrl) {
    return {
      images: normalized,
      tail_summary: { configured: false, appended: 0 }
    };
  }
  const exists = normalized.some((item) => item.generated_url === tailUrl || item.source_url === tailUrl);
  if (exists) {
    return {
      images: normalized,
      tail_summary: { configured: true, appended: 0 }
    };
  }
  const sortOrder = normalized.length + 1;
  return {
    images: [...normalized, {
      source_url: tailUrl,
      generated_url: tailUrl,
      preview_url: tailUrl,
      publish_url: tailUrl,
      watermark_path: "",
      status: "tail_ready",
      sort_order: sortOrder,
      asset_id: null
    }],
    tail_summary: { configured: true, appended: 1 }
  };
}

export async function listingMediaAssets(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const paged = String(query.paged || "") === "1" || String(query.paged || "").toLowerCase() === "true";
  const page = Math.max(Number(query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || query.limit || 20), 1), 100);
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  const where = ["m.status <> 'deleted'"];
  const params = [];
  const keyword = cleanText(query.keyword || query.q || "", 160).toLowerCase();
  const mediaType = cleanText(query.mediaType || query.media_type || "", 40).toLowerCase();
  const role = cleanText(query.role || "", 80).toLowerCase();
  const status = cleanText(query.status || "", 40).toLowerCase();
  if (mediaType) {
    where.push("LOWER(m.media_type) = ?");
    params.push(mediaType);
  }
  if (role) {
    where.push("LOWER(m.role) = ?");
    params.push(role);
  }
  if (status) {
    where.push("LOWER(m.status) = ?");
    params.push(status);
  }
  if (keyword) {
    where.push(`(
      LOWER(COALESCE(v.source_title, '')) LIKE ? OR
      LOWER(COALESCE(v.variant_title, '')) LIKE ? OR
      LOWER(COALESCE(v.variant_title_zh, '')) LIKE ? OR
      LOWER(COALESCE(m.batch_id, '')) LIKE ? OR
      LOWER(COALESCE(m.source_id, '')) LIKE ? OR
      LOWER(COALESCE(m.original_name, '')) LIKE ? OR
      LOWER(COALESCE(m.storage_name, '')) LIKE ? OR
      LOWER(COALESCE(v.ozon_category_name, '')) LIKE ? OR
      LOWER(COALESCE(m.metadata_json, '')) LIKE ?
    )`);
    params.push(...Array(9).fill(`%${keyword}%`));
  }
  const joinedFrom = `
      FROM listing_media_assets m
      LEFT JOIN asset_variants v
        ON v.batch_id = m.batch_id
       AND (v.shop_id = m.shop_id OR m.shop_id IS NULL)
      WHERE ${where.join(" AND ")}
  `;
  let rows;
  try {
    if (paged) {
      const countRow = await row(`SELECT COUNT(*) AS total ${joinedFrom}`, params);
      const total = Number(countRow?.total || 0);
      rows = await all(`
        SELECT m.*,
               v.source_title AS asset_variant_source_title,
               v.id AS asset_variant_id,
               v.variant_title AS asset_variant_title,
               v.variant_title_zh AS asset_variant_title_zh,
               v.tags_json AS asset_variant_tags_json,
               v.tag_style AS asset_variant_tag_style,
               v.price_index AS asset_variant_price_index,
               v.internal_price AS asset_variant_internal_price,
               v.ozon_price AS asset_variant_ozon_price,
               v.ozon_old_price AS asset_variant_ozon_old_price,
               v.ozon_category_name AS asset_variant_ozon_category_name,
               v.ozon_category_id AS asset_variant_ozon_category_id,
               v.color AS asset_variant_color,
               v.material_text AS asset_variant_material,
               v.quantity_text AS asset_variant_quantity,
               v.output_dir AS asset_variant_output_dir,
               v.created_at AS asset_variant_created_at
        ${joinedFrom}
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT ? OFFSET ?
      `, [...params, pageSize, (page - 1) * pageSize]);
      return {
        rows: rows.map(normalizeListingMediaAssetRow),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        mode: "paged"
      };
    }
    rows = await all(`
      SELECT m.*,
             v.source_title AS asset_variant_source_title,
             v.id AS asset_variant_id,
             v.variant_title AS asset_variant_title,
             v.variant_title_zh AS asset_variant_title_zh,
             v.tags_json AS asset_variant_tags_json,
             v.tag_style AS asset_variant_tag_style,
             v.price_index AS asset_variant_price_index,
             v.internal_price AS asset_variant_internal_price,
             v.ozon_price AS asset_variant_ozon_price,
             v.ozon_old_price AS asset_variant_ozon_old_price,
             v.ozon_category_name AS asset_variant_ozon_category_name,
             v.ozon_category_id AS asset_variant_ozon_category_id,
             v.color AS asset_variant_color,
             v.material_text AS asset_variant_material,
             v.quantity_text AS asset_variant_quantity,
             v.output_dir AS asset_variant_output_dir,
             v.created_at AS asset_variant_created_at
      FROM listing_media_assets m
      LEFT JOIN asset_variants v
        ON v.batch_id = m.batch_id
       AND (v.shop_id = m.shop_id OR m.shop_id IS NULL)
      WHERE m.status <> 'deleted'
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT ?
    `, [limit]);
  } catch (error) {
    rows = await all(`
      SELECT *
      FROM listing_media_assets
      WHERE status <> 'deleted'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `, [limit]);
  }
  return rows.map(normalizeListingMediaAssetRow);
}

export async function searchMaterialPackages(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const page = Math.max(Number(query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 12), 1), 50);
  const filters = {
    keyword: cleanText(query.keyword, 120),
    name: cleanText(query.name, 120),
    shopId: Number(query.shopId || query.shop_id || 0),
    brand: cleanText(query.brand, 120),
    model: cleanText(query.model, 120),
    productType: cleanText(query.productType || query.product_type, 120)
  };
  const where = ["t.status <> 'deleted'", "t.source_type IN ('asset_variant_engine', 'manual', 'ozon_frontend_collect', 'ozon_sku_copy')"];
  const params = [];
  if (filters.keyword) {
    where.push(`(
      t.template_name LIKE ? OR t.title LIKE ? OR t.category_name LIKE ? OR t.source_raw_json LIKE ? OR t.attributes_json LIKE ?
    )`);
    params.push(...Array(5).fill(`%${filters.keyword}%`));
  }
  if (filters.name) {
    where.push("t.template_name LIKE ?");
    params.push(`%${filters.name}%`);
  }
  if (filters.shopId) {
    where.push("(t.source_shop_id = ? OR JSON_EXTRACT(t.source_raw_json, '$.shop_id') = ?)");
    params.push(filters.shopId, filters.shopId);
  }
  if (filters.brand) {
    where.push("(t.attributes_json LIKE ? OR t.editable_payload_json LIKE ?)");
    params.push(`%${filters.brand}%`, `%${filters.brand}%`);
  }
  if (filters.model) {
    where.push("(t.attributes_json LIKE ? OR t.editable_payload_json LIKE ?)");
    params.push(`%${filters.model}%`, `%${filters.model}%`);
  }
  if (filters.productType) {
    where.push("(t.category_name LIKE ? OR t.template_name LIKE ? OR t.editable_payload_json LIKE ?)");
    params.push(`%${filters.productType}%`, `%${filters.productType}%`, `%${filters.productType}%`);
  }
  const offset = (page - 1) * pageSize;
  const rows = await all(`
    SELECT t.*, s.name AS shop_name
    FROM listing_category_templates t
    LEFT JOIN shops s ON s.id = t.source_shop_id
    WHERE ${where.join(" AND ")}
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, offset]);
  return {
    page,
    pageSize,
    items: rows.map(normalizeMaterialPackageRow)
  };
}

export async function materialPackageDetail(id, session = null) {
  await ensureListingAutomationSchema();
  const item = await row(`
    SELECT t.*, s.name AS shop_name
    FROM listing_category_templates t
    LEFT JOIN shops s ON s.id = t.source_shop_id
    WHERE t.id = ? AND t.status <> 'deleted'
    LIMIT 1
  `, [Number(id)]);
  if (!item) throw new Error("绱犳潗鍖呬笉瀛樺湪");
  const template = normalizeTemplateRow(item);
  return {
    ...normalizeMaterialPackageRow(item),
    template
  };
}

export async function generateDeepSeekListingContent(body = {}, session = null) {
  const type = cleanText(body.type, 64);
  const context = objectValue(body.context || {});
  const allowed = new Set(["listingForm", "title", "keywords", "tags", "description", "shortDescription", "categorySuggest", "attributeFill", "translateRu", "translateZh", "optimizeSeo", "imageCopy"]);
  if (!allowed.has(type)) throw new Error("Unsupported DeepSeek generation type");
  const result = await chatWithAiProvider({
    temperature: 0.25,
    maxTokens: 4000,
    messages: [
      { role: "system", content: "You are DeepSeek used inside an Ozon Russia listing ERP. Return only valid JSON with keys content and fields. No markdown." },
      { role: "user", content: buildDeepSeekListingPrompt(type, context) }
    ]
  });
  const parsed = parseAiContentJson(result.content);
  return {
    success: true,
    data: {
      content: String(parsed.content || result.content || "").trim(),
      fields: objectValue(parsed.fields || parsed)
    },
    provider: result.provider,
    model: result.model
  };
}

export async function generateListingOfferId(body = {}, session = null) {
  const brand = cleanText(body.brand, 32).toUpperCase() || "OZON";
  const productType = cleanText(body.productType || body.product_type, 64);
  const existing = new Set(normalizeStringList(body.existingIds || body.existing_ids).map((item) => item.toUpperCase()));
  const prefix = cleanText(body.prefix, 64).toUpperCase() || `${brand}-${productTypeAbbr(productType)}`;
  for (let index = 0; index < 100; index += 1) {
    const offerId = `${prefix}-${Math.floor(100000 + Math.random() * 900000)}`;
    if (!existing.has(offerId.toUpperCase())) return { offerId };
  }
  return { offerId: `${prefix}-${Date.now().toString().slice(-6)}` };
}

export async function listingOzonCategories(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const keyword = String(query.keyword || query.q || "").trim();
  const limit = Math.min(Math.max(Number(query.limit || 80), 1), 10000);
  const params = [];
  let where = "WHERE status = 'active'";
  if (keyword) {
    where += " AND (name_zh LIKE ? OR name_ru LIKE ? OR path_zh LIKE ? OR path_ru LIKE ?)";
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  }
  params.push(limit);
  const rows = await all(`
    SELECT *
    FROM ozon_category_mappings
    ${where}
    ORDER BY
      CASE WHEN name_zh = ? OR name_ru = ? THEN 0 ELSE 1 END,
      path_zh ASC,
      path_ru ASC,
      name_zh ASC,
      is_auto DESC,
      updated_at DESC
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
  const validRows = rows.filter((item) => item.descriptionCategoryId && item.typeId);
  for (const chunk of chunkArray(validRows, 300)) {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'ozon_api', ?, 'active', CURRENT_TIMESTAMP)").join(",");
    const params = [];
    for (const item of chunk) {
      params.push(
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
      );
    }
    await run(`
      INSERT INTO ozon_category_mappings
      (description_category_id, type_id, name_ru, name_zh, path_ru, path_zh, parent_description_category_id,
       is_auto, source_shop_id, source, raw_json, status, synced_at)
      VALUES ${placeholders}
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
    `, params);
    saved += chunk.length;
  }
  return { ok: true, shopId: Number(shop.id), shopName: shop.name, saved };
}

export async function resolveOzonCategoryFromSku(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const sku = String(body.sku || body.ozon_sku || body.ozonSku || body.offer_id || body.offerId || "").trim();
  if (!sku) throw new Error("璇疯緭鍏?Ozon SKU 鎴?offer_id");
  const shop = await resolveOzonApiShop(body.shop_id || body.shopId);
  const localProduct = await row(`
    SELECT *
    FROM online_products
    WHERE shop_id = ?
      AND (ozon_sku = ? OR ozon_product_id = ? OR offer_id = ?)
    ORDER BY synced_at DESC, updated_at DESC
    LIMIT 1
  `, [shop.id, sku, sku, sku]);
  if (!localProduct) throw new Error("Local online product cache does not contain this SKU. Sync online products first or try offer_id.");

  const productId = Number(localProduct.ozon_product_id || 0);
  const details = productId
    ? await fetchOzonProductInfoAttributes(shop, { productIds: [productId], limit: 1 }).catch(() => [])
    : [];
  const detail = details[0] || {};
  const localAttributes = parseJson(localProduct.attributes_json, {});
  const descriptionCategoryId = Number(detail.description_category_id || detail.descriptionCategoryId || localAttributes.description_category_id || 0);
  const typeId = Number(detail.type_id || detail.typeId || localAttributes.type_id || 0);
  if (!descriptionCategoryId || !typeId) throw new Error("鎵惧埌浜嗗晢鍝侊紝浣嗘病鏈夎鍒?description_category_id/type_id");

  const cached = await row(`
    SELECT *
    FROM ozon_category_mappings
    WHERE description_category_id = ? AND type_id = ? AND status = 'active'
    LIMIT 1
  `, [descriptionCategoryId, typeId]);
  const fallbackName = detail.category_name || localProduct.name || `${descriptionCategoryId}:${typeId}`;
  const category = cached ? normalizeOzonCategoryRow(cached) : normalizeOzonCategoryRow({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    name_zh: `寰呯炕璇戠被鐩?${descriptionCategoryId}:${typeId}`,
    name_ru: fallbackName,
    path_zh: `寰呯炕璇戠被鐩?${descriptionCategoryId}:${typeId}`,
    path_ru: fallbackName,
    raw_json: JSON.stringify(detail || {})
  });
  return {
    ok: true,
    shopId: Number(shop.id),
    shopName: shop.name,
    sku,
    product: {
      ozon_product_id: String(localProduct.ozon_product_id || ""),
      ozon_sku: String(localProduct.ozon_sku || ""),
      offer_id: String(localProduct.offer_id || ""),
      name: localProduct.name || ""
    },
    category
  };
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
  if (!rows.length && query.auto_sync !== false && query.autoSync !== false) {
    await syncListingOzonCategoryAttributes({
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      shop_id: query.shop_id || query.shopId,
      language: query.language || "ZH_HANS",
      sync_values: Boolean(query.sync_values || query.syncValues),
      value_limit: query.value_limit || query.valueLimit || 120,
      return_value_limit: query.value_limit || query.valueLimit || 120
    }, session).catch(() => null);
    const syncedRows = await all(`
      SELECT *
      FROM ozon_category_attributes
      WHERE description_category_id = ? AND type_id = ? AND status = 'active'
      ORDER BY is_required DESC, sort_order ASC, attribute_id ASC
    `, [descriptionCategoryId, typeId]);
    const syncedAttributes = syncedRows.map(normalizeOzonCategoryAttributeRow);
    await attachCachedAttributeValues(syncedAttributes, descriptionCategoryId, typeId, Number(query.value_limit || query.valueLimit || 120));
    return syncedAttributes;
  }
  const attributes = rows.map(normalizeOzonCategoryAttributeRow);
  await attachCachedAttributeValues(attributes, descriptionCategoryId, typeId, Number(query.value_limit || query.valueLimit || 120));
  return attributes;
}

export async function syncListingOzonCategoryAttributes(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const descriptionCategoryId = Number(body.description_category_id || body.descriptionCategoryId || 0);
  const typeId = Number(body.type_id || body.typeId || 0);
  if (!descriptionCategoryId || !typeId) throw new Error("Missing description_category_id/type_id for Ozon category attribute sync.");
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
      (description_category_id, type_id, attribute_id, name, name_zh, description, is_required, attribute_type,
       dictionary_id, is_collection, group_name, sort_order, source_shop_id, raw_json, status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        name_zh = VALUES(name_zh),
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
      pickOzonAttributeNameZh(item, item, attributeId),
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
    attributes: await listingOzonCategoryAttributes({
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      value_limit: body.return_value_limit || body.returnValueLimit || body.value_limit || 40
    }, session)
  };
}

export async function listingOzonAttributeValues(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const descriptionCategoryId = Number(query.description_category_id || query.descriptionCategoryId || 0);
  const typeId = Number(query.type_id || query.typeId || 0);
  const attributeId = Number(query.attribute_id || query.attributeId || 0);
  const keyword = String(query.keyword || query.q || "").trim();
  const limit = Math.min(Math.max(Number(query.limit || 80), 1), 500);
  if (!descriptionCategoryId || !typeId || !attributeId) return [];
  const cacheKey = attributeValueQueryCacheKey({ descriptionCategoryId, typeId, attributeId, keyword, limit });
  const cached = getCachedAttributeValues(cacheKey);
  if (cached) return cached;
  const params = [descriptionCategoryId, typeId, attributeId];
  let where = "WHERE description_category_id = ? AND type_id = ? AND attribute_id = ? AND status = 'active'";
  if (keyword) {
    where += " AND (value LIKE ? OR display_value_zh LIKE ?)";
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  params.push(limit);
  const rows = await all(`
    SELECT *
    FROM ozon_attribute_values
    ${where}
    ORDER BY dictionary_value_id ASC
    LIMIT ?
  `, params);
  const values = rows.map(normalizeOzonAttributeValueRow);
  setCachedAttributeValues(cacheKey, values, {
    color: isColorAttributeValueQuery({ attributeId, cacheHint: query.cache_hint || query.cacheHint })
  });
  return values;
}

function attributeValueQueryCacheKey({ descriptionCategoryId, typeId, attributeId, keyword = "", limit = 80 } = {}) {
  return [descriptionCategoryId, typeId, attributeId, keyword, limit]
    .map((item) => String(item || "").trim().toLowerCase())
    .join(":");
}

function getCachedAttributeValues(cacheKey = "") {
  const cached = attributeValueMemoryCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    attributeValueMemoryCache.delete(cacheKey);
    return null;
  }
  return cached.values.map((item) => ({ ...item }));
}

function setCachedAttributeValues(cacheKey = "", values = [], options = {}) {
  const ttl = options.color ? COLOR_ATTRIBUTE_VALUE_CACHE_TTL_MS : ATTRIBUTE_VALUE_CACHE_TTL_MS;
  attributeValueMemoryCache.set(cacheKey, {
    expiresAt: Date.now() + ttl,
    values: values.map((item) => ({ ...item }))
  });
}

function clearCachedAttributeValues(descriptionCategoryId, typeId, attributeId) {
  const prefix = [descriptionCategoryId, typeId, attributeId]
    .map((item) => String(item || "").trim().toLowerCase())
    .join(":");
  for (const key of attributeValueMemoryCache.keys()) {
    if (key.startsWith(`${prefix}:`)) attributeValueMemoryCache.delete(key);
  }
}

function isColorAttributeValueQuery({ attributeId, cacheHint } = {}) {
  return COLOR_ATTRIBUTE_IDS.has(Number(attributeId || 0)) || String(cacheHint || "").trim().toLowerCase() === "color";
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
  if (!descriptionCategoryId || !typeId || !attributeId) throw new Error("Missing category or attribute id for Ozon attribute value sync.");
  const shop = await resolveOzonApiShop(body.shop_id || body.shopId);
  const keyword = String(body.keyword || body.value || "").trim();
  const values = await fetchLocalizedOzonAttributeValues(shop, {
    descriptionCategoryId,
    typeId,
    attributeId,
    keyword,
    language: body.language || "ZH_HANS",
    limit: body.limit || (keyword ? 80 : 1000)
  });
  let saved = 0;
  for (const item of values) {
    const dictionaryValueId = Number(item.id || item.dictionary_value_id || item.value_id || 0);
    const value = String(item.value || item.name || item.title || "").trim();
    if (!dictionaryValueId && !value) continue;
    const displayValueZh = String(item.display_value_zh || item.name_zh || item.zh || "").trim() || inferOzonAttributeDisplayValueZh(attributeId, value, item);
    await run(`
      INSERT INTO ozon_attribute_values
      (description_category_id, type_id, attribute_id, dictionary_value_id, value, display_value_zh, info, source_shop_id, raw_json, status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        value = VALUES(value),
        display_value_zh = VALUES(display_value_zh),
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
      displayValueZh,
      String(item.info || item.description || "").trim(),
      shop.id,
      JSON.stringify(item)
    ]);
    saved += 1;
  }
  clearCachedAttributeValues(descriptionCategoryId, typeId, attributeId);
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

async function fetchLocalizedOzonAttributeValues(shop, options = {}) {
  const descriptionCategoryId = Number(options.descriptionCategoryId || options.description_category_id || 0);
  const typeId = Number(options.typeId || options.type_id || 0);
  const attributeId = Number(options.attributeId || options.attribute_id || 0);
  const keyword = String(options.keyword || options.value || "").trim();
  const limit = Number(options.limit || (keyword ? 80 : 1000));
  const displayLanguage = String(options.language || "ZH_HANS").trim() || "ZH_HANS";
  const baseLanguage = String(options.baseLanguage || "DEFAULT").trim() || "DEFAULT";
  const fetchValues = (language) => keyword
    ? searchOzonCategoryAttributeValues(shop, { descriptionCategoryId, typeId, attributeId, value: keyword, language, limit })
    : fetchOzonCategoryAttributeValues(shop, { descriptionCategoryId, typeId, attributeId, language, limit });
  const baseValues = await fetchValues(baseLanguage);
  let displayValues = displayLanguage === baseLanguage ? baseValues : await fetchValues(displayLanguage).catch(() => []);
  if (keyword && displayLanguage !== baseLanguage && !hasDictionaryValueIdCoverage(baseValues, displayValues)) {
    displayValues = await fetchOzonCategoryAttributeValues(shop, {
      descriptionCategoryId,
      typeId,
      attributeId,
      language: displayLanguage,
      limit: Math.max(limit, 1000)
    }).catch(() => displayValues);
  }
  return mergeLocalizedOzonAttributeValues(baseValues, displayValues, attributeId);
}

function hasDictionaryValueIdCoverage(baseValues = [], displayValues = []) {
  const baseIds = new Set(normalizeArray(baseValues).map((item) => Number(item?.id || item?.dictionary_value_id || item?.value_id || 0)).filter(Boolean));
  if (!baseIds.size) return true;
  const displayIds = new Set(normalizeArray(displayValues).map((item) => Number(item?.id || item?.dictionary_value_id || item?.value_id || 0)).filter(Boolean));
  return [...baseIds].some((id) => displayIds.has(id));
}

function mergeLocalizedOzonAttributeValues(baseValues = [], displayValues = [], attributeId = 0) {
  const displayById = new Map();
  for (const item of normalizeArray(displayValues)) {
    const id = Number(item?.id || item?.dictionary_value_id || item?.value_id || 0);
    if (id) displayById.set(id, item);
  }
  const merged = [];
  const seen = new Set();
  for (const item of normalizeArray(baseValues)) {
    const id = Number(item?.id || item?.dictionary_value_id || item?.value_id || 0);
    const display = id ? displayById.get(id) : null;
    const value = String(item?.value || item?.name || item?.title || "").trim();
    const displayValue = String(display?.value || display?.name || display?.title || display?.display_value_zh || "").trim();
    merged.push({
      ...item,
      id: id || item?.id,
      dictionary_value_id: id || item?.dictionary_value_id,
      value,
      display_value_zh: hasChineseText(displayValue) ? displayValue : inferOzonAttributeDisplayValueZh(attributeId, value, display || item),
      raw_default: item,
      raw_zh: display || null
    });
    if (id) seen.add(id);
  }
  for (const item of normalizeArray(displayValues)) {
    const id = Number(item?.id || item?.dictionary_value_id || item?.value_id || 0);
    if (id && seen.has(id)) continue;
    const value = String(item?.value || item?.name || item?.title || "").trim();
    merged.push({
      ...item,
      id: id || item?.id,
      dictionary_value_id: id || item?.dictionary_value_id,
      value,
      display_value_zh: hasChineseText(value) ? value : inferOzonAttributeDisplayValueZh(attributeId, value, item),
      raw_default: null,
      raw_zh: item
    });
  }
  return merged;
}

function hasChineseText(value = "") {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function aiVariantSaveTraceId(payload = {}) {
  const sourceRaw = objectValue(payload.source_raw || payload.sourceRaw);
  const editable = objectValue(payload.editable_payload || payload.editablePayload);
  const facts = objectValue(payload.manual_facts || payload.manualFacts);
  const ai = objectValue(
    sourceRaw.ai_optimization
    || sourceRaw.aiOptimization
    || editable.ai_optimization
    || editable.aiOptimization
    || facts.ai_optimization
    || facts.aiOptimization
  );
  return String(
    payload.save_trace_id
    || payload.saveTraceId
    || sourceRaw.save_trace_id
    || sourceRaw.saveTraceId
    || editable.save_trace_id
    || editable.saveTraceId
    || facts.save_trace_id
    || facts.saveTraceId
    || ai.save_trace_id
    || ai.saveTraceId
    || ""
  ).trim().slice(0, 128);
}

function logAiVariantSavePerf(traceId = "", stage = "", startedAt = Date.now(), extra = {}) {
  if (!traceId) return;
  console.info("[ai-variant-save-perf]", JSON.stringify({
    traceId,
    stage,
    elapsedMs: Date.now() - startedAt,
    ...extra
  }));
}

export async function registerListingMediaAssetFromFile(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const sourcePath = path.resolve(String(body.filePath || body.file_path || ""));
  const buffer = await fs.readFile(sourcePath);
  const extension = path.extname(sourcePath).toLowerCase() || ".jpg";
  const contentType = body.mime_type || LISTING_MEDIA_TYPES.get(extension) || mimeTypeForListingMediaExtension(extension);
  const role = sanitizeListingMediaFilename(body.role || "asset").replace(/\.[^.]+$/, "").slice(0, 32) || "asset";
  const sourceName = sanitizeListingMediaFilename(body.original_name || path.basename(sourcePath));
  const storedName = `${Date.now()}-${crypto.randomUUID()}-${role}${extension}`;
  const targetPath = await writeListingMediaFile(storedName, buffer);
  const url = `/uploads/listing-media/${storedName}`;
  const configuredPublishUrl = buildListingMediaPublishUrl(url);
  const publishUrl = await ensureListingMediaPublicUrl({
    localPath: targetPath,
    localUrl: url,
    publishUrl: configuredPublishUrl,
    filename: sourceName,
    contentType,
    metadata: {
      source_module: body.source_module || body.sourceModule || "manual",
      source_id: body.source_id || body.sourceId || "",
      batch_id: body.batch_id || body.batchId || "",
      shop_id: body.shop_id ?? body.shopId ?? "",
      variant_id: body.variant_id ?? body.variantId ?? "",
      role
    },
    skipPublicSync: body.skipPublicSync || body.skip_public_sync
  });
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

async function listingWatermarkShop(shopId) {
  const shop = await row(`
    SELECT id, name, watermark_path, watermark_name,
      watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent
    FROM shops
    WHERE id = ? AND status <> 'deleted'
    LIMIT 1
  `, [Number(shopId)]);
  if (!shop) {
    const error = new Error("Shop not found");
    error.status = 404;
    throw error;
  }
  return shop;
}

async function resolveListingShopWatermarkPath(shop = {}) {
  const clean = String(shop.watermark_path || "").replace(/\\/g, "/");
  const filename = clean.startsWith("shop-watermarks/") ? path.basename(clean) : "";
  const candidates = filename
    ? SHOP_WATERMARK_ROOTS.map((root) => path.resolve(root, filename)).filter((target, index) => isListingPathInside(target, SHOP_WATERMARK_ROOTS[index]))
    : [];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  const error = new Error("璇ュ簵閾鸿繕娌℃湁閰嶇疆鍙敤姘村嵃");
  error.status = 400;
  throw error;
}

function listingShopWatermarkOptions(shop = {}) {
  return {
    position: String(shop.watermark_position || "bottom-right"),
    xPercent: clampNumberValue(Number(shop.watermark_x_percent ?? 75), 0, 100),
    yPercent: clampNumberValue(Number(shop.watermark_y_percent ?? 75), 0, 100),
    scalePercent: clampNumberValue(Number(shop.watermark_scale_percent ?? 22), 8, 45),
    opacityPercent: clampNumberValue(Number(shop.watermark_opacity_percent ?? 82), 10, 100)
  };
}

async function readListingImageBuffer(url = "") {
  const value = String(url || "").trim();
  if (!value) throw new Error("鍥剧墖 URL 涓虹┖");
  const localPath = resolveListingMediaLocalPath(value);
  if (localPath) return { buffer: await fs.readFile(localPath), source: localPath };
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`涓嬭浇鍥剧墖澶辫触锛?{response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error("涓嬭浇鍒扮殑鍥剧墖涓虹┖");
    if (buffer.length > 30 * 1024 * 1024) throw new Error("鍥剧墖瓒呰繃 30MB锛屾棤娉曟壒閲忓姞姘村嵃");
    return { buffer, source: value };
  }
  throw new Error("浠呮敮鎸?listing-media 鏈湴鍥剧墖鎴栧叕缃戝浘鐗?URL");
}

function resolveListingMediaLocalPath(url = "") {
  const raw = String(url || "").trim();
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname;
    } catch {
      return "";
    }
  }
  if (!pathname.startsWith("/uploads/listing-media/")) return "";
  const filename = path.basename(decodeURIComponent(pathname));
  if (!filename) return "";
  for (const root of LISTING_MEDIA_ROOTS) {
    const target = path.resolve(root, filename);
    if (isListingPathInside(target, root) && fsSync.existsSync(target)) return target;
  }
  const fallback = path.resolve(LISTING_MEDIA_ROOT, filename);
  return isListingPathInside(fallback, LISTING_MEDIA_ROOT) ? fallback : "";
}

function isAiOptimizationMediaPayload(payload = {}) {
  const sourceType = String(payload.source_type || payload.sourceType || "").toLowerCase();
  const sourceRaw = objectValue(payload.source_raw || payload.sourceRaw);
  const editable = objectValue(payload.editable_payload || payload.editablePayload);
  return sourceType.includes("ai_optimization")
    || Boolean(sourceRaw.ai_optimization || sourceRaw.aiOptimization)
    || Boolean(editable.ai_optimization || editable.aiOptimization);
}

function syncAiOptimizationTemplateImages(payload = {}) {
  const images = normalizeImages(payload.images || []);
  if (!images.length) return payload;
  const editable = objectValue(payload.editable_payload || payload.editablePayload);
  if (!Object.keys(editable).length) return payload;
  const syncedImages = images.map((image, index) => ({ ...image, sort_order: index + 1 }));
  const variants = normalizeArray(editable.variants).map((variant, index) => {
    if (index > 0) return variant;
    return {
      ...variant,
      images: syncedImages.map((image) => ({ ...image }))
    };
  });
  return {
    ...payload,
    editable_payload: {
      ...editable,
      images: syncedImages.map((image) => ({ ...image })),
      variants
    }
  };
}

async function materializeAiOptimizationTemplateMedia(payload = {}, session = null) {
  if (!isAiOptimizationMediaPayload(payload)) return payload;
  const traceId = aiVariantSaveTraceId(payload);
  const totalStarted = Date.now();
  logAiVariantSavePerf(traceId, "backend.template.media.start", totalStarted);
  const urlMap = new Map();
  const sourceRaw = objectValue(payload.source_raw || payload.sourceRaw);
  const editable = objectValue(payload.editable_payload || payload.editablePayload);
  const ai = objectValue(sourceRaw.ai_optimization || sourceRaw.aiOptimization || editable.ai_optimization || editable.aiOptimization);
  const metadata = {
    source_module: "ai_optimization_v2",
    source_id: String(ai.result_id || payload.source_ozon_sku || payload.template_name || ""),
    batch_id: String(ai.source_batch_id || sourceRaw.source_batch_id || editable.source_batch_id || ""),
    save_trace_id: traceId,
    role: "image"
  };
  const nextEditable = { ...editable };
  let stageStarted = Date.now();
  const nextPayload = {
    ...payload,
    source_raw: rewriteMediaUrlsWithMap(sourceRaw, urlMap),
    images: await materializeListingMediaItems(payload.images || nextEditable.images || [], { ...metadata, role: "template_image" }, session, urlMap)
  };
  logAiVariantSavePerf(traceId, "backend.template.media.template_images", stageStarted, {
    count: normalizeImages(payload.images || nextEditable.images || []).length
  });
  stageStarted = Date.now();
  nextEditable.images = await materializeListingMediaItems(nextEditable.images || nextPayload.images || [], { ...metadata, role: "editable_image" }, session, urlMap);
  logAiVariantSavePerf(traceId, "backend.template.media.editable_images", stageStarted, {
    count: normalizeImages(nextEditable.images || nextPayload.images || []).length
  });
  stageStarted = Date.now();
  nextEditable.variants = await Promise.all(normalizeArray(nextEditable.variants).map(async (variant, index) => ({
    ...variant,
    images: await materializeListingMediaItems(variant.images || [], { ...metadata, role: `variant_${index + 1}_image` }, session, urlMap),
    video_urls: await materializeListingMediaUrlList(variant.video_urls || variant.videos || variant.video_url, { ...metadata, role: `variant_${index + 1}_video` }, session, urlMap),
    video_cover_urls: await materializeListingMediaUrlList(variant.video_cover_urls || variant.cover_video_urls || variant.video_cover, { ...metadata, role: `variant_${index + 1}_video_cover` }, session, urlMap)
  })));
  logAiVariantSavePerf(traceId, "backend.template.media.variants", stageStarted, {
    count: normalizeArray(editable.variants).length,
    cachedUrls: urlMap.size
  });
  nextEditable.rich_content_json = rewriteMediaUrlsWithMap(nextEditable.rich_content_json, urlMap);
  nextEditable.rich_content = rewriteMediaUrlsWithMap(nextEditable.rich_content, urlMap);
  nextEditable.source_raw = rewriteMediaUrlsWithMap(nextEditable.source_raw, urlMap);
  const result = syncAiOptimizationTemplateImages({
    ...nextPayload,
    source_raw: rewriteMediaUrlsWithMap(nextPayload.source_raw, urlMap),
    editable_payload: nextEditable,
    description: rewriteMediaUrlsWithMap(nextPayload.description, urlMap),
    images: nextPayload.images
  });
  logAiVariantSavePerf(traceId, "backend.template.media.done", totalStarted, { cachedUrls: urlMap.size });
  return result;
}

async function materializeAiOptimizationDraftMedia(payload = {}, session = null) {
  const facts = objectValue(payload.manual_facts || payload.manualFacts);
  const ai = objectValue(facts.ai_optimization || facts.aiOptimization || facts);
  const shouldMaterialize = String(payload.ai_payload?.source || payload.aiPayload?.source || "").includes("ai_optimization")
    || Boolean(facts.ai_optimization_result_id || ai.result_id || ai.source_batch_id);
  if (!shouldMaterialize) return payload;
  const traceId = aiVariantSaveTraceId(payload);
  const totalStarted = Date.now();
  logAiVariantSavePerf(traceId, "backend.draft.media.start", totalStarted, {
    sourceImageCount: normalizeStringList(payload.source_images).length
  });
  const urlMap = new Map();
  const sourceImages = await materializeListingMediaUrlList(payload.source_images, {
    source_module: "ai_optimization_v2",
    source_id: String(facts.ai_optimization_result_id || ai.result_id || ""),
    batch_id: String(facts.source_batch_id || ai.source_batch_id || ""),
    save_trace_id: traceId,
    role: "draft_source_image"
  }, session, urlMap);
  const result = {
    ...payload,
    source_images: sourceImages,
    manual_facts: rewriteMediaUrlsWithMap(payload.manual_facts, urlMap),
    ai_payload: rewriteMediaUrlsWithMap(payload.ai_payload, urlMap)
  };
  logAiVariantSavePerf(traceId, "backend.draft.media.done", totalStarted, {
    sourceImageCount: sourceImages.length,
    cachedUrls: urlMap.size
  });
  return result;
}

async function materializeListingMediaItems(images = [], metadata = {}, session = null, urlMap = new Map()) {
  return Promise.all(normalizeImages(images).map(async (image) => ({
    ...image,
    url: await materializeListingMediaUrl(image.url, metadata, session, urlMap)
  })));
}

async function materializeListingMediaUrlList(value = [], metadata = {}, session = null, urlMap = new Map()) {
  const urls = normalizeStringList(value);
  const next = [];
  for (const url of urls) {
    const materialized = await materializeListingMediaUrl(url, metadata, session, urlMap);
    if (materialized) next.push(materialized);
  }
  return uniqueStringValues(next);
}

export async function materializeListingMediaAssetUrl(url = "", metadata = {}, session = null) {
  return materializeListingMediaUrlRecord(url, metadata, session, new Map());
}

async function materializeListingMediaUrl(url = "", metadata = {}, session = null, urlMap = new Map()) {
  const result = await materializeListingMediaUrlRecord(url, metadata, session, urlMap);
  return result.finalUrl;
}

async function materializeListingMediaUrlRecord(url = "", metadata = {}, session = null, urlMap = new Map()) {
  const traceId = String(metadata.save_trace_id || metadata.saveTraceId || "").trim();
  const startedAt = Date.now();
  const sourceUrl = String(url || "").trim();
  if (!sourceUrl) {
    logAiVariantSavePerf(traceId, "backend.media.url", startedAt, { role: metadata.role || "", status: "empty" });
    return { sourceUrl, localUrl: "", publishUrl: "", finalUrl: "", status: "empty", asset: null };
  }
  if (urlMap.has(sourceUrl)) {
    const finalUrl = urlMap.get(sourceUrl);
    logAiVariantSavePerf(traceId, "backend.media.url", startedAt, {
      role: metadata.role || "",
      status: "cached",
      source: sourceUrl.slice(0, 180),
      finalUrl: String(finalUrl || "").slice(0, 180)
    });
    return { sourceUrl, localUrl: listingMediaPathFromUrl(finalUrl), publishUrl: finalUrl, finalUrl, status: "cached", asset: null };
  }
  const alreadyPublishable = publishableListingMediaUrl(sourceUrl);
  if (listingMediaPathFromUrl(sourceUrl)) {
    urlMap.set(sourceUrl, alreadyPublishable);
    logAiVariantSavePerf(traceId, "backend.media.url", startedAt, {
      role: metadata.role || "",
      status: "already_listing_media",
      source: sourceUrl.slice(0, 180),
      finalUrl: String(alreadyPublishable || "").slice(0, 180)
    });
    return {
      sourceUrl,
      localUrl: listingMediaPathFromUrl(sourceUrl),
      publishUrl: alreadyPublishable === listingMediaPathFromUrl(sourceUrl) ? "" : alreadyPublishable,
      finalUrl: alreadyPublishable,
      status: "already_listing_media",
      asset: null
    };
  }
  try {
    const source = await readListingMediaBuffer(sourceUrl);
    const extension = listingMediaExtensionForSource(sourceUrl, source.contentType);
    const contentType = source.contentType || mimeTypeForListingMediaExtension(extension);
    const role = sanitizeListingMediaFilename(metadata.role || (contentType.startsWith("video/") ? "video" : "image")).replace(/\.[^.]+$/, "").slice(0, 32) || "asset";
    const originalName = sanitizeListingMediaFilename(path.basename(source.filename || sourceUrl.split("?")[0]) || `${role}${extension}`);
    const storedName = `${Date.now()}-${crypto.randomUUID()}-${role}${extension}`;
    const filePath = await writeListingMediaFile(storedName, source.buffer);
    const localUrl = `/uploads/listing-media/${storedName}`;
    const configuredPublishUrl = buildListingMediaPublishUrl(localUrl);
    const publishUrl = await ensureListingMediaPublicUrl({
      localPath: filePath,
      localUrl,
      publishUrl: configuredPublishUrl,
      filename: originalName,
      contentType,
      metadata: { ...metadata, role }
    });
    const asset = await registerListingMediaAsset({
      source_module: metadata.source_module || metadata.sourceModule || "ai_optimization_v2",
      source_id: metadata.source_id || metadata.sourceId || "",
      batch_id: metadata.batch_id || metadata.batchId || "",
      media_type: contentType.startsWith("video/") ? "video" : "image",
      role,
      local_path: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
      source_path: source.source || sourceUrl,
      preview_url: localUrl,
      publish_url: publishUrl || "",
      original_name: originalName,
      storage_name: storedName,
      mime_type: contentType,
      file_size: source.buffer.length,
      hash_sha256: crypto.createHash("sha256").update(source.buffer).digest("hex"),
      status: publishUrl ? "public_ready" : "local_only",
      metadata: {
        materializedFrom: sourceUrl,
        sourceModule: metadata.source_module || metadata.sourceModule || "ai_optimization_v2"
      }
    }, session);
    const finalUrl = publishUrl || localUrl;
    urlMap.set(sourceUrl, finalUrl);
    logAiVariantSavePerf(traceId, "backend.media.url", startedAt, {
      role: metadata.role || "",
      status: publishUrl ? "public_ready" : "local_only",
      source: sourceUrl.slice(0, 180),
      finalUrl: String(finalUrl || "").slice(0, 180),
      bytes: source.buffer.length
    });
    return {
      sourceUrl,
      localUrl,
      publishUrl: publishUrl || "",
      finalUrl,
      status: publishUrl ? "public_ready" : "local_only",
      asset
    };
  } catch (error) {
    console.warn("listing media materialize skipped:", error?.message || error);
    urlMap.set(sourceUrl, alreadyPublishable);
    logAiVariantSavePerf(traceId, "backend.media.url", startedAt, {
      role: metadata.role || "",
      status: "skipped",
      source: sourceUrl.slice(0, 180),
      error: error?.message || String(error)
    });
    return {
      sourceUrl,
      localUrl: listingMediaPathFromUrl(alreadyPublishable),
      publishUrl: listingMediaPathFromUrl(alreadyPublishable) ? "" : alreadyPublishable,
      finalUrl: alreadyPublishable,
      status: "skipped",
      error: error?.message || String(error),
      asset: null
    };
  }
}

async function readListingMediaBuffer(url = "") {
  const value = String(url || "").trim();
  if (!value) throw new Error("media URL is empty");
  const localPath = resolveListingMediaLocalPath(value);
  if (localPath) {
    const extension = path.extname(localPath).toLowerCase();
    return {
      buffer: await fs.readFile(localPath),
      source: localPath,
      filename: path.basename(localPath),
      contentType: mimeTypeForListingMediaExtension(extension)
    };
  }
  const aiTaskFile = await resolveLocalAiTaskMedia(value);
  if (aiTaskFile) {
    return {
      buffer: await fs.readFile(aiTaskFile.filePath),
      source: aiTaskFile.filePath,
      filename: path.basename(aiTaskFile.filePath),
      contentType: aiTaskFile.contentType
    };
  }
  if (!/^https?:\/\//i.test(value)) throw new Error("media URL must be local listing media or http(s)");
  const response = await fetch(value);
  if (!response.ok) throw new Error(`download media failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("downloaded media is empty");
  if (buffer.length > LISTING_MEDIA_MAX_BYTES) throw new Error("media exceeds listing upload size limit");
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim();
  return {
    buffer,
    source: value,
    filename: path.basename(new URL(value).pathname),
    contentType: contentType || mimeTypeForListingMediaExtension(path.extname(new URL(value).pathname))
  };
}

async function resolveLocalAiTaskMedia(url = "") {
  const value = String(url || "").trim();
  if (!value) return null;
  let pathname = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const isKnownAppHost = ["localhost", "127.0.0.1", "erp.hjt888.xyz"].includes(parsed.hostname);
      if (!isKnownAppHost) return null;
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  }
  const match = /^\/api\/ai\/file\/([^/]+)\/([^/]+)\/(.+)$/i.exec(pathname);
  if (!match) return null;
  return getAiTaskFile(
    decodeURIComponent(match[1]),
    decodeURIComponent(match[2]),
    match[3].split("/").map(decodeURIComponent).join("/")
  ).catch(() => null);
}

function listingMediaExtensionForSource(url = "", contentType = "") {
  const type = String(contentType || "").toLowerCase();
  for (const [extension, mime] of LISTING_MEDIA_TYPES.entries()) {
    if (mime === type) return extension;
  }
  try {
    const extension = path.extname(new URL(url, "http://local.invalid").pathname).toLowerCase();
    if (LISTING_MEDIA_TYPES.has(extension)) return extension;
  } catch {}
  return type.startsWith("video/") ? ".mp4" : ".jpg";
}

function rewriteMediaUrlsWithMap(value, urlMap = new Map()) {
  if (!urlMap.size || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => rewriteMediaUrlsWithMap(item, urlMap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteMediaUrlsWithMap(item, urlMap)]));
  }
  if (typeof value !== "string") return value;
  let next = value;
  for (const [before, after] of urlMap.entries()) {
    if (before && after) next = next.split(before).join(after);
  }
  return next;
}

async function applyListingWatermark(sourceBuffer, watermarkPath, options = {}) {
  const base = sharp(sourceBuffer).rotate();
  const meta = await base.metadata();
  const baseWidth = Number(meta.width || 0);
  const baseHeight = Number(meta.height || 0);
  if (!baseWidth || !baseHeight) throw new Error("鍥剧墖灏哄寮傚父锛屾棤娉曞姞姘村嵃");
  const watermarkWidth = Math.max(1, Math.round(baseWidth * (options.scalePercent || 22) / 100));
  const watermarkBuffer = await sharp(watermarkPath)
    .resize({ width: watermarkWidth, withoutEnlargement: true })
    .ensureAlpha()
    .png()
    .toBuffer();
  const wmMeta = await sharp(watermarkBuffer).metadata();
  const opacity = clampNumberValue(Number(options.opacityPercent || 82), 10, 100) / 100;
  const fadedWatermark = await sharp(watermarkBuffer)
    .composite([{
      input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: "dest-in"
    }])
    .png()
    .toBuffer();
  const rect = listingWatermarkRect(baseWidth, baseHeight, Number(wmMeta.width || watermarkWidth), Number(wmMeta.height || 0), options);
  return base.composite([{ input: fadedWatermark, left: rect.left, top: rect.top }]).png().toBuffer();
}

function listingWatermarkRect(baseWidth, baseHeight, wmWidth, wmHeight, options = {}) {
  const margin = Math.max(8, Math.round(Math.min(baseWidth, baseHeight) * 0.03));
  const position = String(options.position || "bottom-right");
  if (position === "custom") {
    return {
      left: clampNumberValue(Math.round(baseWidth * Number(options.xPercent || 75) / 100), 0, Math.max(0, baseWidth - wmWidth)),
      top: clampNumberValue(Math.round(baseHeight * Number(options.yPercent || 75) / 100), 0, Math.max(0, baseHeight - wmHeight))
    };
  }
  const positions = {
    "top-left": { left: margin, top: margin },
    "top-right": { left: baseWidth - wmWidth - margin, top: margin },
    "bottom-left": { left: margin, top: baseHeight - wmHeight - margin },
    "bottom-right": { left: baseWidth - wmWidth - margin, top: baseHeight - wmHeight - margin },
    center: { left: Math.round((baseWidth - wmWidth) / 2), top: Math.round((baseHeight - wmHeight) / 2) }
  };
  const rect = positions[position] || positions["bottom-right"];
  return {
    left: clampNumberValue(rect.left, 0, Math.max(0, baseWidth - wmWidth)),
    top: clampNumberValue(rect.top, 0, Math.max(0, baseHeight - wmHeight))
  };
}

function isListingPathInside(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function clampNumberValue(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
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
    description: String(template.description || editable.description || "").trim(),
    tags: splitTagValue(attributeValueByNames(attributes, ["tag", "hashtag", "鏍囩"], [23171]) || template.tags || editable.tags || ""),
    color: attributeValueByNames(attributes, ["color"], [10096]) || editable.color || template.color || "",
    material: attributeValueByNames(attributes, ["material"], [7199]) || editable.material || template.material || "",
    quantity: attributeValueByNames(attributes, ["quantity"], [7202]) || editable.quantity || template.quantity || "",
    vehicleBrand: attributeValueByNames(attributes, ["vehicle brand", "car brand"], [7204]) || editable.vehicle_brand || template.vehicle_brand || "",
    vehicleModel: attributeValueByNames(attributes, ["vehicle model", "car model"], [7212]) || editable.vehicle_model || template.vehicle_model || "",
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
  if (!facts.title) errors.push("Missing title");
  if (!facts.categoryId || facts.categoryId.startsWith("pending:") || facts.categoryId.startsWith("sku:")) errors.push("Missing real Ozon category");
  if (!facts.descriptionCategoryId || !facts.typeId) errors.push("Missing Ozon description_category_id/type_id");
  if (!numberFromOzonValue(facts.price.value || facts.price.price)) errors.push("Missing sale price");
  if (!numberFromOzonValue(facts.dimensions.weight_g)) errors.push("Missing package weight");
  if (!numberFromOzonValue(facts.dimensions.length_cm) || !numberFromOzonValue(facts.dimensions.width_cm) || !numberFromOzonValue(facts.dimensions.height_cm)) {
    errors.push("Missing package dimensions");
  }
  if (!images.length && !variants.some((item) => normalizeImages(item.images || []).length)) errors.push("Missing product images");
  const missingOfferIds = variants.filter((item) => !String(item.offer_id || item.offerId || item.sku || "").trim());
  if (!variants.length) errors.push("Missing variants / SKU");
  if (missingOfferIds.length) errors.push(`${missingOfferIds.length} variants have empty offer_id`);
  const missingRequired = attributes.filter((item) => item.required && !normalizeAttributeValue(item.value));
  for (const item of missingRequired.slice(0, 20)) errors.push(`缂哄皯蹇呭～灞炴€э細${item.name || item.attribute_id}`);
  const localMedia = [
    ...images.map((item) => item.url),
    ...variants.flatMap((item) => normalizeImages(item.images || []).map((image) => image.url)),
    ...variants.flatMap((item) => normalizeStringList(item.video_urls || item.videos || item.video_url)),
    ...variants.flatMap((item) => normalizeStringList(item.video_cover_urls || item.cover_video_urls || item.video_cover))
  ].filter(isLocalImportMedia);
  if (localMedia.length) warnings.push("瀛樺湪鏈湴绱犳潗 URL锛屾寮忔彁浜?Ozon 鍓嶉渶瑕佽浆鎹负鍏綉鍙闂湴鍧€鎴栦笂浼犲埌 Ozon 鏀寔鐨勭礌鏉愬湴鍧€");

  if (localMedia.length && isPreviewRuntimeWithRemoteListingMediaBase()) {
    errors.push("\u5f53\u524d 8788 \u9884\u89c8\u73af\u5883\u4e0a\u4f20\u7684\u56fe\u7247\u6216\u89c6\u9891\u8fd8\u6ca1\u6709\u540c\u6b65\u5230\u516c\u7f51\u7d20\u6750\u5730\u5740\uff0c\u76f4\u63a5\u63d0\u4ea4\u7ed9 Ozon \u4f1a\u5bfc\u81f4\u5b83\u6293\u53d6 404\u3002\u8bf7\u6539\u5728\u6b63\u5f0f\u73af\u5883\u4e0a\u4f20\u7d20\u6750\uff0c\u6216\u5148\u540c\u6b65\u5230\u516c\u7f51\u540e\u518d\u53d1\u5e03\u3002");
  }
  const unreachableRemoteMedia = await unreachablePublishMediaUrls([
    ...images.map((item) => publishableListingMediaUrl(item.url)),
    ...variants.flatMap((item) => normalizeImages(item.images || []).map((image) => publishableListingMediaUrl(image.url))),
    ...variants.flatMap((item) => normalizeStringList(item.video_urls || item.videos || item.video_url).map(publishableListingMediaUrl)),
    ...variants.flatMap((item) => normalizeStringList(item.video_cover_urls || item.cover_video_urls || item.video_cover).map(publishableListingMediaUrl))
  ]);
  if (unreachableRemoteMedia.length) {
    errors.push(`Public media is not reachable; Ozon may fail to download: ${unreachableRemoteMedia.slice(0, 3).join(", ")}`);
  }

  const payload = buildOzonImportPreviewPayload(facts, template);
  const qualityEstimate = estimateListingQualityFromPayload(payload);
  if (qualityEstimate.score < 90) {
    warnings.push(`Local content quality estimate ${qualityEstimate.score}/100; suggested fixes: ${qualityEstimate.issues.slice(0, 3).join("; ")}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    missing_required_attributes: missingRequired,
    payload,
    quality_estimate: qualityEstimate,
    payload_note: "This is an Ozon product/import preview generated from the current template. Validate shop, offer_id, public media URLs, and Ozon category attributes before submitting."
  };
}

export async function validateListingTemplatePublishForShop(body = {}, shopId = 0, session = null) {
  const validation = await validateListingTemplatePublish(body, session);
  const targetShopId = Number(shopId || 0);
  if (!targetShopId || !normalizeArray(validation.payload?.items).length) return validation;
  const shop = await row(
    "SELECT id, name, ozon_client_id, COALESCE(NULLIF(ozon_api_key, ''), api_key_hint) AS api_key_hint FROM shops WHERE id = ? AND status <> 'deleted'",
    [targetShopId]
  ).catch(() => null);
  if (!shop) return validation;
  const payload = await applyShopPublishDefaults(validation.payload, shop).catch(() => validation.payload);
  const resolvedAttributeIds = new Set(normalizeArray(payload.items)
    .flatMap((item) => normalizeArray(item.attributes))
    .filter((attr) => normalizeArray(attr.values).length)
    .map((attr) => Number(attr.id || attr.attribute_id || 0))
    .filter(Boolean));
  const remainingMissing = normalizeArray(validation.missing_required_attributes)
    .filter((attr) => !resolvedAttributeIds.has(Number(attr.id || attr.attribute_id || 0)));
  const resolvedMissingNames = new Set(normalizeArray(validation.missing_required_attributes)
    .filter((attr) => resolvedAttributeIds.has(Number(attr.id || attr.attribute_id || 0)))
    .map((attr) => String(attr.name || attr.name_zh || attr.attribute_id || attr.id || "").trim())
    .filter(Boolean));
  const errors = normalizeArray(validation.errors).filter((message) => {
    const text = String(message || "");
    if (!text.startsWith("缂哄皯蹇呭～灞炴€э細")) return true;
    return ![...resolvedMissingNames].some((name) => text === `缂哄皯蹇呭～灞炴€э細${name}`);
  });
  return {
    ...validation,
    ok: errors.length === 0,
    errors,
    payload,
    missing_required_attributes: remainingMissing,
    auto_required_dictionary_selected: remainingMissing.length < normalizeArray(validation.missing_required_attributes).length
  };
}

export async function prepareListingTemplatePublishMediaPreview(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const shopIds = [...new Set((body.shop_ids || body.shopIds || body.template?.shop_ids || []).map(Number).filter(Boolean))];
  if (!shopIds.length) throw new Error("Select at least one target shop");
  const shops = await all(
    `${LISTING_PUBLISH_SHOP_SELECT} WHERE id IN (${shopIds.map(() => "?").join(",")}) AND status <> 'deleted'`,
    shopIds
  );
  if (!shops.length) throw new Error("No available target shops");

  const validation = await validateListingTemplatePublishForShop(body.template || body, shops[0].id, session);
  if (!validation.ok) {
    const error = new Error(validation.errors[0] || "Pre-publish validation failed");
    error.status = 400;
    error.validation = validation;
    throw error;
  }

  const sourceRecordId = Number(
    body.source_record_id
    || body.record_id
    || body.recordId
    || body.template?.source_raw?.record_id
    || body.template?.editable_payload?.source_raw?.record_id
    || 0
  );
  const updateExisting = Boolean(sourceRecordId && shops.length === 1);
  const sourceProductId = await resolveListingSourceProductId(body.template || body, validation.payload);
  const textVariantPolicy = normalizeShopTextVariantPolicy(body.text_variant_policy || body.textVariantPolicy || {}, shops);
  const results = [];

  for (const shop of shops) {
    const textVariantPayload = await applyShopTextVariantToPayload(validation.payload, shop, textVariantPolicy);
    const defaultedPayload = await applyShopPublishDefaults(textVariantPayload, shop);
    const watermarkedPayload = shouldReusePreparedShopWatermarkMedia(body, shop)
      ? { ...defaultedPayload, watermark_summary: preparedShopWatermarkSummary(defaultedPayload, shop) }
      : await applyShopWatermarkedImagesToPayload(defaultedPayload, shop, session);
    const tailImageUrl = await resolveShopTailImageUrl(shop, session);
    const tailApplied = appendTailImageToPayload(watermarkedPayload, tailImageUrl);
    const shopPayload = await prepareSafeShopOfferIds(tailApplied.payload, {
      shop,
      sourceRecordId,
      updateExisting,
      sourceProductId
    });
    results.push({
      shop_id: shop.id,
      shop_name: shop.name,
      ok: true,
      payload: shopPayload,
      text_variant_summary: textVariantPayload.text_variant_summary || null,
      watermark_summary: watermarkedPayload.watermark_summary || null,
      tail_summary: {
        configured: Boolean(tailImageUrl),
        tail_image_url: tailImageUrl || "",
        appended: Number(tailApplied.appended || 0)
      }
    });
  }

  return {
    ok: true,
    dry_run: true,
    validation,
    results
  };
}

export async function publishListingTemplateToOzon(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const shopIds = [...new Set((body.shop_ids || body.shopIds || body.template?.shop_ids || []).map(Number).filter(Boolean))];
  if (!shopIds.length) throw new Error("Please select at least one shop");

  const shops = await all(
    `${LISTING_PUBLISH_SHOP_SELECT} WHERE id IN (${shopIds.map(() => "?").join(",")}) AND status <> 'deleted'`,
    shopIds
  );
  if (!shops.length) throw new Error("No available target shops");

  const validation = await validateListingTemplatePublishForShop(body.template || body, shops[0].id, session);
  const sourceRecordId = Number(
    body.source_record_id
    || body.record_id
    || body.recordId
    || body.template?.source_raw?.record_id
    || body.template?.editable_payload?.source_raw?.record_id
    || 0
  );
  const localMedia = collectLocalImportMedia(validation.payload);
  if (localMedia.length) {
    validation.errors.push("Before submitting to Ozon, convert images and videos to public URLs. Local /uploads URLs cannot be fetched by Ozon.");
    validation.ok = false;
  }
  if (!validation.ok) {
    const error = new Error(validation.errors[0] || "鍙戝竷鍓嶆牎楠屾湭閫氳繃");
    error.status = 400;
    error.validation = validation;
    throw error;
  }

  const missingTailShops = [];
  for (const shop of shops) {
    const tailImageUrl = await resolveShopTailImageUrl(shop, session);
    if (!tailImageUrl) missingTailShops.push(shop.name || `搴楅摵${shop.id}`);
  }
  if (missingTailShops.length) {
    validation.warnings.push(`The following shops have no tail image configured, publishing will skip tail image append: ${missingTailShops.join(", ")}`);
  }

  const results = [];
  const updateExisting = Boolean(sourceRecordId && shops.length === 1);
  const sourceProductId = await resolveListingSourceProductId(body.template || body, validation.payload);
  const textVariantPolicy = normalizeShopTextVariantPolicy(body.text_variant_policy || body.textVariantPolicy || {}, shops);
  for (const shop of shops) {
    let recordId = null;
    try {
      const textVariantPayload = await applyShopTextVariantToPayload(validation.payload, shop, textVariantPolicy);
      const defaultedPayload = await applyShopPublishDefaults(textVariantPayload, shop);
      const watermarkedPayload = shouldReusePreparedShopWatermarkMedia(body, shop)
        ? { ...defaultedPayload, watermark_summary: preparedShopWatermarkSummary(defaultedPayload, shop) }
        : await applyShopWatermarkedImagesToPayload(defaultedPayload, shop, session);
      const tailImageUrl = await resolveShopTailImageUrl(shop, session);
      const tailApplied = appendTailImageToPayload(watermarkedPayload, tailImageUrl);
      const shopPayload = await prepareSafeShopOfferIds(tailApplied.payload, {
        shop,
        sourceRecordId,
        updateExisting,
        sourceProductId
      });
      recordId = await preparePublishRecordForSubmit({
        sourceRecordId,
        shop,
        shopPayload,
        session,
        updateExisting,
        sourceProductId,
        offerSource: updateExisting ? "record_preserved" : "new_listing_safe",
        templateSnapshot: body.template || body
      });
      const response = await importOzonProducts(shop, shopPayload);
      const taskId = response?.result?.task_id || response?.task_id || response?.result?.taskId || "";
      let importInfo = null;
      if (taskId) {
        importInfo = await fetchOzonProductImportInfo(shop, taskId).catch((error) => ({ error: error.message }));
      }
      await updatePublishRecordAfterSubmit(recordId, {
        taskId,
        response,
        importInfo,
        status: importInfoStatus(importInfo)
      });
      const quality = await refreshPublishRecordQuality(recordId).catch((error) => ({
        score: 0,
        source: "refresh_failed",
        issues: [error.message]
      }));
      results.push({
        record_id: recordId,
        shop_id: shop.id,
        shop_name: shop.name,
        ok: true,
        task_id: taskId,
        text_variant_summary: textVariantPayload.text_variant_summary || null,
        watermark_summary: watermarkedPayload.watermark_summary || null,
        tail_summary: {
          configured: Boolean(tailImageUrl),
          appended: Number(tailApplied.appended || 0)
        },
        response,
        import_info: importInfo,
        quality
      });
    } catch (error) {
      const errorPayload = buildOzonPublishErrorPayload(error, { shop, recordId });
      if (recordId) {
        await run(`
          UPDATE listing_publish_records
          SET status = 'failed', error_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [JSON.stringify(errorPayload), recordId]).catch(() => null);
      }
      results.push({
        record_id: recordId,
        shop_id: shop.id,
        shop_name: shop.name,
        ok: false,
        watermark_summary: null,
        tail_summary: null,
        error: errorPayload.message,
        fix_tip: errorPayload.fix_tip,
        raw_error: errorPayload.raw_message
      });
    }
  }

  return {
    ok: results.some((item) => item.ok),
    validation,
    results
  };
}

export async function publishListingDraftsToOzon(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const draftIds = [...new Set(normalizeArray(body.draft_ids || body.draftIds || body.ids).map(Number).filter(Boolean))];
  const shopIds = [...new Set(normalizeArray(body.shop_ids || body.shopIds).map(Number).filter(Boolean))];
  if (!draftIds.length) throw new Error("璇峰厛閫夋嫨瑕佷笂鏋剁殑鑽夌");
  if (!shopIds.length) throw new Error("Please select at least one shop");

  const results = [];
  for (const draftId of draftIds) {
    let draft = null;
    try {
      draft = await listingDraft(draftId, session);
      const template = await buildPublishTemplateFromListingDraft(draft, session);
      const result = await publishListingTemplateToOzon({
        template,
        shop_ids: shopIds,
        text_variant_policy: body.text_variant_policy || body.textVariantPolicy || {},
        source_draft_id: draftId
      }, session);
      for (const item of normalizeArray(result.results)) {
        results.push({
          ...item,
          draft_id: draftId,
          draft_name: draft.product_name || draft.internal_code || `鑽夌 ${draftId}`
        });
      }
    } catch (error) {
      results.push({
        draft_id: draftId,
        draft_name: draft?.product_name || draft?.internal_code || `鑽夌 ${draftId}`,
        shop_id: 0,
        shop_name: "",
        ok: false,
        error: error.message || "鑽夌鎵归噺鎻愪氦澶辫触"
      });
    }
  }

  const success = results.filter((item) => item.ok).length;
  const failed = results.length - success;
  return {
    ok: success > 0,
    summary: {
      drafts: draftIds.length,
      shops: shopIds.length,
      total: results.length,
      success,
      failed
    },
    results
  };
}

async function buildPublishTemplateFromListingDraft(draft = {}, session = null) {
  const template = draft.template_id
    ? await listingCategoryTemplateRaw(Number(draft.template_id), session)
    : null;
  if (!template) throw new Error(`鑽夌 ${draft.id || ""} 缂哄皯鍙敤绫荤洰妯℃澘`);

  const manualFacts = objectValue(draft.manual_facts || {});
  const editableFacts = normalizeEditablePayload({
    ...(template.editable_payload || {}),
    ...manualFacts
  });
  const attributes = normalizeAttributes(manualFacts.attributes || editableFacts.attributes || template.attributes || []);
  const draftImages = normalizeImages(draft.source_images || []).filter((item) => item.url);
  const images = normalizeImages(manualFacts.images || editableFacts.images || template.images || []);
  const finalImages = images.length ? images : draftImages;
  const title = String(draft.product_name || manualFacts.title || editableFacts.title || template.title || template.template_name || "").trim();
  const description = String(manualFacts.description || editableFacts.description || template.description || "").trim();
  const variants = normalizeArray(editableFacts.variants || template.editable_payload?.variants).map((item, index) => ({
    ...item,
    title: item.title || item.name || title,
    name: item.name || item.title || title,
    images: normalizeImages(item.images || finalImages),
    ...(Number(draft.sale_price || 0) > 0 ? { price: Number(draft.sale_price || 0), price_value: Number(draft.sale_price || 0) } : {}),
    ...(index === 0 && draft.internal_code ? { sku: item.sku || draft.internal_code, offer_id: item.offer_id || draft.internal_code } : {})
  }));

  return normalizeTemplatePayload({
    ...template,
    template_name: title || template.template_name,
    title,
    description,
    attributes,
    images: finalImages,
    editable_payload: {
      ...(template.editable_payload || {}),
      ...editableFacts,
      title,
      description,
      attributes,
      images: finalImages,
      variants,
      source_raw: {
        ...(template.source_raw || {}),
        ...(editableFacts.source_raw || {}),
        source_type: "listing_draft_batch_publish",
        listing_draft_id: draft.id
      }
    }
  });
}

async function preparePublishRecordForSubmit({ sourceRecordId = 0, shop, shopPayload, session, updateExisting = false, sourceProductId = 0, offerSource = "", templateSnapshot = null }) {
  const requestJson = JSON.stringify(shopPayload);
  const standardizedSnapshot = templateSnapshot
    ? await standardizeListingTemplatePayload(normalizeTemplatePayload(templateSnapshot), listingTemplateStandardizerOptions({
      sourceType: "listing_publish_record",
      sourceId: String(sourceRecordId || firstOfferId(shopPayload) || ""),
      shopId: shop?.id,
      autoSync: false,
      syncValues: false,
      diagnostics: false
    }))
    : null;
  const templateSnapshotJson = standardizedSnapshot ? JSON.stringify(standardizedSnapshot) : null;
  const offerId = firstOfferId(shopPayload);
  if (sourceRecordId && updateExisting) {
    const current = await row("SELECT id, shop_id FROM listing_publish_records WHERE id = ? AND status <> 'deleted'", [sourceRecordId]);
    if (!current) throw new Error("Listing publish record to update not found");
    if (Number(current.shop_id) !== Number(shop.id)) throw new Error("Listing publish record shop does not match current shop");
    await run(`
      UPDATE listing_publish_records
      SET shop_id = ?, offer_id = ?, status = 'submitted', request_json = ?,
          response_json = NULL, error_json = NULL, task_id = '', source_product_id = COALESCE(NULLIF(?, 0), source_product_id),
          template_snapshot_json = COALESCE(?, template_snapshot_json),
          offer_source = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [shop.id, offerId, requestJson, Number(sourceProductId || 0), templateSnapshotJson, String(offerSource || "").slice(0, 64), sourceRecordId]);
    return sourceRecordId;
  }
  return insert(`
    INSERT INTO listing_publish_records
    (draft_id, shop_id, offer_id, status, request_json, template_snapshot_json, source_product_id, offer_source, created_by_person_id, updated_at)
    VALUES (0, ?, ?, 'submitted', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    shop.id,
    offerId,
    requestJson,
    templateSnapshotJson,
    Number(sourceProductId || 0) || null,
    String(offerSource || "").slice(0, 64),
    personId(session)
  ]);
}

async function backfillPublishRecordSnapshots(rows = []) {
  const pending = normalizeArray(rows).filter((item) => item?.id && !parseJson(item.template_snapshot_json, null));
  for (const item of pending) {
    const snapshot = await buildTemplateSnapshotFromPublishRecord(item, { diagnostics: false });
    if (!snapshot) continue;
    const snapshotJson = JSON.stringify(snapshot);
    await run(`
      UPDATE listing_publish_records
      SET template_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (template_snapshot_json IS NULL OR template_snapshot_json = '')
    `, [snapshotJson, Number(item.id)]).catch(() => null);
    item.template_snapshot_json = snapshotJson;
  }
  return rows;
}

export async function listingPublishRecords(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const paged = String(query.paged || "") === "1" || String(query.paged || "").toLowerCase() === "true";
  const includePayload = String(query.includePayload || query.include_payload || "").toLowerCase() === "1"
    || String(query.includePayload || query.include_payload || "").toLowerCase() === "true"
    || (!paged && query.includePayload === undefined && query.include_payload === undefined);
  const limit = Math.min(Math.max(Number(query.limit || 80), 1), 300);
  const page = Math.max(Number(query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const where = ["r.status <> 'deleted'"];
  const params = [];
  const nameQuery = cleanText(query.nameQuery || query.name || "", 120).toLowerCase();
  const shopQuery = cleanText(query.shopQuery || query.shop || "", 120).toLowerCase();
  const shopId = Number(query.shopId || query.shop_id || 0);
  const keyword = cleanText(query.query || query.keyword || "", 160).toLowerCase();
  const status = cleanText(query.status || "all", 40);
  const quality = cleanText(query.quality || "all", 40);
  const categoryJoinSql = keyword ? `
    LEFT JOIN ozon_category_mappings m
      ON m.description_category_id = CAST(NULLIF(SUBSTRING_INDEX(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].description_category_id')), ''), ':', 1), '') AS UNSIGNED)
     AND m.type_id = CAST(NULLIF(SUBSTRING_INDEX(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].type_id')), ''), ':', 1), '') AS UNSIGNED)
     AND m.status = 'active'
  ` : "";
  const categoryNameSelect = keyword
    ? "COALESCE(NULLIF(m.path_zh, ''), NULLIF(m.name_zh, ''), NULLIF(m.path_ru, ''), NULLIF(m.name_ru, ''))"
    : "''";

  if (status === "success") where.push("r.status IN ('imported', 'published', 'success')");
  else if (status === "processing") where.push("r.status IN ('submitted', 'processing', 'resubmitting', 'ozon_status_pending')");
  else if (status === "failed") where.push("r.status IN ('failed', 'ozon_status_error')");
  else if (status && status !== "all") {
    where.push("r.status = ?");
    params.push(status);
  }
  if (quality === "lt85") where.push("COALESCE(r.quality_score, 0) < 85");
  else if (quality === "gte85") where.push("COALESCE(r.quality_score, 0) >= 85");
  else if (quality === "gte90") where.push("COALESCE(r.quality_score, 0) >= 90");
  if (nameQuery) {
    where.push("LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].name')), r.offer_id, '')) LIKE ?");
    params.push(`%${nameQuery}%`);
  }
  if (shopQuery) {
    where.push("LOWER(COALESCE(s.name, '')) LIKE ?");
    params.push(`%${shopQuery}%`);
  }
  if (Number.isFinite(shopId) && shopId > 0) {
    where.push("r.shop_id = ?");
    params.push(shopId);
  }
  if (keyword) {
    where.push(`(
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].name')), '')) LIKE ? OR
      LOWER(COALESCE(r.offer_id, '')) LIKE ? OR
      LOWER(COALESCE(s.name, '')) LIKE ? OR
      LOWER(COALESCE(r.ozon_product_id, '')) LIKE ? OR
      LOWER(COALESCE(r.task_id, '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].description_category_id')), '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].type_id')), '')) LIKE ? OR
      LOWER(COALESCE(m.path_zh, m.name_zh, m.path_ru, m.name_ru, '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].price')), '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].currency_code')), '')) LIKE ?
    )`);
    params.push(...Array(10).fill(`%${keyword}%`));
  }

  const fromSql = `
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    ${categoryJoinSql}
    WHERE ${where.join(" AND ")}
  `;
  const fullRecordSelectSql = `
      SELECT r.*, s.name AS shop_name,
        '' AS online_primary_image,
        ${categoryNameSelect} AS category_name
  `;
  const listRecordSelectSql = `
      SELECT
        r.id, r.draft_id, r.shop_copy_id, r.shop_id, r.offer_id, r.ozon_product_id, r.ozon_sku,
        r.product_url, r.status, r.task_id, r.quality_score, r.quality_source, r.quality_json,
        r.quality_checked_at, r.error_json, r.source_product_id, r.offer_source, r.created_by_person_id,
        r.published_at, r.created_at, r.updated_at,
        s.name AS shop_name,
        '' AS online_primary_image,
        ${categoryNameSelect} AS category_name,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].name')) AS item_name,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].primary_image')) AS item_primary_image,
        JSON_LENGTH(JSON_EXTRACT(r.request_json, '$.items[0].images')) AS item_image_count,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].price')) AS item_price,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].old_price')) AS item_old_price,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].currency_code')) AS item_currency_code,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].weight')) AS item_weight,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].depth')) AS item_depth,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].width')) AS item_width,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].height')) AS item_height,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].description_category_id')) AS item_description_category_id,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].type_id')) AS item_type_id
  `;
  if (paged) {
    const countRow = await row(`SELECT COUNT(*) AS total ${fromSql}`, params);
    const total = Number(countRow?.total || 0);
    const rows = await all(`
      ${includePayload ? fullRecordSelectSql : listRecordSelectSql}
      ${fromSql}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]);
    if (includePayload) await backfillPublishRecordSnapshots(rows);
    return {
      rows: rows.map((item) => normalizePublishRecordRow(item, { includePayload })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      mode: "paged"
    };
  }
  const rows = await all(`
    ${includePayload ? fullRecordSelectSql : listRecordSelectSql}
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    ${categoryJoinSql}
    WHERE r.status <> 'deleted'
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ?
  `, [limit]);
  if (includePayload) await backfillPublishRecordSnapshots(rows);
  return rows.map((item) => normalizePublishRecordRow(item, { includePayload }));
}

export async function listingDraftProjects(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const status = cleanText(query.status || "all", 40);
  const view = cleanText(query.view || query.mode || "", 40).toLowerCase();
  const draftOnly = ["draft", "drafts"].includes(view);
  const publishOnly = ["publish", "records", "publish_records"].includes(view);
  const includePublishRecords = publishOnly || (!draftOnly && !["editing", "waiting"].includes(status));
  const includeDrafts = draftOnly || (!publishOnly && ["all", "editing", "waiting"].includes(status));
  const page = Math.max(Number(query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const candidateLimit = Math.min(page * pageSize, 500);
  const [recordsResult, drafts] = await Promise.all([
    includePublishRecords
      ? listingPublishProjectCandidates(query, candidateLimit)
      : Promise.resolve({ rows: [], total: 0, page, pageSize }),
    includeDrafts ? listingDraftProjectCandidates(query, candidateLimit) : Promise.resolve({ rows: [], total: 0 })
  ]);
  const draftRows = normalizeArray(drafts.rows).map(normalizeDraftProjectRow);
  const recordRows = normalizeArray(recordsResult.rows).map(normalizePublishProjectRow);
  const rows = [...draftRows, ...recordRows].sort((left, right) =>
    timestampMs(right.updated_at || right.created_at) - timestampMs(left.updated_at || left.created_at)
  ).slice((page - 1) * pageSize, page * pageSize);
  return {
    rows,
    total: Number(recordsResult.total || recordRows.length) + Number(drafts.total || draftRows.length),
    page,
    pageSize,
    mode: "draft_projects"
  };
}

async function listingPublishProjectCandidates(query = {}, limit = 100) {
  const where = ["r.status <> 'deleted'"];
  const params = [];
  const nameQuery = cleanText(query.nameQuery || query.name || "", 120).toLowerCase();
  const shopQuery = cleanText(query.shopQuery || query.shop || "", 120).toLowerCase();
  const keyword = cleanText(query.query || query.keyword || "", 160).toLowerCase();
  const status = cleanText(query.status || "all", 40);
  const quality = cleanText(query.quality || "all", 40);
  const shopId = Number(query.shopId || query.shop_id || 0);
  const safeLimit = Math.min(Math.max(Number(limit || 100), 1), 500);

  if (status === "success") where.push("r.status IN ('imported', 'published', 'success')");
  else if (status === "processing") where.push("r.status IN ('submitted', 'processing', 'resubmitting', 'ozon_status_pending')");
  else if (status === "failed") where.push("r.status IN ('failed', 'ozon_status_error')");
  else if (status && status !== "all") {
    where.push("r.status = ?");
    params.push(status);
  }
  if (quality === "lt85") where.push("COALESCE(r.quality_score, 0) < 85");
  else if (quality === "gte85") where.push("COALESCE(r.quality_score, 0) >= 85");
  else if (quality === "gte90") where.push("COALESCE(r.quality_score, 0) >= 90");
  if (nameQuery) {
    where.push("LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].name')), r.offer_id, '')) LIKE ?");
    params.push(`%${nameQuery}%`);
  }
  if (shopQuery) {
    where.push("LOWER(COALESCE(s.name, '')) LIKE ?");
    params.push(`%${shopQuery}%`);
  }
  if (Number.isFinite(shopId) && shopId > 0) {
    where.push("r.shop_id = ?");
    params.push(shopId);
  }
  if (keyword) {
    where.push(`(
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].name')), '')) LIKE ? OR
      LOWER(COALESCE(r.offer_id, '')) LIKE ? OR
      LOWER(COALESCE(s.name, '')) LIKE ? OR
      LOWER(COALESCE(r.ozon_product_id, '')) LIKE ? OR
      LOWER(COALESCE(r.task_id, '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].description_category_id')), '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].type_id')), '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].price')), '')) LIKE ? OR
      LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].currency_code')), '')) LIKE ?
    )`);
    params.push(...Array(9).fill(`%${keyword}%`));
  }

  const fromSql = `
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE ${where.join(" AND ")}
  `;
  const [countRow, rows] = await Promise.all([
    row(`SELECT COUNT(*) AS total ${fromSql}`, params),
    all(`
      SELECT
        r.id, r.draft_id, r.shop_copy_id, r.shop_id, r.offer_id, r.ozon_product_id, r.ozon_sku,
        r.product_url, r.status, r.task_id, r.quality_score, r.quality_source, r.quality_json,
        r.quality_checked_at, r.error_json, r.source_product_id, r.offer_source, r.created_by_person_id,
        r.published_at, r.created_at, r.updated_at,
        s.name AS shop_name, '' AS online_primary_image, '' AS category_name,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].name')) AS item_name,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].primary_image')) AS item_primary_image,
        JSON_LENGTH(JSON_EXTRACT(r.request_json, '$.items[0].images')) AS item_image_count,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].price')) AS item_price,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].old_price')) AS item_old_price,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].currency_code')) AS item_currency_code,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].description_category_id')) AS item_description_category_id,
        JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].type_id')) AS item_type_id
      ${fromSql}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
    `, [...params, safeLimit])
  ]);
  return {
    rows: rows.map((item) => normalizePublishRecordRow(item, { includePayload: false })),
    total: Number(countRow?.total || 0)
  };
}

async function listingDraftProjectCandidates(query = {}, limit = 100) {
  const where = ["d.status <> 'deleted'"];
  const params = [];
  const countParams = [];
  const nameQuery = cleanText(query.nameQuery || query.name || "", 120).toLowerCase();
  const keyword = cleanText(query.query || query.keyword || "", 160).toLowerCase();
  const status = cleanText(query.status || "all", 40);
  const quality = cleanText(query.quality || "all", 40);
  const shopId = Number(query.shopId || query.shop_id || 0);
  const safeLimit = Math.min(Math.max(Number(limit || 100), 1), 500);

  if (quality !== "all") return { rows: [], total: 0 };
  if (status === "editing") where.push("COALESCE(sc.total_shop_copy_count, 0) = 0");
  else if (status === "waiting") where.push("COALESCE(sc.prepared_shop_copy_count, 0) > 0");
  else if (status && status !== "all") return { rows: [], total: 0 };
  else where.push("(COALESCE(sc.total_shop_copy_count, 0) = 0 OR COALESCE(sc.prepared_shop_copy_count, 0) > 0)");
  if (Number.isFinite(shopId) && shopId > 0) {
    where.push("EXISTS (SELECT 1 FROM listing_shop_copies c_shop WHERE c_shop.draft_id = d.id AND c_shop.shop_id = ? AND c_shop.status = 'prepared')");
    params.push(shopId);
    countParams.push(shopId);
  }
  if (nameQuery) {
    where.push("LOWER(COALESCE(d.product_name, d.internal_code, '')) LIKE ?");
    params.push(`%${nameQuery}%`);
    countParams.push(`%${nameQuery}%`);
  }
  if (keyword) {
    where.push(`(
      LOWER(COALESCE(d.product_name, '')) LIKE ? OR
      LOWER(COALESCE(d.internal_code, '')) LIKE ? OR
      LOWER(COALESCE(t.category_name, '')) LIKE ? OR
      LOWER(COALESCE(t.template_name, '')) LIKE ?
    )`);
    params.push(...Array(4).fill(`%${keyword}%`));
    countParams.push(...Array(4).fill(`%${keyword}%`));
  }

  const fromSql = `
    FROM listing_drafts d
    LEFT JOIN listing_category_templates t ON t.id = d.template_id
    LEFT JOIN people p ON p.id = d.created_by_person_id
    LEFT JOIN (
      SELECT draft_id,
        COUNT(*) AS total_shop_copy_count,
        SUM(CASE WHEN status = 'prepared' THEN 1 ELSE 0 END) AS prepared_shop_copy_count
      FROM listing_shop_copies
      GROUP BY draft_id
    ) sc ON sc.draft_id = d.id
    WHERE ${where.join(" AND ")}
  `;
  const [countRow, rows] = await Promise.all([
    row(`SELECT COUNT(*) AS total ${fromSql}`, countParams),
    all(`
      SELECT
        d.id, d.template_id, d.product_name, d.internal_code, d.source_images_json,
        d.sale_price, d.status, d.created_by_person_id, d.created_at, d.updated_at,
        t.category_name, t.template_name, t.ozon_category_id, p.name AS created_by_name,
        COALESCE(sc.prepared_shop_copy_count, 0) AS shop_copy_count,
        COALESCE(sc.total_shop_copy_count, 0) AS total_shop_copy_count,
        '[]' AS source_urls_json,
        '{}' AS manual_facts_json,
        '{}' AS ai_payload_json
      ${fromSql}
      ORDER BY d.updated_at DESC, d.id DESC
      LIMIT ?
    `, [...params, safeLimit])
  ]);
  return {
    rows: rows.map(normalizeDraftRow),
    total: Number(countRow?.total || 0)
  };
}

export async function listingPublishRecordDetail(id, session = null) {
  await ensureListingAutomationSchema();
  const record = await row(`
    SELECT r.*, s.name AS shop_name, s.ozon_client_id, COALESCE(NULLIF(s.ozon_api_key, ''), s.api_key_hint) AS api_key_hint,
      COALESCE(NULLIF(op.primary_image, ''), NULLIF(op.image_url, '')) AS online_primary_image,
      COALESCE(NULLIF(m.path_zh, ''), NULLIF(m.name_zh, ''), NULLIF(m.path_ru, ''), NULLIF(m.name_ru, '')) AS category_name
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    LEFT JOIN online_products op
      ON op.shop_id = r.shop_id
     AND (
       (r.offer_id IS NOT NULL AND r.offer_id <> '' AND CONVERT(op.offer_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(r.offer_id USING utf8mb4) COLLATE utf8mb4_unicode_ci)
       OR (r.ozon_product_id IS NOT NULL AND r.ozon_product_id <> '' AND CONVERT(op.ozon_product_id USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(r.ozon_product_id USING utf8mb4) COLLATE utf8mb4_unicode_ci)
       OR (r.ozon_sku IS NOT NULL AND r.ozon_sku <> '' AND CONVERT(op.ozon_sku USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(r.ozon_sku USING utf8mb4) COLLATE utf8mb4_unicode_ci)
     )
    LEFT JOIN ozon_category_mappings m
      ON m.description_category_id = CAST(NULLIF(SUBSTRING_INDEX(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].description_category_id')), ''), ':', 1), '') AS UNSIGNED)
     AND m.type_id = CAST(NULLIF(SUBSTRING_INDEX(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.request_json, '$.items[0].type_id')), ''), ':', 1), '') AS UNSIGNED)
     AND m.status = 'active'
    WHERE r.id = ? AND r.status <> 'deleted'
  `, [Number(id)]);
  if (!record) throw listingPublishRecordNotFoundError();
  const currentSnapshot = parseJson(record.template_snapshot_json, null);
  if (!currentSnapshot) {
    const fallbackSnapshot = await buildTemplateSnapshotFromPublishRecord(record);
    if (fallbackSnapshot) {
      const snapshotJson = JSON.stringify(fallbackSnapshot);
      await run(`
        UPDATE listing_publish_records
        SET template_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [snapshotJson, Number(id)]).catch(() => null);
      record.template_snapshot_json = snapshotJson;
    }
  } else if (!currentSnapshot?.source_raw?.listing_template_standardizer) {
    const standardizedSnapshot = await standardizeListingTemplatePayload(normalizeTemplatePayload(currentSnapshot), listingTemplateStandardizerOptions({
      sourceType: "listing_publish_record",
      sourceId: String(record.id || record.offer_id || ""),
      shopId: record.shop_id,
      autoSync: false,
      syncValues: false
    }));
    const snapshotJson = JSON.stringify(standardizedSnapshot);
    await run(`
      UPDATE listing_publish_records
      SET template_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [snapshotJson, Number(id)]).catch(() => null);
    record.template_snapshot_json = snapshotJson;
  }
  const enriched = await enrichPublishRecordRowFromOzon(record).catch((error) => ({
    ...record,
    ozon_detail_error: error.message
  }));
  return normalizePublishRecordRow(enriched, { includePayload: true });
}

export async function refreshListingPublishRecord(id, session = null) {
  await ensureListingAutomationSchema();
  const record = await row(`
    SELECT r.*, s.name AS shop_name, s.ozon_client_id, COALESCE(NULLIF(s.ozon_api_key, ''), s.api_key_hint) AS api_key_hint
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  if (!record) throw listingPublishRecordNotFoundError();
  if (!record.task_id) return normalizePublishRecordRow(record);
  const importInfo = await fetchOzonProductImportInfo(record, record.task_id);
  await updatePublishRecordAfterSubmit(Number(id), {
    taskId: record.task_id,
    response: parseJson(record.response_json, {}),
    importInfo,
    status: importInfoStatus(importInfo)
  });
  await refreshPublishRecordQuality(Number(id)).catch(() => null);
  const updated = await row(`
    SELECT r.*, s.name AS shop_name
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  return normalizePublishRecordRow(updated);
}

export async function autoSyncListingPublishRecords(options = {}) {
  await ensureListingAutomationSchema();
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 100);
  const minAgeMinutes = Math.min(Math.max(Number(options.minAgeMinutes || 5), 1), 120);
  const maxAgeDays = Math.min(Math.max(Number(options.maxAgeDays || 7), 1), 60);
  const rows = await all(`
    SELECT id, status, quality_source, quality_checked_at
    FROM listing_publish_records
    WHERE status <> 'deleted'
      AND task_id <> ''
      AND created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
      AND updated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      AND (
        status IN ('submitted', 'processing', 'resubmitting', 'ozon_status_pending', 'ozon_status_error')
        OR (
          status IN ('imported', 'published', 'success')
          AND (
            quality_checked_at IS NULL
            OR quality_checked_at <= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
            OR COALESCE(quality_source, '') NOT LIKE '%ozon_rating_by_sku%'
          )
        )
      )
    ORDER BY
      CASE WHEN status IN ('submitted', 'processing', 'resubmitting', 'ozon_status_pending', 'ozon_status_error') THEN 0 ELSE 1 END,
      updated_at ASC
    LIMIT ?
  `, [minAgeMinutes, maxAgeDays, limit]);
  const stats = { scanned: rows.length, refreshed: 0, quality_refreshed: 0, failed: 0, errors: [] };
  for (const item of rows) {
    try {
      const status = String(item.status || "");
      if (["submitted", "processing", "resubmitting", "ozon_status_pending", "ozon_status_error"].includes(status)) {
        await refreshListingPublishRecord(Number(item.id), null);
        stats.refreshed += 1;
      } else {
        await refreshPublishRecordQuality(Number(item.id));
        stats.quality_refreshed += 1;
      }
    } catch (error) {
      stats.failed += 1;
      stats.errors.push({ id: Number(item.id), message: String(error?.message || error).slice(0, 300) });
    }
  }
  return stats;
}

async function enrichPublishRecordRowFromOzon(record = {}) {
  const request = parseJson(record.request_json, {});
  const refs = extractImportedProductRefs(parseJson(record.response_json, {}), record);
  const productIds = refs.productIds.length
    ? refs.productIds
    : [Number(record.ozon_product_id || 0)].filter(Boolean);
  const offerIds = refs.offerIds.length
    ? refs.offerIds
    : [record.offer_id, firstOfferId(request)].map((item) => String(item || "").trim()).filter(Boolean);
  if (!productIds.length && !offerIds.length) return record;
  const details = await fetchOzonProductInfoAttributes(record, {
    productIds,
    offerIds,
    limit: 20
  });
  const detail = Array.isArray(details) ? details[0] : null;
  if (!detail) return record;
  const mergedRequest = mergePublishRequestWithOzonDetail(request, detail, record);
  return {
    ...record,
    request_json: JSON.stringify(mergedRequest),
    ozon_detail_json: JSON.stringify(detail)
  };
}

function mergePublishRequestWithOzonDetail(request = {}, detail = {}, record = {}) {
  const next = objectValue(request);
  const items = normalizeArray(next.items);
  const current = objectValue(items[0] || {});
  const parsed = parseOzonProductDetail(detail, {
    title: current.name || record.product_name || "",
    description: current.description || "",
    category_name: record.category_name || "",
    ozon_category_id: current.description_category_id && current.type_id ? `${current.description_category_id}:${current.type_id}` : "",
    source_ozon_sku: record.ozon_sku || ""
  });
  const source = unwrapOzonProductDetail(detail);
  const attrs = normalizeOzonAttributesForPublishFromDetail(parsed.editable_payload?.attributes || parsed.attributes || []);
  const images = parsed.images.map((image) => image.url).filter(Boolean);
  const primaryImage = images[0] || current.primary_image || "";
  const richJson = parsed.editable_payload?.rich_content_json || extractOzonRichContent(source, parsed.attributes || []).text || "";
  const description = parsed.description || current.description || attributeValueByNames(parsed.attributes || [], ["Description", "Аннотация", "Описание"], [4191]) || "";
  const mergedItem = {
    ...current,
    offer_id: String(source.offer_id || current.offer_id || record.offer_id || "").trim(),
    name: parsed.title || current.name || record.product_name || "",
    description,
    description_category_id: parsed.editable_payload?.description_category_id || current.description_category_id || "",
    type_id: parsed.editable_payload?.type_id || current.type_id || "",
    price: current.price || String(parsed.editable_payload?.price?.value || ""),
    old_price: current.old_price || String(parsed.editable_payload?.price?.old_price || ""),
    currency_code: current.currency_code || parsed.editable_payload?.price?.currency_code || record.currency_code || "RUB",
    vat: current.vat || parsed.editable_payload?.price?.vat || "0",
    primary_image: primaryImage,
    images: uniqueValues([...(images.slice(1)), ...normalizeStringList(current.images)]),
    weight: current.weight || parsed.editable_payload?.dimensions?.weight_g || "",
    depth: current.depth || parsed.editable_payload?.dimensions?.length_cm || "",
    width: current.width || parsed.editable_payload?.dimensions?.width_cm || "",
    height: current.height || parsed.editable_payload?.dimensions?.height_cm || "",
    attributes: mergeOzonPublishAttributes(current.attributes || [], attrs),
    complex_attributes: mergeRichContentIntoComplexAttributes(current.complex_attributes || [], richJson)
  };
  if (richJson) mergedItem.rich_content_json = richJson;
  next.items = [mergedItem, ...items.slice(1)];
  next.ozon_detail_synced_at = new Date().toISOString();
  return next;
}

function normalizeOzonAttributesForPublishFromDetail(attributes = []) {
  return normalizeArray(attributes)
    .map((attr) => {
      const id = Number(attr.attribute_id || attr.id || 0);
      const values = normalizeArray(attr.values?.length ? attr.values : attr.value)
        .map((value) => (typeof value === "object" && value !== null ? value : { value }))
        .map((value) => ({
          value: String(value.value ?? value.name ?? value.text ?? "").trim(),
          dictionary_value_id: value.dictionary_value_id ?? value.id ?? value.value_id ?? undefined
        }))
        .filter((value) => value.value);
      return {
        id,
        attribute_id: id,
        name: String(attr.name || attr.attribute_name || "").trim(),
        type: attr.type || "",
        values
      };
    })
    .filter((attr) => attr.id && attr.values.length);
}

function mergeOzonPublishAttributes(currentAttributes = [], ozonAttributes = []) {
  const byId = new Map();
  normalizeArray(currentAttributes).forEach((attr) => {
    const id = Number(attr.id || attr.attribute_id || 0);
    if (id) byId.set(id, { ...attr, id });
  });
  normalizeArray(ozonAttributes).forEach((attr) => {
    const id = Number(attr.id || attr.attribute_id || 0);
    const values = normalizeArray(attr.values).filter((value) => String(value?.value ?? value ?? "").trim());
    if (id && values.length) byId.set(id, {
      ...attr,
      id,
      attribute_id: id,
      values
    });
  });
  return [...byId.values()];
}

function mergeRichContentIntoComplexAttributes(complexAttributes = [], richJson = "") {
  const groups = normalizeArray(complexAttributes).map((group) => ({
    ...group,
    attributes: normalizeArray(group.attributes || group)
  }));
  const text = String(richJson || "").trim();
  if (!text) return groups;
  const existing = groups
    .flatMap((group) => group.attributes)
    .find((attr) => Number(attr.id || attr.attribute_id || 0) === 11254 || String(attr.id || "").toLowerCase() === "rich_content_json");
  if (existing) {
    existing.values = [{ value: text }];
    return groups;
  }
  groups.push({
    attributes: [{ id: "rich_content_json", values: [{ value: text }] }]
  });
  return groups;
}

async function buildTemplateSnapshotFromPublishRecord(record = {}, options = {}) {
  const request = parseJson(record.request_json, {});
  const firstItem = normalizeArray(request.items)[0] || {};
  if (!Object.keys(firstItem).length) return null;
  const rawAttributes = normalizeAttributes(firstItem.attributes || []);
  const richContent = extractOzonRichContent(firstItem, rawAttributes);
  const tags = splitTagValue(
    firstItem.tags
    || attributeValueByNames(rawAttributes, ["Product tags", "Main image tags", "Keywords", "Тег", "Ключевые слова"], [23171, 10096])
    || ""
  );
  const images = normalizeImages([firstItem.primary_image, ...normalizeStringList(firstItem.images)]);
  const attributes = enrichTemplateAttributes(rawAttributes, {
    title: firstItem.name || record.product_name || "",
    brand: attributeValueByNames(rawAttributes, ["Brand", "Бренд"], [85]) || "No brand",
    model: attributeValueByNames(rawAttributes, ["Model", "Модель"], [9048]) || "",
    tags,
    description: extractOzonDescriptionText(firstItem, rawAttributes, { description: firstItem.description || "" }),
    richJson: richContent.text
  });
  const dimensions = {
    length_cm: numberFromOzonValue(firstItem.depth || 0) / 10,
    width_cm: numberFromOzonValue(firstItem.width || 0) / 10,
    height_cm: numberFromOzonValue(firstItem.height || 0) / 10,
    weight_g: numberFromOzonValue(firstItem.weight || 0)
  };
  const variant = {
    sku: String(firstItem.offer_id || record.offer_id || "").trim(),
    offer_id: String(firstItem.offer_id || record.offer_id || "").trim(),
    name: String(firstItem.name || record.product_name || "").trim(),
    title: String(firstItem.name || record.product_name || "").trim(),
    images,
    video_urls: extractVideoUrlsFromItem(firstItem),
    video_cover_urls: extractVideoCoverUrlsFromItem(firstItem),
    price: numberFromOzonValue(firstItem.price || 0),
    old_price: numberFromOzonValue(firstItem.old_price || 0),
    color: String(firstItem.color || attributeValueByNames(rawAttributes, ["棰滆壊", "笑胁械褌"], [8229]) || "").trim(),
    material: String(firstItem.material || attributeValueByNames(rawAttributes, ["鏉愭枡", "鏉愯川", "material", "屑邪褌械褉懈邪谢"], [7199]) || "").trim(),
    quantity: String(firstItem.quantity || attributeValueByNames(rawAttributes, ["鏁伴噺", "quantity"], [7202]) || "").trim(),
    weight_g: dimensions.weight_g,
    length_mm: Math.round(dimensions.length_cm * 10),
    width_mm: Math.round(dimensions.width_cm * 10),
    height_mm: Math.round(dimensions.height_cm * 10),
    stock: numberFromOzonValue(firstItem.stock || 0),
    attributes: rawAttributes
  };
  const sourceRaw = {
    ...request,
    record_id: Number(record.id || 0),
    shop_id: Number(record.shop_id || 0),
    offer_id: String(firstItem.offer_id || record.offer_id || "").trim(),
    from_publish_record: true
  };
  const snapshot = normalizeTemplatePayload({
    ozon_category_id: firstItem.description_category_id && firstItem.type_id ? `${firstItem.description_category_id}:${firstItem.type_id}` : "",
    category_name: record.category_name || "",
    template_name: `涓婃灦璁板綍 ${record.id} / ${firstItem.offer_id || record.offer_id || ""}`,
    title: firstItem.name || record.product_name || "",
    description: extractOzonDescriptionText(firstItem, rawAttributes, { description: firstItem.description || "" }),
    attributes,
    images,
    source_raw: sourceRaw,
    editable_payload: {
      sku: String(firstItem.offer_id || record.offer_id || "").trim(),
      title: firstItem.name || record.product_name || "",
      description: extractOzonDescriptionText(firstItem, rawAttributes, { description: firstItem.description || "" }),
      description_category_id: firstItem.description_category_id || "",
      type_id: firstItem.type_id || "",
      legacy_category_id: firstItem.description_category_id && firstItem.type_id ? `${firstItem.description_category_id}:${firstItem.type_id}` : "",
      category_name: record.category_name || "",
      price: {
        value: numberFromOzonValue(firstItem.price || 0),
        old_price: numberFromOzonValue(firstItem.old_price || 0),
        currency_code: firstItem.currency_code || record.currency_code || "RUB",
        vat: String(firstItem.vat || "0")
      },
      dimensions,
      logistics: {
        brand: attributeValueByNames(rawAttributes, ["Brand", "Бренд"], [85]) || "No brand",
        color: variant.color,
        spec: attributeValueByNames(rawAttributes, ["鍨嬪彿", "袦芯写械谢褜"], [9048]) || variant.material || "",
        quantity: variant.quantity,
        tags
      },
      rich_content_json: richContent.text,
      attributes,
      images,
      variants: [variant],
      source_raw: sourceRaw
    }
  });
  return standardizeListingTemplatePayload(snapshot, listingTemplateStandardizerOptions({
    sourceType: "listing_publish_record",
    sourceId: String(record.id || firstItem.offer_id || record.offer_id || ""),
    shopId: record.shop_id,
    autoSync: false,
    syncValues: false,
    diagnostics: options.diagnostics !== false
  }));
}

export async function retryListingPublishRecord(id, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const record = await row(`
    SELECT r.*, s.name AS shop_name, s.ozon_client_id, COALESCE(NULLIF(s.ozon_api_key, ''), s.api_key_hint) AS api_key_hint
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  if (!record) throw listingPublishRecordNotFoundError();
  const expectedUpdatedAt = body?.updated_at || body?.updatedAt || body?.version_updated_at || body?.versionUpdatedAt || "";
  if (expectedUpdatedAt && !sameTimestamp(expectedUpdatedAt, record.updated_at)) {
    const error = new Error("Publish record was changed by another user; refresh and try again");
    error.status = 409;
    throw error;
  }
  if (["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(String(record.status || ""))) {
    const error = new Error("This publish record is being processed; refresh status before retrying");
    error.status = 409;
    throw error;
  }
  const payload = normalizeRetryPublishPayload(body.payload || body.request || parseJson(record.request_json, {}));
  if (!normalizeArray(payload.items).length) throw new Error("Publish record has no retryable Ozon payload");

  await run(`
    UPDATE listing_publish_records
    SET status = 'resubmitting', request_json = ?, error_json = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [JSON.stringify(payload), Number(id)]);

  try {
    const shopPayload = await applyShopPublishDefaults(payload, record);
    const templateSnapshot = await buildTemplateSnapshotFromPublishRecord({
      ...record,
      request_json: JSON.stringify(shopPayload)
    }, { diagnostics: false });
    await run(`
      UPDATE listing_publish_records
      SET request_json = ?, template_snapshot_json = COALESCE(?, template_snapshot_json), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [JSON.stringify(shopPayload), templateSnapshot ? JSON.stringify(templateSnapshot) : null, Number(id)]);
    const response = await importOzonProducts(record, shopPayload);
    const taskId = response?.result?.task_id || response?.task_id || response?.result?.taskId || "";
    let importInfo = null;
    if (taskId) {
      importInfo = await fetchOzonProductImportInfo(record, taskId).catch((error) => ({ error: error.message }));
    }
    await updatePublishRecordAfterSubmit(Number(id), {
      taskId,
      response,
      importInfo,
      status: importInfoStatus(importInfo)
    });
    await refreshPublishRecordQuality(Number(id)).catch(() => null);
  } catch (error) {
    const errorPayload = buildOzonPublishErrorPayload(error, { shop: record, recordId: id });
    await run(`
      UPDATE listing_publish_records
      SET status = 'failed', error_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [JSON.stringify(errorPayload), Number(id)]);
  }

  const updated = await row(`
    SELECT r.*, s.name AS shop_name
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  return normalizePublishRecordRow(updated);
}

export async function saveListingPublishRecordDraft(id, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const record = await row(`
    SELECT r.*, s.name AS shop_name
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ? AND r.status <> 'deleted'
  `, [Number(id)]);
  if (!record) throw listingPublishRecordNotFoundError();
  const expectedUpdatedAt = body?.updated_at || body?.updatedAt || body?.version_updated_at || body?.versionUpdatedAt || "";
  if (expectedUpdatedAt && !sameTimestamp(expectedUpdatedAt, record.updated_at)) {
    const error = new Error("Publish record was changed by another user; refresh and try again");
    error.status = 409;
    throw error;
  }
  if (["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(String(record.status || ""))) {
    const error = new Error("This publish record is being processed; refresh status before saving draft");
    error.status = 409;
    throw error;
  }

  const template = normalizeTemplatePayload(body.template || body);
  const sourceRaw = {
    ...(template.source_raw || template.editable_payload?.source_raw || {}),
    record_id: Number(id),
    shop_id: record.shop_id,
    offer_id: record.offer_id || template.editable_payload?.sku || "",
    from_publish_record: true
  };
  template.source_raw = sourceRaw;
  template.editable_payload = {
    ...(template.editable_payload || {}),
    source_raw: sourceRaw
  };
  const validation = await validateListingTemplatePublish(template, session);
  const requestPayload = validation.payload || parseJson(record.request_json, {});
  if (!normalizeArray(requestPayload.items).length) throw new Error("Publish record has no savable Ozon payload");
  const standardizedSnapshot = await standardizeListingTemplatePayload(template, listingTemplateStandardizerOptions({
    sourceType: "listing_publish_record",
    sourceId: String(id),
    shopId: record.shop_id,
    autoSync: false,
    syncValues: false,
    diagnostics: false
  }));
  const offerId = firstOfferId(requestPayload) || record.offer_id || "";
  await run(`
    UPDATE listing_publish_records
    SET offer_id = ?, request_json = ?, template_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [offerId, JSON.stringify(requestPayload), JSON.stringify(standardizedSnapshot), Number(id)]);

  const updated = await row(`
    SELECT r.*, s.name AS shop_name
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(id)]);
  return normalizePublishRecordRow(updated);
}

export async function deleteListingPublishRecord(id, session = null) {
  await ensureListingAutomationSchema();
  const record = await row("SELECT id FROM listing_publish_records WHERE id = ? AND status <> 'deleted'", [Number(id)]);
  if (!record) throw listingPublishRecordNotFoundError();
  await run(`
    UPDATE listing_publish_records
    SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [Number(id)]);
  return { ok: true, id: Number(id) };
}

export async function deleteListingPublishRecords(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const ids = [...new Set(normalizeArray(body?.ids || body?.recordIds || body?.record_ids)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) throw new Error("璇烽€夋嫨瑕佸垹闄ょ殑涓婃灦璁板綍");
  const placeholders = ids.map(() => "?").join(", ");
  const result = await run(`
    UPDATE listing_publish_records
    SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
    WHERE status <> 'deleted' AND id IN (${placeholders})
  `, ids);
  return { ok: true, ids, deleted: Number(result?.affectedRows || result?.changes || 0) };
}

export async function updateListingCategoryTemplate(id, body, session) {
  await ensureListingAutomationSchema();
  const current = await listingCategoryTemplate(id, session);
  const expectedUpdatedAt = body?.updated_at || body?.updatedAt || body?.version_updated_at || body?.versionUpdatedAt || "";
  if (expectedUpdatedAt && current && !sameTimestamp(expectedUpdatedAt, current.updated_at)) {
    const error = new Error("妯℃澘宸茶鍏朵粬鐢ㄦ埛淇濆瓨锛岃鍒锋柊鍚庡啀缁х画缂栬緫");
    error.status = 409;
    throw error;
  }
  if (!current) throw new Error("Listing category template not found");

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
  await recordOzonCategoryUsage({
    sourceModule: "listing_template",
    sourceId: String(id),
    ozonCategoryId: payload.ozon_category_id,
    categoryName: payload.category_name
  });

  return listingCategoryTemplate(id, session);
}

function sameTimestamp(left, right) {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) < 1000;
}

function timestampMs(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value).replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeListingAiVariantAssetPayload(body = {}, session = null) {
  return {
    source_module: cleanText(body.source_module || body.sourceModule || "ai_variant_workbench", 64),
    workbench_id: cleanText(body.workbench_id || body.workbenchId, 128),
    source_batch_id: cleanText(body.source_batch_id || body.sourceBatchId, 128),
    result_id: cleanText(body.result_id || body.resultId, 128),
    source_product_id: cleanText(body.source_product_id || body.sourceProductId || body.product_id || body.productId, 128),
    product_name: cleanText(body.product_name || body.productName || body.name, 255),
    variant_target: cleanText(body.variant_target || body.variantTarget, 255),
    listing_draft_id: nullablePositiveNumber(body.listing_draft_id || body.listingDraftId),
    listing_template_id: nullablePositiveNumber(body.listing_template_id || body.listingTemplateId || body.template_id || body.templateId),
    field_key: cleanText(body.field_key || body.fieldKey || body.field, 64),
    field_status: cleanText(body.field_status || body.fieldStatus || body.status || "generated", 32),
    asset: objectValue(body.asset || body.asset_json || body.value || {}),
    prompt_snapshot: objectValue(body.prompt_snapshot || body.promptSnapshot || body.generation_snapshot || body.generationSnapshot || {}),
    row_snapshot: objectValue(body.row_snapshot || body.rowSnapshot || {}),
    error_message: cleanText(body.error_message || body.errorMessage || "", 1000),
    created_by_person_id: personId(session)
  };
}

function nullablePositiveNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeListingAiVariantAssetRow(rowItem = {}) {
  const promptSnapshot = parseJson(rowItem.prompt_snapshot_json, {});
  const rowSnapshot = parseJson(rowItem.row_snapshot_json, {});
  return {
    id: Number(rowItem.id || 0),
    source_module: rowItem.source_module || "",
    sourceModule: rowItem.source_module || "",
    workbench_id: rowItem.workbench_id || "",
    workbenchId: rowItem.workbench_id || "",
    source_batch_id: rowItem.source_batch_id || "",
    sourceBatchId: rowItem.source_batch_id || "",
    result_id: rowItem.result_id || "",
    resultId: rowItem.result_id || "",
    source_product_id: rowItem.source_product_id || "",
    sourceProductId: rowItem.source_product_id || "",
    product_name: rowItem.product_name || "",
    productName: rowItem.product_name || "",
    variant_target: rowItem.variant_target || "",
    variantTarget: rowItem.variant_target || "",
    listing_draft_id: rowItem.listing_draft_id ? Number(rowItem.listing_draft_id) : null,
    listingDraftId: rowItem.listing_draft_id ? Number(rowItem.listing_draft_id) : null,
    listing_template_id: rowItem.listing_template_id ? Number(rowItem.listing_template_id) : null,
    listingTemplateId: rowItem.listing_template_id ? Number(rowItem.listing_template_id) : null,
    field_key: rowItem.field_key || "",
    fieldKey: rowItem.field_key || "",
    field_status: rowItem.field_status || "",
    fieldStatus: rowItem.field_status || "",
    asset: parseJson(rowItem.asset_json, {}),
    prompt_snapshot: promptSnapshot,
    promptSnapshot,
    row_snapshot: rowSnapshot,
    rowSnapshot,
    error_message: rowItem.error_message || "",
    errorMessage: rowItem.error_message || "",
    status: rowItem.status || "",
    created_at: rowItem.created_at,
    createdAt: rowItem.created_at,
    updated_at: rowItem.updated_at,
    updatedAt: rowItem.updated_at
  };
}

export async function listingDrafts(query = {}, session) {
  await ensureListingAutomationSchema();
  const paged = String(query.paged || "") === "1";
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(Math.max(1, Number(query.pageSize || query.page_size || 20)), 100);
  const offset = (page - 1) * pageSize;
  const keyword = String(query.query || query.keyword || query.name || "").trim().toLowerCase();
  const sku = String(query.sku || query.offer || query.offerId || "").trim().toLowerCase();
  const shopId = Number(query.shopId || query.shop_id || 0);
  const startDate = String(query.startDate || query.start_date || "").trim();
  const endDate = String(query.endDate || query.end_date || "").trim();
  const where = ["d.status <> 'deleted'"];
  const params = [];
  if (keyword) {
    where.push(`(
      LOWER(COALESCE(d.product_name, '')) LIKE ? OR
      LOWER(COALESCE(d.internal_code, '')) LIKE ? OR
      LOWER(COALESCE(t.category_name, '')) LIKE ? OR
      LOWER(COALESCE(t.template_name, '')) LIKE ?
    )`);
    params.push(...Array(4).fill(`%${keyword}%`));
  }
  if (sku) {
    where.push("LOWER(COALESCE(d.internal_code, '')) LIKE ?");
    params.push(`%${sku}%`);
  }
  if (Number.isFinite(shopId) && shopId > 0) {
    where.push("EXISTS (SELECT 1 FROM listing_shop_copies c_shop WHERE c_shop.draft_id = d.id AND c_shop.shop_id = ?)");
    params.push(shopId);
  }
  if (startDate) {
    where.push("DATE(d.updated_at) >= ?");
    params.push(startDate);
  }
  if (endDate) {
    where.push("DATE(d.updated_at) <= ?");
    params.push(endDate);
  }
  const fromSql = `
    FROM listing_drafts d
    LEFT JOIN listing_category_templates t ON t.id = d.template_id
    LEFT JOIN people p ON p.id = d.created_by_person_id
    WHERE ${where.join(" AND ")}
  `;
  const rowsSql = `
    SELECT
      d.id, d.template_id, d.product_name, d.internal_code, d.source_urls_json, d.source_images_json,
      d.cost_price, d.sale_price, d.length_cm, d.width_cm, d.height_cm, d.weight_g,
      d.color, d.spec, d.quantity, d.status, d.created_by_person_id, d.created_at, d.updated_at,
      '{}' AS manual_facts_json, '{}' AS ai_payload_json,
      t.category_name, t.template_name, t.ozon_category_id, p.name AS created_by_name,
      (SELECT COUNT(*) FROM listing_shop_copies c WHERE c.draft_id = d.id) AS shop_copy_count
    ${fromSql}
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT ? OFFSET ?
  `;
  const rows = await all(rowsSql, [...params, paged ? pageSize : 100, paged ? offset : 0]);
  if (!paged) return rows.map(normalizeDraftRow);
  const totalRow = await row(`SELECT COUNT(*) AS total ${fromSql}`, params);
  return {
    rows: rows.map(normalizeDraftRow),
    total: Number(totalRow?.total || 0),
    page,
    pageSize,
    mode: "paged"
  };
}

export async function listingDraftDetail(id, session) {
  await ensureListingAutomationSchema();
  return listingDraft(id, session);
}

export async function listingAiVariantAssets(query = {}, session = null) {
  await ensureListingAutomationSchema();
  const limit = Math.min(Math.max(Number(query.limit || 80), 1), 200);
  const where = ["status <> 'deleted'"];
  const params = [];
  const draftId = Number(query.draftId || query.draft_id || 0);
  const templateId = Number(query.templateId || query.template_id || 0);
  const resultId = cleanText(query.resultId || query.result_id || "", 128);
  const sourceBatchId = cleanText(query.sourceBatchId || query.source_batch_id || "", 128);
  const sourceProductId = cleanText(query.sourceProductId || query.source_product_id || "", 128);
  if (draftId) {
    where.push("listing_draft_id = ?");
    params.push(draftId);
  }
  if (templateId) {
    where.push("listing_template_id = ?");
    params.push(templateId);
  }
  if (resultId) {
    where.push("result_id = ?");
    params.push(resultId);
  }
  if (sourceBatchId) {
    where.push("source_batch_id = ?");
    params.push(sourceBatchId);
  }
  if (sourceProductId) {
    where.push("source_product_id = ?");
    params.push(sourceProductId);
  }
  const rows = await all(`
    SELECT *
    FROM listing_ai_variant_assets
    WHERE ${where.join(" AND ")}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `, [...params, limit]);
  return rows.map(normalizeListingAiVariantAssetRow);
}

export async function saveListingAiVariantAsset(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const resultId = cleanText(body.result_id || body.resultId, 128);
  const fieldKey = cleanText(body.field_key || body.fieldKey || body.field, 64);
  if (!resultId || !fieldKey) throw new Error("AI 瑁傚彉璧勪骇璁板綍缂哄皯 result_id 鎴?field_key");
  const payload = normalizeListingAiVariantAssetPayload(body, session);
  const existing = await row(
    "SELECT id FROM listing_ai_variant_assets WHERE result_id = ? AND field_key = ? AND status <> 'deleted' LIMIT 1",
    [payload.result_id, payload.field_key]
  );
  if (existing?.id) {
    await mysqlExecute(`
      UPDATE listing_ai_variant_assets
      SET source_module = ?, workbench_id = ?, source_batch_id = ?, source_product_id = ?,
          product_name = ?, variant_target = ?, listing_draft_id = ?, listing_template_id = ?,
          field_status = ?, asset_json = ?, prompt_snapshot_json = ?, row_snapshot_json = ?,
          error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      payload.source_module,
      payload.workbench_id,
      payload.source_batch_id,
      payload.source_product_id,
      payload.product_name,
      payload.variant_target,
      payload.listing_draft_id,
      payload.listing_template_id,
      payload.field_status,
      JSON.stringify(payload.asset),
      JSON.stringify(payload.prompt_snapshot),
      JSON.stringify(payload.row_snapshot),
      payload.error_message,
      existing.id
    ]);
    return normalizeListingAiVariantAssetRow(await row("SELECT * FROM listing_ai_variant_assets WHERE id = ?", [existing.id]));
  }
  const id = await insert(`
    INSERT INTO listing_ai_variant_assets
    (source_module, workbench_id, source_batch_id, result_id, source_product_id, product_name, variant_target,
     listing_draft_id, listing_template_id, field_key, field_status, asset_json, prompt_snapshot_json,
     row_snapshot_json, error_message, created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    payload.source_module,
    payload.workbench_id,
    payload.source_batch_id,
    payload.result_id,
    payload.source_product_id,
    payload.product_name,
    payload.variant_target,
    payload.listing_draft_id,
    payload.listing_template_id,
    payload.field_key,
    payload.field_status,
    JSON.stringify(payload.asset),
    JSON.stringify(payload.prompt_snapshot),
    JSON.stringify(payload.row_snapshot),
    payload.error_message,
    payload.created_by_person_id
  ]);
  return normalizeListingAiVariantAssetRow(await row("SELECT * FROM listing_ai_variant_assets WHERE id = ?", [id]));
}

export async function createListingDraft(body, session) {
  const totalStarted = Date.now();
  const traceId = aiVariantSaveTraceId(body);
  logAiVariantSavePerf(traceId, "backend.draft.create.start", totalStarted, {
    productName: String(body?.product_name || body?.productName || "").slice(0, 120)
  });
  let stageStarted = Date.now();
  await ensureListingAutomationSchema();
  logAiVariantSavePerf(traceId, "backend.draft.ensure_schema", stageStarted);
  stageStarted = Date.now();
  const payload = sanitizeDraftMediaPayload(await materializeAiOptimizationDraftMedia(normalizeDraftPayload(body), session));
  logAiVariantSavePerf(traceId, "backend.draft.normalize_and_materialize", stageStarted, {
    sourceImageCount: normalizeStringList(payload.source_images).length
  });
  if (!payload.template_id) throw new Error("璇峰厛閫夋嫨绫荤洰妯℃澘");
  if (!payload.product_name) throw new Error("鍟嗗搧鍚嶇О涓嶈兘涓虹┖");

  stageStarted = Date.now();
  const template = await row("SELECT * FROM listing_category_templates WHERE id = ? AND status <> 'deleted'", [payload.template_id]);
  logAiVariantSavePerf(traceId, "backend.draft.template_lookup", stageStarted, { templateId: payload.template_id });
  if (!template) throw new Error("Listing category template not found");
  const normalizedTemplate = normalizeTemplateRow(template);
  const manualFacts = sanitizeDraftManualFactsMedia({
    ...(normalizedTemplate.editable_payload || {}),
    attributes: normalizedTemplate.attributes || [],
    images: normalizedTemplate.images || [],
    user_facts: payload.manual_facts
  }, payload.source_images, { forceImages: true });
  const aiPayload = {
    ...(payload.ai_payload || {}),
    manual_facts: payload.manual_facts || {},
    source: payload.ai_payload?.source || (payload.manual_facts?.ai_optimization_result_id ? "ai_optimization_v2" : "listing_draft")
  };

  stageStarted = Date.now();
  const id = await insert(`
    INSERT INTO listing_drafts
    (template_id, product_name, internal_code, source_urls_json, source_images_json, cost_price, sale_price,
     length_cm, width_cm, height_cm, weight_g, color, spec, quantity, manual_facts_json, ai_payload_json,
     created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
    JSON.stringify(aiPayload),
    personId(session)
  ]);
  logAiVariantSavePerf(traceId, "backend.draft.insert", stageStarted, { draftId: id, templateId: payload.template_id });
  stageStarted = Date.now();
  const detail = await listingDraft(id, session);
  logAiVariantSavePerf(traceId, "backend.draft.detail", stageStarted, { draftId: id });
  logAiVariantSavePerf(traceId, "backend.draft.create.done", totalStarted, { draftId: id, templateId: payload.template_id });
  return detail;
}

export async function updateListingDraft(id, body = {}, session = null) {
  await ensureListingAutomationSchema();
  const draftId = Number(id);
  const existing = await assertDraftAccess(draftId, session);
  const payload = sanitizeDraftMediaPayload(await materializeAiOptimizationDraftMedia(normalizeDraftPayload({
    ...body,
    template_id: body.template_id || body.templateId || existing.template_id
  }), session));
  if (!payload.template_id) throw new Error("Template is required");
  if (!payload.product_name) throw new Error("Product name is required");
  const template = await row("SELECT * FROM listing_category_templates WHERE id = ? AND status <> 'deleted'", [payload.template_id]);
  if (!template) throw new Error("Template not found");
  const normalizedTemplate = normalizeTemplateRow(template);
  const manualFacts = sanitizeDraftManualFactsMedia({
    ...(normalizedTemplate.editable_payload || {}),
    attributes: normalizedTemplate.attributes || [],
    images: normalizedTemplate.images || [],
    user_facts: payload.manual_facts
  }, payload.source_images, { forceImages: true });
  const aiPayload = {
    ...(existing.ai_payload || {}),
    ...(payload.ai_payload || {}),
    manual_facts: payload.manual_facts || {},
    source: payload.ai_payload?.source || existing.ai_payload?.source || (payload.manual_facts?.ai_optimization_result_id ? "ai_optimization_v2" : "listing_draft")
  };
  await mysqlExecute(`
    UPDATE listing_drafts
    SET template_id = ?, product_name = ?, internal_code = ?, source_urls_json = ?, source_images_json = ?,
        cost_price = ?, sale_price = ?, length_cm = ?, width_cm = ?, height_cm = ?, weight_g = ?,
        color = ?, spec = ?, quantity = ?, manual_facts_json = ?, ai_payload_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status <> 'deleted'
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
    JSON.stringify(aiPayload),
    draftId
  ]);
  return listingDraft(draftId, session);
}

export async function createAiVariantListingDraftLightweight(body = {}, session = null) {
  const totalStarted = Date.now();
  const traceId = aiVariantSaveTraceId(body);
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.start", totalStarted, {
    templateId: Number(body.template_id || body.templateId || body.base_template_id || body.baseTemplateId || 0)
  });
  let stageStarted = Date.now();
  await ensureListingAutomationSchema();
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.ensure_schema", stageStarted);

  const templateId = Number(body.template_id || body.templateId || body.base_template_id || body.baseTemplateId || 0);
  if (!templateId) throw new Error("杞婚噺淇濆瓨闇€瑕佸師濮嬩笂鏋舵ā鏉?ID");
  stageStarted = Date.now();
  const templateRow = await row("SELECT * FROM listing_category_templates WHERE id = ? AND status <> 'deleted'", [templateId]);
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.template_lookup", stageStarted, { templateId });
  if (!templateRow) throw new Error("Source listing template not found");

  const template = normalizeTemplateRow(templateRow);
  const patch = objectValue(body.patch || body.patches || {});
  const editable = applyAiVariantDraftPatch(template.editable_payload || {}, patch);
  const sourceImages = normalizeStringList(body.source_images || body.sourceImages || patch.source_images || patch.sourceImages)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const images = cleanListingImageUrls(sourceImages.length ? sourceImages : normalizeImages(editable.images || template.images || []).map((image) => image.url).filter(Boolean));
  const title = String(patch.title || body.product_name || body.productName || editable.title || template.title || template.template_name || "").trim();
  const description = String(patch.description || editable.description || template.description || "").trim();
  const userFacts = sanitizeDraftManualFactsMedia(objectValue(body.manual_facts || body.manualFacts), images, { dropImages: true });
  const manualFacts = {
    ...sanitizeDraftManualFactsMedia(editable, images),
    title,
    description,
    attributes: normalizeAttributes(editable.attributes || template.attributes || []),
    images: normalizeImages(images),
    user_facts: userFacts,
    ai_optimization: objectValue(body.ai_optimization || body.aiOptimization || patch.ai_optimization || patch.aiOptimization)
  };
  const aiPayload = {
    source: "ai_optimization_v2_lightweight",
    manual_facts: manualFacts.user_facts || {},
    ai_optimization: manualFacts.ai_optimization || {},
    changed_fields: normalizeStringList(body.changed_fields || body.changedFields || patch.changed_fields || patch.changedFields)
  };
  const payload = sanitizeDraftMediaPayload({
    template_id: templateId,
    product_name: title,
    internal_code: String(body.internal_code || body.internalCode || "").trim(),
    source_urls: splitLines(body.source_urls || body.sourceUrls),
    source_images: images,
    cost_price: Number(body.cost_price || body.costPrice || 0),
    sale_price: Number(body.sale_price || body.salePrice || 0),
    length_cm: Number(body.length_cm || body.lengthCm || 0),
    width_cm: Number(body.width_cm || body.widthCm || 0),
    height_cm: Number(body.height_cm || body.heightCm || 0),
    weight_g: Number(body.weight_g || body.weightG || 0),
    color: String(body.color || "").trim(),
    spec: String(body.spec || "").trim(),
    quantity: Number(body.quantity || 0)
  });
  if (!payload.product_name) throw new Error("鍟嗗搧鍚嶇О涓嶈兘涓虹┖");
  if (!payload.internal_code) payload.internal_code = `AI-${Date.now().toString(36)}`;

  stageStarted = Date.now();
  const existing = await findExistingAiVariantDraft(payload, aiPayload);
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.find_existing", stageStarted, {
    draftId: existing?.id || 0,
    internalCode: payload.internal_code
  });

  stageStarted = Date.now();
  const draftTemplateId = await upsertAiVariantListingDraftTemplate({
    existingTemplateId: existing?.template_id,
    baseTemplate: template,
    editable,
    title,
    description,
    images,
    manualFacts,
    aiPayload,
    payload
  }, session);
  payload.template_id = draftTemplateId;
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.template_upsert", stageStarted, {
    templateId: draftTemplateId,
    mode: Number(existing?.template_id || 0) ? "update" : "insert"
  });

  stageStarted = Date.now();
  let draftId = Number(existing?.id || 0);
  const params = [
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
    JSON.stringify(aiPayload),
    personId(session)
  ];
  if (draftId) {
    await mysqlExecute(`
      UPDATE listing_drafts
      SET template_id = ?, product_name = ?, internal_code = ?, source_urls_json = ?, source_images_json = ?,
          cost_price = ?, sale_price = ?, length_cm = ?, width_cm = ?, height_cm = ?, weight_g = ?,
          color = ?, spec = ?, quantity = ?, manual_facts_json = ?, ai_payload_json = ?,
          created_by_person_id = COALESCE(created_by_person_id, ?), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status <> 'deleted'
    `, [...params, draftId]);
  } else {
    draftId = await insert(`
      INSERT INTO listing_drafts
      (template_id, product_name, internal_code, source_urls_json, source_images_json, cost_price, sale_price,
       length_cm, width_cm, height_cm, weight_g, color, spec, quantity, manual_facts_json, ai_payload_json,
       created_by_person_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, params);
  }
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.upsert", stageStarted, { draftId, mode: existing ? "update" : "insert" });
  stageStarted = Date.now();
  const detail = await listingDraft(draftId, session);
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.detail", stageStarted, { draftId });
  logAiVariantSavePerf(traceId, "backend.ai_variant_light_draft.done", totalStarted, { draftId, templateId });
  return detail;
}

function applyAiVariantDraftPatch(editable = {}, patch = {}) {
  const next = cloneJsonValue(editable, {});
  const title = String(patch.title || "").trim();
  const description = String(patch.description || "").trim();
  const tags = normalizeStringList(patch.tags || patch.hashtags);
  const images = normalizeImages(cleanListingImageUrls(patch.images || patch.source_images || patch.sourceImages || next.images || []));
  const videoUrls = normalizeStringList(patch.video_urls || patch.videoUrls || patch.video_url || patch.videoUrl);
  if (title) {
    next.title = title;
    next.name = title;
  }
  if (description) next.description = description;
  if (tags.length) next.hashtags = tags;
  if (images.length) next.images = images;
  next.attributes = syncAiVariantTextAttributes(next.attributes || [], { title, description, tags });
  next.logistics = {
    ...(next.logistics || {}),
    ...(tags.length ? { tags } : {})
  };
  if (videoUrls.length) {
    next.video_urls = videoUrls;
    next.video_cover_urls = videoUrls;
  }
  next.variants = normalizeArray(next.variants).map((variant, index) => {
    if (index > 0) return variant;
    return {
      ...variant,
      title: title || variant.title || variant.name || "",
      name: title || variant.name || variant.title || "",
      hashtags: tags.length ? tags : variant.hashtags,
      images: images.length ? images : variant.images,
      ...(videoUrls.length ? { video_urls: videoUrls, video_cover_urls: videoUrls } : {})
    };
  });
  return next;
}

function mediaUrlFromValue(item = "") {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") return String(item.url || item.src || item.previewUrl || item.localUrl || item.publishUrl || item.value || "").trim();
  return "";
}

function isListingVideoUrl(url = "") {
  return /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(String(url || "").trim());
}

function isCleanListingImageUrl(url = "") {
  const value = String(url || "").trim();
  if (!value || /\[object Object\]/i.test(value) || /undefined|null/i.test(value)) return false;
  if (/^data:(?!image\/)/i.test(value)) return false;
  return !isListingVideoUrl(value);
}

function cleanListingImageUrls(value = []) {
  const urls = normalizeArray(value)
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .map(mediaUrlFromValue)
    .map((item) => item.trim())
    .filter(isCleanListingImageUrl);
  return [...new Set(urls)];
}

function cleanListingVideoUrls(value = []) {
  const urls = normalizeArray(value)
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .map(mediaUrlFromValue)
    .map((item) => item.trim())
    .filter((item) => item && !/\[object Object\]/i.test(item) && isListingVideoUrl(item));
  return [...new Set(urls)];
}

function sanitizeDraftManualFactsMedia(manualFacts = {}, sourceImages = [], options = {}) {
  const cleanImages = cleanListingImageUrls(sourceImages.length ? sourceImages : manualFacts.images);
  const cleanImageObjects = normalizeImages(cleanImages);
  const next = cloneJsonValue(manualFacts, {});
  if (options.dropImages) delete next.images;
  else if (options.forceImages || Object.prototype.hasOwnProperty.call(next, "images")) next.images = cleanImageObjects;
  const shouldTouchVariants = options.forceVariants || Object.prototype.hasOwnProperty.call(next, "variants");
  if (shouldTouchVariants) {
    next.variants = normalizeArray(next.variants).map((variant, index) => {
      const cleanVariant = { ...variant };
      const variantImages = cleanListingImageUrls(index === 0 ? cleanImages : (variant.images || cleanImages));
      const shouldSetImages = options.forceImages || Object.prototype.hasOwnProperty.call(variant || {}, "images");
      if (shouldSetImages) cleanVariant.images = normalizeImages(variantImages.length ? variantImages : cleanImages);
      if (Object.prototype.hasOwnProperty.call(variant || {}, "video_urls") || Object.prototype.hasOwnProperty.call(variant || {}, "videos") || Object.prototype.hasOwnProperty.call(variant || {}, "video_url")) {
        cleanVariant.video_urls = cleanListingVideoUrls(variant.video_urls || variant.videos || variant.video_url);
      }
      if (Object.prototype.hasOwnProperty.call(variant || {}, "video_cover_urls") || Object.prototype.hasOwnProperty.call(variant || {}, "cover_video_urls") || Object.prototype.hasOwnProperty.call(variant || {}, "video_cover")) {
        cleanVariant.video_cover_urls = cleanListingVideoUrls(variant.video_cover_urls || variant.cover_video_urls || variant.video_cover);
      }
      return cleanVariant;
    });
  }
  if (next.user_facts && typeof next.user_facts === "object") {
    next.user_facts = { ...next.user_facts };
    if (options.forceUserFactsImages) next.user_facts.images = cleanImageObjects;
    else delete next.user_facts.images;
  }
  return next;
}

function sanitizeDraftMediaPayload(payload = {}) {
  const sourceImages = cleanListingImageUrls(payload.source_images || payload.sourceImages);
  const manualFacts = sanitizeDraftManualFactsMedia(objectValue(payload.manual_facts || payload.manualFacts), sourceImages, { dropImages: true });
  return {
    ...payload,
    source_images: sourceImages,
    manual_facts: manualFacts
  };
}

function syncAiVariantTextAttributes(attributes = [], facts = {}) {
  const next = normalizeAttributes(attributes);
  const upsert = (names, value, defaults = {}) => {
    if (value === undefined || value === null || value === "") return;
    const normalizedValue = Array.isArray(value) ? value.join(",") : String(value);
    if (!normalizedValue) return;
    const item = findAttributeByNames(next, names, defaults.attributeIds || defaults.attribute_id || []);
    if (item) {
      item.value = normalizedValue;
      if (Array.isArray(value)) item.values = value;
      if (defaults.attribute_id && !item.attribute_id) item.attribute_id = defaults.attribute_id;
      if (defaults.type && !item.type) item.type = defaults.type;
      return;
    }
    next.push({
      name: defaults.name || names[0],
      value: normalizedValue,
      values: Array.isArray(value) ? value : [],
      required: Boolean(defaults.required),
      attribute_id: defaults.attribute_id || "",
      type: defaults.type || "text",
      source: "ai_variant_draft",
      sort_order: next.length + 1
    });
  };
  upsert(["鏍囬", "袧邪蟹胁邪薪懈械"], facts.title, { name: "鏍囬", required: true });
  upsert(["浜у搧鏍囩", "涓诲浘鏍囩", "泻谢褞褔械胁褘械 褋谢芯胁邪", "褌械谐"], facts.tags, { name: "浜у搧鏍囩", attribute_id: 23171, type: "multiselect" });
  upsert(["Description", "Аннотация", "Описание"], facts.description, { name: "Description", attribute_id: 4191, type: "textarea" });
  return next;
}

async function upsertAiVariantListingDraftTemplate(input = {}, session = null) {
  const baseTemplate = input.baseTemplate || {};
  const editable = {
    ...(baseTemplate.editable_payload || {}),
    ...(input.editable || {})
  };
  const title = String(input.title || editable.title || baseTemplate.title || baseTemplate.template_name || "").trim();
  const description = String(input.description || editable.description || baseTemplate.description || "").trim();
  const images = normalizeImages(input.images || editable.images || baseTemplate.images || []);
  const attributes = syncAiVariantTextAttributes(
    input.editable?.attributes || editable.attributes || baseTemplate.attributes || [],
    {
      title,
      description,
      tags: normalizeStringList(input.editable?.hashtags || editable.hashtags || input.manualFacts?.hashtags || [])
    }
  );
  const sourceRaw = {
    ...(baseTemplate.source_raw || {}),
    ai_optimization: input.manualFacts?.ai_optimization || input.aiPayload?.ai_optimization || {},
    ai_variant_draft: {
      source_template_id: Number(baseTemplate.id || input.payload?.template_id || 0),
      internal_code: input.payload?.internal_code || "",
      saved_at: new Date().toISOString()
    }
  };
  const nextEditable = {
    ...editable,
    title,
    name: title,
    description,
    attributes,
    images,
    source_raw: sourceRaw
  };
  const templateName = String(baseTemplate.template_name || title || "AI variant listing template").slice(0, 255);
  const templateId = Number(input.existingTemplateId || 0);
  if (templateId && templateId !== Number(baseTemplate.id || 0)) {
    await mysqlExecute(`
      UPDATE listing_category_templates
      SET template_name = ?, source_raw_json = ?, editable_payload_json = ?,
          title = ?, description = ?, attributes_json = ?, images_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status <> 'deleted'
    `, [
      templateName,
      JSON.stringify(sourceRaw),
      JSON.stringify(nextEditable),
      title,
      description,
      JSON.stringify(attributes),
      JSON.stringify(images),
      templateId
    ]);
    return templateId;
  }
  return insert(`
    INSERT INTO listing_category_templates
    (ozon_category_id, category_name, template_name, required_attributes_json, ai_rules_json, title_prompt,
     description_prompt, image_rules_json, source_type, source_ozon_sku, source_raw_json,
     editable_payload_json, title, description, attributes_json, images_json,
     created_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai_optimization_v2_lightweight', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    baseTemplate.ozon_category_id || "",
    baseTemplate.category_name || "",
    templateName,
    JSON.stringify(baseTemplate.required_attributes || []),
    JSON.stringify(baseTemplate.ai_rules || {}),
    baseTemplate.title_prompt || "",
    baseTemplate.description_prompt || "",
    JSON.stringify(baseTemplate.image_rules || {}),
    baseTemplate.source_ozon_sku || "",
    JSON.stringify(sourceRaw),
    JSON.stringify(nextEditable),
    title,
    description,
    JSON.stringify(attributes),
    JSON.stringify(images),
    personId(session)
  ]);
}

async function findExistingAiVariantDraft(payload = {}, aiPayload = {}) {
  const resultId = String(aiPayload.ai_optimization?.result_id || aiPayload.manual_facts?.ai_optimization_result_id || "").trim();
  if (!resultId) return null;
  const params = [payload.internal_code];
  let sql = `
    SELECT id, template_id
    FROM listing_drafts
    WHERE status <> 'deleted'
      AND internal_code = ?
  `;
  if (resultId) {
    sql += " AND (manual_facts_json LIKE ? OR ai_payload_json LIKE ?)";
    params.push(`%${resultId}%`, `%${resultId}%`);
  } else {
    sql += " AND template_id = ?";
    params.push(payload.template_id);
  }
  sql += " ORDER BY updated_at DESC, id DESC LIMIT 1";
  return row(sql, params);
}

function cloneJsonValue(value, fallback = {}) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function buildDraftMediaRepairPlan(rowItem = {}) {
  const sourceImages = parseJson(rowItem.source_images_json, []);
  const manualFacts = parseJson(rowItem.manual_facts_json, {});
  const templateImages = parseJson(rowItem.template_images_json, []);
  const templateEditable = parseJson(rowItem.template_editable_payload_json, {});
  const originalSourceImageUrls = normalizeArray(sourceImages).map(mediaUrlFromValue).filter(Boolean);
  const sourceImageUrls = cleanListingImageUrls(sourceImages);
  const fallbackImages = cleanListingImageUrls(sourceImageUrls.length ? sourceImageUrls : [
    ...normalizeArray(templateImages),
    ...normalizeArray(templateEditable.images),
    ...normalizeArray(manualFacts.images)
  ]);
  const nextSourceImages = fallbackImages;
  const nextManualFacts = sanitizeDraftManualFactsMedia(manualFacts, nextSourceImages);
  const beforeManualMedia = collectDraftMediaFields(manualFacts);
  const manualImageUrlsBefore = beforeManualMedia
    .filter((item) => /image/i.test(item.path))
    .flatMap((item) => normalizeArray(item.value).map(mediaUrlFromValue).filter(Boolean));
  const manualVideoUrls = beforeManualMedia
    .filter((item) => /video/i.test(item.path))
    .flatMap((item) => normalizeArray(item.value).map(mediaUrlFromValue).filter(Boolean));
  const issues = [];
  const rawText = `${rowItem.source_images_json || ""}\n${rowItem.manual_facts_json || ""}\n${rowItem.ai_payload_json || ""}`;
  if (/\[object Object\]/i.test(rawText)) issues.push("object-string");
  if (normalizeArray(sourceImages).some((item) => !isCleanListingImageUrl(mediaUrlFromValue(item)))) issues.push("bad-source-image");
  if (normalizeArray(sourceImages).map(mediaUrlFromValue).some(isListingVideoUrl) || manualImageUrlsBefore.some(isListingVideoUrl)) issues.push("video-in-image-field");
  if (originalSourceImageUrls.length && new Set(originalSourceImageUrls).size !== originalSourceImageUrls.length) issues.push("duplicate-source-images");
  if (hasDraftManualImageBloat(beforeManualMedia, nextSourceImages)) issues.push("manual-image-bloat");
  if (cleanListingImageUrls(templateImages).length && nextSourceImages.length && cleanListingImageUrls(templateImages)[0] !== nextSourceImages[0]) issues.push("source-template-primary-diff");
  const hasRepairableIssue = issues.some((issue) => issue !== "source-template-primary-diff");
  const changed = hasRepairableIssue && (
    JSON.stringify(sourceImages) !== JSON.stringify(nextSourceImages)
    || JSON.stringify(manualFacts) !== JSON.stringify(nextManualFacts)
  );
  return {
    id: Number(rowItem.id || 0),
    template_id: Number(rowItem.template_id || 0),
    product_name: rowItem.product_name || "",
    issues,
    changed,
    source_images_before: normalizeArray(sourceImages).map(mediaUrlFromValue).filter(Boolean),
    next_source_images: nextSourceImages,
    next_manual_facts: nextManualFacts,
    manual_image_count_before: manualImageUrlsBefore.length,
    manual_image_count_after: collectDraftMediaFields(nextManualFacts)
      .filter((item) => /image/i.test(item.path))
      .flatMap((item) => normalizeArray(item.value).map(mediaUrlFromValue).filter(Boolean)).length,
    manual_video_count: manualVideoUrls.filter(Boolean).length
  };
}

function collectDraftMediaFields(value = {}, pathName = "", out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectDraftMediaFields(item, `${pathName}[${index}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = pathName ? `${pathName}.${key}` : key;
    if (isDraftMediaValueField(key, child, nextPath)) out.push({ path: nextPath, value: child });
    if (child && typeof child === "object") collectDraftMediaFields(child, nextPath, out);
  }
  return out;
}

function isDraftMediaValueField(key = "", value = null, pathName = "") {
  const field = String(key || "");
  const pathValue = String(pathName || "");
  if (/(^|\.)prompt\.|(^|\.)strategy\.|(^|\.)normalization_diagnostics\.|(^|\.)diagnostics\./i.test(pathValue)) return false;
  if (/prompt|label|error|status|source/i.test(field)) return false;
  if (/^images?$|image_urls?|source_images?|detail_images?|main_images?$/i.test(field)) return true;
  if (/^videos?$|video_urls?|video_cover_urls?|cover_video_urls?$/i.test(field)) return true;
  return false;
}

function hasDraftManualImageBloat(mediaFields = [], sourceImages = []) {
  const sourceCount = Math.max(cleanListingImageUrls(sourceImages).length, 1);
  const imageGroups = normalizeArray(mediaFields)
    .filter((item) => /image/i.test(item.path))
    .map((item) => ({
      path: item.path,
      urls: cleanListingImageUrls(item.value)
    }))
    .filter((item) => item.urls.length);
  const userFactsImages = imageGroups.find((item) => /^user_facts\.images$/i.test(item.path));
  if (userFactsImages?.urls.length) return true;
  return imageGroups.some((item) => item.urls.length > Math.max(sourceCount * 2, 24));
}

function summarizeDraftMediaRepairIssues(items = []) {
  const counts = {};
  for (const item of items) {
    for (const issue of item.issues || []) counts[issue] = (counts[issue] || 0) + 1;
    if (item.changed) counts.changed = (counts.changed || 0) + 1;
  }
  return counts;
}

export async function repairAiOptimizationListingMedia(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const limit = Math.min(Math.max(1, Number(body.limit || 100)), 500);
  const dryRun = Boolean(body.dryRun || body.dry_run);
  const templateRows = await all(`
    SELECT id, source_type, source_ozon_sku, source_raw_json, editable_payload_json, images_json, description, template_name
    FROM listing_category_templates
    WHERE status <> 'deleted'
      AND (
        source_type = 'ai_optimization_v2'
        OR source_raw_json LIKE '%ai_optimization%'
        OR editable_payload_json LIKE '%ai_optimization%'
      )
    ORDER BY id DESC
    LIMIT ?
  `, [limit]);
  const draftRows = await all(`
    SELECT id, source_images_json, manual_facts_json, ai_payload_json
    FROM listing_drafts
    WHERE status <> 'deleted'
      AND (
        ai_payload_json LIKE '%ai_optimization%'
        OR manual_facts_json LIKE '%ai_optimization%'
        OR manual_facts_json LIKE '%source_batch_id%'
      )
    ORDER BY id DESC
    LIMIT ?
  `, [limit]);
  const templates = [];
  for (const rowItem of templateRows) {
    const before = `${rowItem.images_json || ""}${rowItem.editable_payload_json || ""}${rowItem.source_raw_json || ""}${rowItem.description || ""}`;
    const payload = await materializeAiOptimizationTemplateMedia({
      source_type: rowItem.source_type || "",
      source_ozon_sku: rowItem.source_ozon_sku || "",
      source_raw: parseJson(rowItem.source_raw_json, {}),
      editable_payload: parseJson(rowItem.editable_payload_json, {}),
      images: parseJson(rowItem.images_json, []),
      description: rowItem.description || "",
      template_name: rowItem.template_name || ""
    }, session);
    const afterImages = JSON.stringify(payload.images || []);
    const afterEditable = JSON.stringify(payload.editable_payload || {});
    const afterSourceRaw = JSON.stringify(payload.source_raw || {});
    const afterDescription = String(payload.description || rowItem.description || "");
    const changed = before !== `${afterImages}${afterEditable}${afterSourceRaw}${afterDescription}`;
    if (changed && !dryRun) {
      await mysqlExecute(`
        UPDATE listing_category_templates
        SET images_json = ?, editable_payload_json = ?, source_raw_json = ?, description = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [afterImages, afterEditable, afterSourceRaw, afterDescription, Number(rowItem.id)]);
    }
    templates.push({ id: Number(rowItem.id), changed });
  }
  const drafts = [];
  for (const rowItem of draftRows) {
    const before = `${rowItem.source_images_json || ""}${rowItem.manual_facts_json || ""}${rowItem.ai_payload_json || ""}`;
    const payload = await materializeAiOptimizationDraftMedia({
      source_images: parseJson(rowItem.source_images_json, []),
      manual_facts: parseJson(rowItem.manual_facts_json, {}),
      ai_payload: parseJson(rowItem.ai_payload_json, {})
    }, session);
    const afterImages = JSON.stringify(payload.source_images || []);
    const afterFacts = JSON.stringify(payload.manual_facts || {});
    const afterAi = JSON.stringify(payload.ai_payload || {});
    const changed = before !== `${afterImages}${afterFacts}${afterAi}`;
    if (changed && !dryRun) {
      await mysqlExecute(`
        UPDATE listing_drafts
        SET source_images_json = ?, manual_facts_json = ?, ai_payload_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [afterImages, afterFacts, afterAi, Number(rowItem.id)]);
    }
    drafts.push({ id: Number(rowItem.id), changed });
  }
  return {
    ok: true,
    dryRun,
    templates: {
      scanned: templates.length,
      changed: templates.filter((item) => item.changed).length,
      ids: templates.filter((item) => item.changed).map((item) => item.id)
    },
    drafts: {
      scanned: drafts.length,
      changed: drafts.filter((item) => item.changed).length,
      ids: drafts.filter((item) => item.changed).map((item) => item.id)
    }
  };
}

export async function repairListingDraftMediaContamination(body = {}, session = null) {
  await ensureListingAutomationSchema();
  const apply = body.apply === true || body.dryRun === false || body.dry_run === false;
  const limit = Math.min(Math.max(1, Number(body.limit || 300)), 1000);
  const draftIds = normalizeArray(body.ids || body.draft_ids || body.draftIds || body.id)
    .map((item) => Number(item || 0))
    .filter((item) => Number.isFinite(item) && item > 0);
  const where = ["d.status <> 'deleted'"];
  const params = [];
  if (draftIds.length) {
    where.push(`d.id IN (${draftIds.map(() => "?").join(",")})`);
    params.push(...draftIds);
  }
  const rows = await all(`
    SELECT d.id, d.template_id, d.product_name, d.source_images_json, d.manual_facts_json, d.ai_payload_json,
      t.images_json AS template_images_json, t.editable_payload_json AS template_editable_payload_json
    FROM listing_drafts d
    LEFT JOIN listing_category_templates t ON t.id = d.template_id
    WHERE ${where.join(" AND ")}
    ORDER BY d.updated_at DESC, d.id DESC
    LIMIT ?
  `, [...params, limit]);
  const scanned = rows.map(buildDraftMediaRepairPlan);
  const changed = scanned.filter((item) => item.changed);
  if (apply) {
    for (const item of changed) {
      await mysqlExecute(`
        UPDATE listing_drafts
        SET source_images_json = ?, manual_facts_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status <> 'deleted'
      `, [JSON.stringify(item.next_source_images), JSON.stringify(item.next_manual_facts), item.id]);
    }
  }
  return {
    ok: true,
    dryRun: !apply,
    scanned: scanned.length,
    changed: changed.length,
    issueTypeCounts: summarizeDraftMediaRepairIssues(scanned),
    rows: scanned
      .filter((item) => item.changed || item.issues.length)
      .slice(0, Math.min(Math.max(Number(body.previewLimit || 50), 1), 200))
      .map((item) => ({
        id: item.id,
        template_id: item.template_id,
        product_name: item.product_name,
        issues: item.issues,
        source_images_before: item.source_images_before,
        source_images_after: item.next_source_images,
        manual_image_count_before: item.manual_image_count_before,
        manual_image_count_after: item.manual_image_count_after,
        manual_video_count: item.manual_video_count
      }))
  };
}

export async function deleteListingDraft(id, session = null) {
  await ensureListingAutomationSchema();
  const draftId = Number(id);
  const draft = await row("SELECT id FROM listing_drafts WHERE id = ? AND status <> 'deleted'", [draftId]);
  if (!draft) throw new Error("Listing draft not found");
  await withMysqlTransaction(async (connection) => {
    await connection.execute(`
      UPDATE listing_drafts
      SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [draftId]);
    await connection.execute(`
      UPDATE listing_shop_copies
      SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ? AND status = 'prepared'
    `, [draftId]);
  });
  return { ok: true, id: draftId };
}

export async function generateListingShopCopies(draftId, body, session) {
  await ensureListingAutomationSchema();
  const draft = await assertDraftAccess(draftId, session);
  const shopIds = [...new Set((body?.shop_ids || body?.shopIds || []).map((id) => Number(id)).filter(Boolean))];
  if (!shopIds.length) throw new Error("Please select at least one shop");

  const shops = await all(
    `SELECT id, name, watermark_path FROM shops WHERE id IN (${shopIds.map(() => "?").join(",")}) AND status <> 'deleted'`,
    shopIds
  );
  if (!shops.length) throw new Error("No available target shops");

  const copies = await Promise.all(shops.map((shop) => buildShopCopy(draft, shop, session)));
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
  const template = await listingCategoryTemplateRaw(id, session);
  if (!template) return null;
  return hydrateTemplateDictionaryDisplayValues(await hydrateTemplateSelectedDictionaryValues(template));
}

async function listingCategoryTemplateRaw(id, session) {
  const template = await row(`
    SELECT t.*, p.name AS created_by_name
    FROM listing_category_templates t
    LEFT JOIN people p ON p.id = t.created_by_person_id
    WHERE t.id = ?
  `, [id]);
  if (!template) return null;
  return normalizeTemplateRow(template);
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
  const categoryName = String(source.category_name || source.description_category_name || source.type_name || source.category || (categoryId ? `Ozon 绫荤洰 ${categoryId}` : current.category_name || "")).trim();
  const title = String(source.name || source.name_ru || current.title || current.template_name || "").trim();
  const images = extractImageUrls(source).map((url, index) => ({ url, sort_order: index + 1 }));
  const attributes = normalizeOzonDetailAttributes(source.attributes || source.attribute_values || source.characteristics || []);
  const dimensions = extractOzonDimensions(source, attributes);
  const brandValue = attributeValueByNames(attributes, ["鍝佺墝", "袘褉械薪写"], [85]);
  const colorValue = attributeValueByNames(attributes, ["棰滆壊", "笑胁械褌"], [8229]);
  const modelValue = attributeValueByNames(attributes, ["鍨嬪彿", "袦芯写械谢褜"], [9048]);
  const tagsValue = attributeValueByNames(attributes, ["浜у搧鏍囩", "涓诲浘鏍囩", "泻谢褞褔械胁褘械 褋谢芯胁邪", "褌械谐"], [10096]);
  const descriptionText = extractOzonDescriptionText(source, attributes, current);
  const richContent = extractOzonRichContent(source, attributes);
  const enrichedAttributes = enrichTemplateAttributes(attributes, {
    title,
    brand: brandValue || "No brand",
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
        brand: brandValue || "No brand",
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
  return assertDraftAccess(id, session);
}

async function assertDraftAccess(draftId, session) {
  const draft = await row(`
    SELECT d.*, t.category_name, t.template_name, t.ozon_category_id, t.source_type AS template_source_type,
      p.name AS created_by_name
    FROM listing_drafts d
    LEFT JOIN listing_category_templates t ON t.id = d.template_id
    LEFT JOIN people p ON p.id = d.created_by_person_id
    WHERE d.id = ? AND d.status <> 'deleted'
  `, [Number(draftId)]);
  if (!draft) throw new Error("Listing draft not found");
  const normalized = normalizeDraftRow(draft);
  const repaired = await repairAiVariantDraftTemplateReference(normalized, session);
  if (repaired) return assertDraftAccess(draftId, session);
  return normalized;
}

async function repairAiVariantDraftTemplateReference(draft = {}, session = null) {
  const source = String(draft.ai_payload?.source || draft.manual_facts?.source || "").toLowerCase();
  if (!source.includes("ai_optimization_v2_lightweight")) return false;
  if (String(draft.template_source_type || "").toLowerCase().includes("ai_optimization_v2_lightweight")) return false;
  const baseTemplate = await listingCategoryTemplateRaw(draft.template_id, session);
  if (!baseTemplate) return false;
  const sourceImages = cleanListingImageUrls(draft.source_images || draft.manual_facts?.images || baseTemplate.images || []);
  const manualFacts = sanitizeDraftManualFactsMedia(objectValue(draft.manual_facts), sourceImages, { forceImages: true });
  const editable = {
    ...(baseTemplate.editable_payload || {}),
    ...manualFacts,
    title: draft.product_name || manualFacts.title || baseTemplate.title || "",
    description: manualFacts.description || baseTemplate.description || "",
    images: normalizeImages(sourceImages),
    attributes: normalizeAttributes(manualFacts.attributes || baseTemplate.attributes || [])
  };
  const templateId = await upsertAiVariantListingDraftTemplate({
    baseTemplate,
    editable,
    title: editable.title,
    description: editable.description,
    images: editable.images,
    manualFacts,
    aiPayload: draft.ai_payload || {},
    payload: {
      template_id: draft.template_id,
      internal_code: draft.internal_code || "",
      product_name: draft.product_name || ""
    }
  }, session);
  await mysqlExecute(`
    UPDATE listing_drafts
    SET template_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status <> 'deleted'
  `, [templateId, Number(draft.id)]);
  return true;
}

async function buildShopCopy(draft, shop, session) {
  const prefix = String(shop.name || `SHOP${shop.id}`).replace(/\s+/g, "").slice(0, 8).toUpperCase();
  const code = draft.internal_code || `DRAFT${draft.id}`;
  const offerId = `${prefix}-${code}`.replace(/[^A-Z0-9_-]/gi, "-").slice(0, 64);
  const baseImages = await generateWatermarkedListingImages(draft.source_images || [], shop, session, {
    source_module: "listing_shop_copy",
    source_id: `${draft.id}:${shop.id}`,
    role: "shop_copy_watermark"
  });
  const tailImageUrl = await resolveShopTailImageUrl(shop, session);
  const tailResult = appendTailImageToCopyImages(baseImages, tailImageUrl);
  const images = tailResult.images;
  const validation = validateShopCopy(draft, shop, images, tailResult.tail_summary);
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

function validateShopCopy(draft, shop, images, tailSummary = null) {
  const errors = [];
  const warnings = [];
  if (!shop.watermark_path) warnings.push("Shop has no watermark configured, so dedicated images cannot be generated later.");
  if (!images.length) errors.push("Missing product images");
  if (images.some((item) => item.status === "watermark_failed")) warnings.push("Some shop watermark images failed; publish may fall back to original images or require retry.");
  if (images.length && images.every((item) => item.status === "watermark_ready")) warnings.push("Shop-specific watermark images are ready.");
  if (!tailSummary?.configured) warnings.push("Shop has no tail image configured, so tail image append will be skipped on publish.");
  else if (tailSummary.appended > 0) warnings.push("Tail image has been appended for the current shop preview.");
  if (!Number(draft.sale_price || 0)) warnings.push("Sale price is empty");
  if (!Number(draft.weight_g || 0)) errors.push("Missing weight");
  if (!Number(draft.length_cm || 0) || !Number(draft.width_cm || 0) || !Number(draft.height_cm || 0)) errors.push("Missing dimensions");
  if (!draft.color) warnings.push("Color is empty");
  if (!draft.spec) warnings.push("Spec is empty");
  return {
    blocked: errors.length > 0,
    level: errors.length ? "red" : warnings.length ? "yellow" : "green",
    errors,
    warnings
  };
}

export async function ensureListingAutomationSchema() {
  if (config.dbClient !== "mysql") throw new Error("Listing automation only supports MySQL mode");
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
        name_zh VARCHAR(500) NOT NULL DEFAULT '',
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
    await ensureMysqlColumn("ozon_category_attributes", "name_zh", "VARCHAR(500) NOT NULL DEFAULT ''");
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS ozon_attribute_values (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        description_category_id BIGINT NOT NULL,
        type_id BIGINT NOT NULL,
        attribute_id BIGINT NOT NULL,
        dictionary_value_id BIGINT NOT NULL DEFAULT 0,
        value VARCHAR(1000) NOT NULL DEFAULT '',
        display_value_zh VARCHAR(1000) NOT NULL DEFAULT '',
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
    await ensureMysqlColumn("ozon_attribute_values", "display_value_zh", "VARCHAR(1000) NOT NULL DEFAULT ''");
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS ozon_category_sync_jobs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        job_type VARCHAR(64) NOT NULL DEFAULT 'scheduled',
        shop_id BIGINT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'running',
        payload_json LONGTEXT NULL,
        result_json LONGTEXT NULL,
        warning_json LONGTEXT NULL,
        error_message TEXT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP NULL,
        created_by_person_id BIGINT NULL,
        INDEX idx_ozon_category_sync_jobs_status (job_type, status, started_at),
        INDEX idx_ozon_category_sync_jobs_shop (shop_id, started_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await mysqlExecute(`
      CREATE TABLE IF NOT EXISTS ozon_category_usage (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        source_module VARCHAR(64) NOT NULL,
        source_id VARCHAR(128) NOT NULL DEFAULT '',
        description_category_id BIGINT NOT NULL,
        type_id BIGINT NOT NULL,
        category_name VARCHAR(500) NOT NULL DEFAULT '',
        usage_count INT NOT NULL DEFAULT 1,
        last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ozon_category_usage (source_module, source_id, description_category_id, type_id),
        INDEX idx_ozon_category_usage_category (description_category_id, type_id, last_used_at),
        INDEX idx_ozon_category_usage_module (source_module, last_used_at)
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
      CREATE TABLE IF NOT EXISTS listing_ai_variant_assets (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        source_module VARCHAR(64) NOT NULL DEFAULT 'ai_variant_workbench',
        workbench_id VARCHAR(128) NOT NULL DEFAULT '',
        source_batch_id VARCHAR(128) NOT NULL DEFAULT '',
        result_id VARCHAR(128) NOT NULL,
        source_product_id VARCHAR(128) NOT NULL DEFAULT '',
        product_name VARCHAR(255) NOT NULL DEFAULT '',
        variant_target VARCHAR(255) NOT NULL DEFAULT '',
        listing_draft_id BIGINT NULL,
        listing_template_id BIGINT NULL,
        field_key VARCHAR(64) NOT NULL,
        field_status VARCHAR(32) NOT NULL DEFAULT 'generated',
        asset_json LONGTEXT NULL,
        prompt_snapshot_json LONGTEXT NULL,
        row_snapshot_json LONGTEXT NULL,
        error_message TEXT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        created_by_person_id BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_listing_ai_variant_asset_result_field (result_id, field_key),
        INDEX idx_listing_ai_variant_asset_draft (listing_draft_id, updated_at),
        INDEX idx_listing_ai_variant_asset_template (listing_template_id, updated_at),
        INDEX idx_listing_ai_variant_asset_batch (source_batch_id, updated_at),
        INDEX idx_listing_ai_variant_asset_product (source_product_id, updated_at)
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
        template_snapshot_json LONGTEXT NULL,
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
    await ensureMysqlColumn("listing_publish_records", "quality_score", "DECIMAL(5,2) NOT NULL DEFAULT 0");
    await ensureMysqlColumn("listing_publish_records", "quality_source", "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureMysqlColumn("listing_publish_records", "quality_json", "LONGTEXT NULL");
    await ensureMysqlColumn("listing_publish_records", "quality_checked_at", "TIMESTAMP NULL");
    await ensureMysqlColumn("listing_publish_records", "source_product_id", "BIGINT NULL");
    await ensureMysqlColumn("listing_publish_records", "offer_source", "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureMysqlColumn("listing_publish_records", "template_snapshot_json", "LONGTEXT NULL");
    await ensureMysqlIndex("listing_publish_records", "idx_listing_publish_status_created", "(status, created_at, id)");
    await ensureMysqlIndex("listing_publish_records", "idx_listing_publish_shop_created", "(shop_id, created_at, id)");
    await ensureMysqlIndex("listing_drafts", "idx_listing_drafts_status_updated", "(status, updated_at, id)");
    await ensureMysqlIndex("listing_shop_copies", "idx_listing_shop_copies_shop_draft", "(shop_id, draft_id)");
    await ensureMysqlColumn("listing_shop_copies", "source_product_id", "BIGINT NULL");
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
      CREATE TABLE IF NOT EXISTS ozon_plugin_collected_products (
        tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin',
        sku VARCHAR(128) NOT NULL,
        product_id VARCHAR(128) NOT NULL DEFAULT '',
        title VARCHAR(500) NOT NULL DEFAULT '',
        product_url TEXT NULL,
        image_url TEXT NULL,
        category_name VARCHAR(500) NOT NULL DEFAULT '',
        price DECIMAL(14,2) NULL,
        currency VARCHAR(16) NOT NULL DEFAULT 'RUB',
        sold_count DECIMAL(14,4) NULL,
        view_count DECIMAL(14,4) NULL,
        click_rate DECIMAL(14,6) NULL,
        conversion_rate DECIMAL(14,6) NULL,
        stock_count DECIMAL(14,4) NULL,
        commission_rate DECIMAL(14,6) NULL,
        collect_date DATE NOT NULL,
        collected_at VARCHAR(64) NOT NULL DEFAULT '',
        payload_json LONGTEXT NOT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'collected',
        selection_product_id BIGINT NULL,
        listing_template_id BIGINT NULL,
        edit_payload_json LONGTEXT NULL,
        edited_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, sku),
        INDEX idx_ozon_plugin_status (status, updated_at),
        INDEX idx_ozon_plugin_selection (selection_product_id),
        INDEX idx_ozon_plugin_listing_template (listing_template_id),
        INDEX idx_ozon_plugin_collect_date (collect_date),
        INDEX idx_ozon_plugin_collected_at (collected_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await ensureMysqlColumn("ozon_plugin_collected_products", "status", "VARCHAR(64) NOT NULL DEFAULT 'collected'");
    await ensureMysqlColumn("ozon_plugin_collected_products", "selection_product_id", "BIGINT NULL");
    await ensureMysqlColumn("ozon_plugin_collected_products", "listing_template_id", "BIGINT NULL");
    await ensureMysqlColumn("ozon_plugin_collected_products", "edit_payload_json", "LONGTEXT NULL");
    await ensureMysqlColumn("ozon_plugin_collected_products", "edited_at", "TIMESTAMP NULL");
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

async function ensureMysqlIndex(table, indexName, definition) {
  try {
    await mysqlExecute(`ALTER TABLE ${table} ADD INDEX ${indexName} ${definition}`);
  } catch (error) {
    if (error?.code !== "ER_DUP_KEYNAME") throw error;
  }
}

function normalizeTemplatePayload(body = {}) {
  const editable = normalizeEditablePayload(body.editable_payload || body.editablePayload || {});
  return {
    ozon_category_id: String(body.ozon_category_id || body.ozonCategoryId || "").trim(),
    category_name: String(body.category_name || body.categoryName || "").trim(),
    template_name: String(body.template_name || body.templateName || "").trim(),
    source_type: String(body.source_type || body.sourceType || "").trim(),
    source_ozon_sku: String(body.source_ozon_sku || body.sourceOzonSku || "").trim(),
    source_raw: objectValue(body.source_raw || body.sourceRaw || editable.source_raw || {}),
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
  if (body?.editable_payload || body?.editablePayload) {
    const editablePayload = normalizeEditablePayload(body.editable_payload || body.editablePayload || {});
    const images = normalizeImages(body.images || editablePayload.images);
    const attributes = normalizeAttributes(body.attributes || editablePayload.attributes);
    const sourceRaw = body.source_raw || body.sourceRaw || editablePayload.source_raw || {
      source_type: "ozon_frontend_collect",
      collected_product: body
    };
    return {
      ozon_category_id: String(body.ozon_category_id || body.ozonCategoryId || editablePayload.category_id || "").trim(),
      category_name: String(body.category_name || body.categoryName || editablePayload.category_name || "Ozon 鍓嶅彴閲囬泦妯℃澘").trim(),
      template_name: String(body.template_name || body.templateName || body.local_template_name || body.localTemplateName || editablePayload.title || body.title || "Ozon 閲囬泦妯℃澘").trim(),
      source_ozon_sku: String(body.source_ozon_sku || body.sourceOzonSku || editablePayload.sku || body.sku || "").trim(),
      source_raw: sourceRaw,
      required_attributes: splitLines(body.required_attributes || body.requiredAttributes),
      ai_rules: objectValue(body.ai_rules || body.aiRules),
      image_rules: objectValue(body.image_rules || body.imageRules),
      title: String(body.title || editablePayload.title || "").trim(),
      description: String(body.description || editablePayload.description || "").trim(),
      attributes,
      images,
      editable_payload: {
        ...editablePayload,
        attributes,
        images
      }
    };
  }
  const draft = prepareListingDraftFromCollectedSource(body, { sourceType: "ozon_frontend_collect" });
  return listingDraftToTemplatePayload(draft, body);
}

function buildTemplatePayloadFromCollectedProductLegacy(body = {}) {
  const source = unwrapCollectedPayload(body);
  const editPayload = objectValue(source.editPayload || source.edit_payload || source.editable_payload || {});
  const followPayload = objectValue(source.followEditPayload || source.follow_edit_payload || editPayload.followEditPayload || {});
  const rows = collectCollectedVariantRows(source, editPayload, followPayload);
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
  const variants = rows.length ? rows.map((item, index) => normalizeCollectedVariant({
    ...item,
    images: collectedVariantImages(item, images, rows.length > 1)
  }, source, dimensions, hashtags, index)) : [
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
  const rawCategoryIds = Array.isArray(source.category_ids) ? source.category_ids : [];
  const inferredDescriptionCategoryId = source.category2Id || (rawCategoryIds.length >= 3 ? rawCategoryIds[rawCategoryIds.length - 2] : "");
  const inferredTypeId = source.category3Id || (rawCategoryIds.length >= 3 ? rawCategoryIds[rawCategoryIds.length - 1] : "");
  const descriptionCategoryId = String(
    body.description_category_id ||
    body.descriptionCategoryId ||
    editPayload.description_category_id ||
    editPayload.descriptionCategoryId ||
    (body.type_id || body.typeId || source.type_id || source.typeId || editPayload.type_id || editPayload.typeId ? (source.description_category_id || source.descriptionCategoryId) : "") ||
    inferredDescriptionCategoryId ||
    ""
  ).trim();
  const typeId = String(body.type_id || body.typeId || source.type_id || source.typeId || editPayload.type_id || editPayload.typeId || inferredTypeId || "").trim();
  const legacyCategoryId = String(source.ozon_category_id || source.category_id || editPayload.category_id || "").trim();
  const fallbackCategoryId = buildOzonCategoryKey({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    category_id: legacyCategoryId,
    fallback: `frontend:${sku || source.collectionId || source.id || Date.now()}`
  });
  const categoryId = descriptionCategoryId || legacyCategoryId || fallbackCategoryId;
  const categoryName = String(body.category_name || body.categoryName || source.category || source.category_name || source.categoryName || (categoryId ? `Ozon 绫荤洰 ${categoryId}` : "")).trim();
  const enrichedAttributes = enrichTemplateAttributes(attributes, {
    title,
    brand: attributeValueByNames(attributes, ["Brand", "Бренд"], [85]) || source.brand || "No brand",
    model: attributeValueByNames(attributes, ["鍨嬪彿", "袦芯写械谢褜"], [9048]) || rows[0]?.spec || "",
    tags: hashtags,
    description,
    richJson: richText
  });
  return {
    ozon_category_id: fallbackCategoryId,
    category_name: categoryName || "Ozon 鍓嶅彴閲囬泦妯℃澘",
    template_name: String(body.template_name || body.templateName || source.local_template_name || source.template_name || title || `Ozon ${sku} 閲囬泦妯℃澘`).trim(),
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
      category_name: categoryName || "Ozon 鍓嶅彴閲囬泦妯℃澘",
      price: {
        value: numberFromOzonValue(source.price || editPayload.price || rows[0]?.price || 0),
        old_price: numberFromOzonValue(source.originalPrice || source.old_price || rows[0]?.old_price || 0),
        currency_code: source.currency || editPayload.currency || followPayload.currecny || "RUB",
        vat: String(source.vat || editPayload.vat || "0")
      },
      dimensions,
      logistics: {
        brand: attributeValueByNames(enrichedAttributes, ["Brand", "Бренд"], [85]) || "No brand",
        color: attributeValueByNames(enrichedAttributes, ["棰滆壊", "笑胁械褌"], [8229]) || "",
        spec: attributeValueByNames(enrichedAttributes, ["鍨嬪彿", "袦芯写械谢褜"], [9048]) || "",
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
  const dimensionUnit = String(dims.unit || firstValue("dimension_unit", "dimensions_unit", "unit") || "").toLowerCase();
  const cmValue = (cm, mmFallback) => {
    const directCm = numberFromOzonValue(cm);
    if (directCm) return directCm;
    const mm = normalizeDimensionToMm(mmFallback, dimensionUnit);
    return mm ? Number((mm / 10).toFixed(2)) : 0;
  };
  return {
    length_cm: cmValue(firstValue("length_cm") || dims.length_cm, firstValue("length_mm", "depth", "length") || dims.depth || dims.length || parsedDims.length || 0),
    width_cm: cmValue(firstValue("width_cm") || dims.width_cm, firstValue("width_mm", "width") || dims.width || parsedDims.width || 0),
    height_cm: cmValue(firstValue("height_cm") || dims.height_cm, firstValue("height_mm", "height") || dims.height || parsedDims.height || 0),
    weight_g: numberFromOzonValue(firstValue("weight_g", "weight", "custom_weight") || 0)
  };
}

function parseCollectedDimensionText(value) {
  if (!value || typeof value === "object") return {};
  const text = String(value).replace(/,/g, ".").replace(/\s+/g, "");
  const match = text.match(/(\d+(?:\.\d+)?)[xX脳*](\d+(?:\.\d+)?)[xX脳*](\d+(?:\.\d+)?)/);
  if (!match) return {};
  return {
    length: Number(match[1]) || 0,
    width: Number(match[2]) || 0,
    height: Number(match[3]) || 0
  };
}

function normalizeCollectedVariant(item = {}, source = {}, dimensions = {}, tags = [], index = 0) {
  const rowDimensions = normalizeCollectedDimensions(item, dimensions);
  const rowAttributes = normalizeAttributes(item.attributes || item.attribute_values || item.characteristics || []);
  const dynamicAttributes = mergeCollectedDynamicAttributes(
    collectedAttributesToDynamicAttributes(rowAttributes),
    item.dynamic_attributes,
    item.dynamicAttributes
  );
  const imageValues = dedupeImagesByUrl(normalizeImages([
    item.cover_image || item.coverImage || item.primary_image || item.mainImage || "",
    ...(normalizeArray(item.images || item.image_urls || item.imageUrls))
  ]));
  const fallbackImages = dedupeImagesByUrl(normalizeImages(source.images || source.image_urls || source.imageUrls || source.productImage || source.mainImage || []));
  const images = imageValues.length ? imageValues : fallbackImages;
  const sku = String(item.sku || item.source_sku || "").trim();
  return {
    sku,
    source_sku: sku,
    source_offer_id: String(item.source_offer_id || item.seller_offer_id || item.offer_id || "").trim(),
    offer_id: "",
    name: String(item.name || item.title || source.title || "").trim(),
    title: String(item.title || item.name || source.title || "").trim(),
    images,
    video_cover_urls: normalizeStringList(item.video_cover_urls || item.cover_video_urls || item.cover_video || item.video_cover),
    video_urls: normalizeStringList(item.video_urls || item.videos || item.videoUrls || item.video_url),
    barcode: String(item.barcode || normalizeArray(item.barcodes)[0] || "").trim(),
    cost_price: 0,
    price: numberFromOzonValue(item.price || item.sell_price || item.cardPrice || source.price || 0),
    old_price: numberFromOzonValue(item.old_price || item.originalPrice || 0),
    color: String(item.color || "").trim(),
    spec: String(item.spec || item.searchable_text || "").trim(),
    main_tags: normalizeTagList(item.hashtags || item.main_tags || tags),
    attributes: rowAttributes,
    dynamic_attributes: dynamicAttributes,
    weight_g: rowDimensions.weight_g || dimensions.weight_g || 0,
    length_cm: rowDimensions.length_cm || dimensions.length_cm || 0,
    width_cm: rowDimensions.width_cm || dimensions.width_cm || 0,
    height_cm: rowDimensions.height_cm || dimensions.height_cm || 0,
    length_mm: Math.round(Number(rowDimensions.length_cm || dimensions.length_cm || 0) * 10),
    width_mm: Math.round(Number(rowDimensions.width_cm || dimensions.width_cm || 0) * 10),
    height_mm: Math.round(Number(rowDimensions.height_cm || dimensions.height_cm || 0) * 10),
    stock: Number(item.stock || item.quantity || 0),
    sort_order: Number(item.sort_order || index + 1)
  };
}

async function repairCollectedVariantColorAxis(normalized = {}) {
  const variants = normalizeArray(normalized?.templatePayload?.editable_payload?.variants);
  if (variants.length < 2) return normalized;
  const specs = variants.map((variant) => String(variant.spec || variant.searchable_text || variant.searchableText || "").trim());
  const specKeys = specs.filter(Boolean);
  if (new Set(specKeys).size < 2) return normalized;
  const tokensByVariant = specs.map(splitCollectedColorTokens);
  const tokens = [...new Set(tokensByVariant.flat())];
  if (!tokens.length) return normalized;
  const dictionary = await loadCollectedColorDictionaryIndex({
    descriptionCategoryId: normalized?.category?.description_category_id || normalized?.templatePayload?.editable_payload?.description_category_id || normalized?.payload?.description_category_id,
    typeId: normalized?.category?.type_id || normalized?.templatePayload?.editable_payload?.type_id || normalized?.payload?.type_id,
    tokens
  });
  if (!dictionary.size) return normalized;
  let repaired = 0;
  const nextVariants = variants.map((variant, index) => {
    const selected = tokensByVariant[index].map((token) => dictionary.get(normalizeCollectedColorToken(token))).filter(Boolean);
    if (!selected.length) return variant;
    const dynamic = objectValue(variant.dynamic_attributes || variant.dynamicAttributes);
    const current = dynamic["10096"];
    if (current && !shouldReplaceCollectedColorAttribute(current, selected)) return variant;
    repaired += 1;
    return {
      ...variant,
      dynamic_attributes: {
        ...dynamic,
        10096: {
          attribute_id: "10096",
          name: "棰滆壊",
          attribute_name: "棰滆壊",
          value: selected.map((item) => item.value).join(", "),
          values: selected,
          selected_values: selected,
          label: selected.map((item) => item.display_value_zh || item.label || item.value).filter(Boolean).join(", "),
          display_value_zh: selected.map((item) => item.display_value_zh || item.label || item.value).filter(Boolean).join(", "),
          type: selected.length > 1 ? "multiselect" : "select",
          source: "collector_variant_spec_dictionary_repair"
        }
      }
    };
  });
  if (!repaired) return normalized;
  applyRepairedCollectedVariants(normalized, nextVariants);
  return normalized;
}

function splitCollectedColorTokens(value = "") {
  return String(value || "")
    .split(/[,\uFF0C;锛?|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter(isCollectedColorToken);
}

function normalizeCollectedColorToken(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isCollectedColorToken(value = "") {
  const text = normalizeCollectedColorToken(value);
  if (!text) return false;
  return [
    "斜械谢", "褔械褉薪", "褔褢褉薪", "褋械褉", "褋械褉械斜", "蟹芯谢芯褌", "泻芯褉懈褔", "斜械卸", "锌褉芯蟹褉邪褔", "褏褉芯屑", "蟹械褉泻", "屑械褌邪谢谢懈泻",
    "泻褉邪褋薪", "褋懈薪", "谐芯谢褍斜", "蟹械谢械薪", "蟹械谢褢薪", "卸械谢褌", "卸褢谢褌", "芯褉邪薪卸", "褉芯蟹", "褎懈芯谢械褌", "斜褉芯薪蟹", "屑械写褜",
    "black", "white", "gray", "grey", "silver", "gold", "brown", "beige", "transparent", "chrome", "mirror"
  ].some((keyword) => text.includes(keyword));
}

async function loadCollectedColorDictionaryIndex({ descriptionCategoryId = 0, typeId = 0, tokens = [] } = {}) {
  const normalizedTokens = [...new Set(normalizeArray(tokens).map(normalizeCollectedColorToken).filter(Boolean))];
  if (!normalizedTokens.length) return new Map();
  const likeConditions = normalizedTokens.flatMap(() => [
    "LOWER(value) = ?",
    "LOWER(display_value_zh) = ?"
  ]).join(" OR ");
  const params = normalizedTokens.flatMap((token) => [token, token]);
  const scopedRows = Number(descriptionCategoryId || 0) && Number(typeId || 0)
    ? await all(`
      SELECT description_category_id, type_id, attribute_id, dictionary_value_id, value, display_value_zh
      FROM ozon_attribute_values
      WHERE status = 'active'
        AND description_category_id = ?
        AND type_id = ?
        AND attribute_id = 10096
        AND (${likeConditions})
      LIMIT 500
    `, [Number(descriptionCategoryId), Number(typeId), ...params]).catch(() => [])
    : [];
  const globalRows = await all(`
    SELECT description_category_id, type_id, attribute_id, dictionary_value_id, value, display_value_zh
    FROM ozon_attribute_values
    WHERE status = 'active'
      AND attribute_id = 10096
      AND (${likeConditions})
    ORDER BY description_category_id = ? DESC, type_id = ? DESC, dictionary_value_id ASC
    LIMIT 1000
  `, [...params, Number(descriptionCategoryId || 0), Number(typeId || 0)]).catch(() => []);
  const byToken = new Map();
  for (const row of [...globalRows, ...scopedRows]) {
    const option = normalizeOzonAttributeValueRow(row);
    const keys = [option.value, option.display_value_zh, option.label].map(normalizeCollectedColorToken).filter(Boolean);
    for (const key of keys) {
      if (!byToken.has(key)) byToken.set(key, option);
    }
  }
  return byToken;
}

function shouldReplaceCollectedColorAttribute(current = {}, selected = []) {
  const currentValues = normalizeArray(current.selected_values || current.selectedValues || current.values || current.value)
    .map((item) => normalizeCollectedColorToken(item?.value || item?.label || item?.display_value_zh || item))
    .filter(Boolean);
  const nextValues = selected.map((item) => normalizeCollectedColorToken(item.value || item.label || item.display_value_zh)).filter(Boolean);
  if (!currentValues.length) return true;
  if (!nextValues.length) return false;
  return currentValues.join("|") !== nextValues.join("|");
}

function applyRepairedCollectedVariants(normalized = {}, variants = []) {
  if (normalized.templatePayload?.editable_payload) normalized.templatePayload.editable_payload.variants = variants;
  if (normalized.draft?.editablePayload) normalized.draft.editablePayload.variants = variants;
  if (normalized.draft) normalized.draft.variants = variants;
  if (normalized.payload) normalized.payload.variants = variants;
  if (normalized.templatePayload?.source_raw?.normalization_diagnostics) {
    normalized.templatePayload.source_raw.normalization_diagnostics.variant_color_repair = true;
  }
  if (normalized.templatePayload?.editable_payload?.normalization_diagnostics) {
    normalized.templatePayload.editable_payload.normalization_diagnostics.variant_color_repair = true;
  }
}

function collectedAttributesToDynamicAttributes(attributes = []) {
  const result = {};
  for (const item of normalizeAttributes(attributes)) {
    const key = String(item.attribute_id || item.name || "").trim();
    if (!key || item.value === undefined || item.value === null || item.value === "") continue;
    result[key] = {
      attribute_id: item.attribute_id || "",
      name: item.name || "",
      value: item.value,
      values: item.values || [],
      dictionary_id: item.dictionary_id || "",
      type: item.type || "text",
      source: item.source || "variant_attribute"
    };
  }
  return result;
}

function mergeCollectedDynamicAttributes(...sources) {
  return Object.assign({}, ...sources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};
    return source;
  }));
}

function collectedVariantImages(item = {}, productImages = [], multiVariant = false) {
  const ownImages = dedupeImagesByUrl(normalizeImages([
    item.cover_image || item.coverImage || item.primary_image || item.primaryImage || item.main_image || item.mainImage || "",
    ...(normalizeArray(item.images || item.image_urls || item.imageUrls))
  ]));
  if (ownImages.length) return ownImages;
  const normalizedProductImages = dedupeImagesByUrl(normalizeImages(productImages || []));
  if (!multiVariant) return normalizedProductImages;
  return normalizedProductImages.slice(0, 1);
}

function dedupeImagesByUrl(images = []) {
  const seen = new Set();
  return normalizeArray(images).filter((image) => {
    const url = String(image?.url || image || "").trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function collectCollectedVariantRows(source = {}, editPayload = {}, followPayload = {}) {
  const payload = objectValue(source.payload || source.rawPayload || {});
  const normalized = objectValue(source.normalized || {});
  const nestedFollow = objectValue(source.followEditPayload || source.follow_edit_payload || editPayload.followEditPayload || editPayload.follow_edit_payload || payload.followEditPayload || payload.follow_edit_payload || normalized.followEditPayload || {});
  const sellerVariantBySku = collectSellerVariantBySku(source, editPayload, payload, normalized, nestedFollow);
  const rows = [
    ...normalizeArray(source.editorVariants || source.editor_variants || editPayload.editorVariants || editPayload.editor_variants || payload.editorVariants || normalized.editorVariants),
    ...normalizeArray(source.rows || editPayload.rows || followPayload.rows || nestedFollow.rows || payload.rows || normalized.rows),
    ...normalizeArray(source.variants || source.variantRows || source.productVariants || source.skuVariants || source.offerVariants || editPayload.variants || payload.variants || normalized.variants),
    ...normalizeArray(source.offers || source.children || source.products || payload.offers || payload.products),
    ...normalizeArray(source.skus).map((item) => typeof item === "string" ? { sku: item } : item)
  ];
  const byKey = new Map();
  for (const row of rows) {
    const key = String(row?.sku || row?.source_sku || row?.offer_id || row?.variantId || row?.variant_id || row?.id || "").trim();
    if (!key) continue;
    const normalizedRow = mergeSellerVariantPatch({ ...row, sku: row.sku || row.source_sku || key }, sellerVariantBySku[key]);
    const previous = byKey.get(key);
    byKey.set(key, previous ? mergeCollectedVariantRow(previous, normalizedRow) : normalizedRow);
  }
  return [...byKey.values()];
}

function collectSellerVariantBySku(...sources) {
  const result = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [sku, patch] of Object.entries(objectValue(source.sellerVariantBySku || source.seller_variant_by_sku))) {
      if (sku && patch && typeof patch === "object") result[String(sku).trim()] = patch;
    }
    for (const [sku, fallback] of Object.entries(objectValue(source.variantSellerFallbacks || source.variant_seller_fallbacks))) {
      const fields = objectValue(fallback?.fields || fallback);
      if (sku && Object.keys(fields).length) result[String(sku).trim()] = { ...(result[String(sku).trim()] || {}), ...fields };
    }
  }
  return result;
}

function mergeSellerVariantPatch(row = {}, patch = {}) {
  if (!patch || typeof patch !== "object") return row;
  const attributes = mergeAttributesByKey(row.attributes || row.attribute_values || row.characteristics || [], patch.attributes || []);
  return {
    ...row,
    ...(patch.variantId ? { variantId: patch.variantId } : {}),
    ...(patch.variantName ? { variantName: patch.variantName } : {}),
    ...(patch.origin_variant_id ? { origin_variant_id: patch.origin_variant_id } : {}),
    ...(patch.bundle_id ? { bundle_id: patch.bundle_id } : {}),
    ...(patch.barcode && !row.barcode ? { barcode: patch.barcode } : {}),
    attributes: attributes.length ? attributes : row.attributes
  };
}

function mergeAttributesByKey(...sources) {
  const byKey = new Map();
  for (const attr of sources.flatMap((source) => normalizeArray(source))) {
    if (!attr || typeof attr !== "object") continue;
    const key = String(attr.attribute_id || attr.attributeId || attr.id || attr.name || attr.attribute_name || "").trim();
    if (!key) continue;
    byKey.set(key, { ...(byKey.get(key) || {}), ...attr });
  }
  return [...byKey.values()];
}

function mergeCollectedVariantRow(previous = {}, next = {}) {
  const merged = { ...previous, ...next };
  for (const key of ["images", "image_urls", "imageUrls", "video_urls", "videos", "attributes", "attribute_values", "characteristics", "hashtags"]) {
    const previousList = normalizeArray(previous[key]);
    const nextList = normalizeArray(next[key]);
    if (previousList.length || nextList.length) merged[key] = dedupeLooseList([...previousList, ...nextList]);
  }
  merged.dynamic_attributes = mergeCollectedDynamicAttributes(previous.dynamic_attributes, previous.dynamicAttributes, next.dynamic_attributes, next.dynamicAttributes);
  for (const key of ["title", "name", "cover_image", "coverImage", "primary_image", "primaryImage", "main_image", "mainImage", "searchable_text", "searchableText"]) {
    merged[key] = next[key] || previous[key] || "";
  }
  return merged;
}

function dedupeLooseList(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = typeof value === "object" ? JSON.stringify(value) : String(value || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeTagList(value) {
  return normalizeStringList(value).map((item) => item.startsWith("#") ? item : `#${item}`);
}

function containsCjk(value = "") {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function publishOzonTagList(item = {}) {
  const text = [item.name, item.title, item.description, normalizeStringList(item.tags).join(" ")].join(" ");
  const base = normalizeTagList(item.tags)
    .filter((tag) => !containsCjk(tag))
    .filter((tag) => tag.length > 1);
  const additions = [];
  if (/泻谢褞褔|key|斜褉械谢芯泻|tenet|t4|t7|t8/i.test(text)) {
    additions.push(
      "#褔械褏芯谢_写谢褟_泻谢褞褔邪",
      "#邪胁褌芯屑芯斜懈谢褜薪褘泄_泻谢褞褔",
      "#蟹邪褖懈褌邪_泻谢褞褔邪",
      "#泻谢褞褔_TENET",
      "#TENET_T4",
      "#TENET_T4L",
      "#TPU_褔械褏芯谢",
      "#褔械褉薪褘泄_褔械褏芯谢",
      "#邪泻褋械褋褋褍邪褉褘_写谢褟_邪胁褌芯",
      "#蟹邪褖懈褌薪褘泄_褔械褏芯谢"
    );
  }
  return uniqueStringValues([...base, ...additions]).slice(0, 20);
}

function splitLooseStringList(value) {
  return String(value || "").split(/[,\uFF0C;\uFF1B\u3001\r\n]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeStringList(value) {
  if (!Array.isArray(value) && !(value && typeof value === "object")) return splitLooseStringList(value);
  if (Array.isArray(value)) return value.flatMap((item) => normalizeStringList(item));
  if (value && typeof value === "object") return normalizeStringList(value.value || value.name || value.text || "");
  return splitLooseStringList(value);
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

async function ensureListingMediaPublicUrl({
  localPath = "",
  localUrl = "",
  publishUrl = "",
  filename = "upload",
  contentType = "application/octet-stream",
  metadata = {},
  skipPublicSync = false
} = {}) {
  const traceId = String(metadata.save_trace_id || metadata.saveTraceId || "").trim();
  const startedAt = Date.now();
  const targetUrl = String(publishUrl || "").trim();
  if (!targetUrl) {
    logAiVariantSavePerf(traceId, "backend.media.public_url", startedAt, { status: "no_target", localUrl });
    return "";
  }
  if (await isReachableRemoteMediaUrl(targetUrl)) {
    logAiVariantSavePerf(traceId, "backend.media.public_url", startedAt, { status: "already_reachable", publishUrl: targetUrl.slice(0, 180) });
    return targetUrl;
  }
  if (skipPublicSync) {
    logAiVariantSavePerf(traceId, "backend.media.public_url", startedAt, { status: "skip_sync", publishUrl: targetUrl.slice(0, 180) });
    return "";
  }
  const syncedUrl = await syncListingMediaFileToPublicBase({
    localPath,
    localUrl,
    publishUrl: targetUrl,
    filename,
    contentType,
    metadata
  });
  const reachable = Boolean(syncedUrl && await isReachableRemoteMediaUrl(syncedUrl));
  logAiVariantSavePerf(traceId, "backend.media.public_url", startedAt, {
    status: reachable ? "synced_reachable" : "sync_unreachable",
    publishUrl: String(syncedUrl || targetUrl).slice(0, 180)
  });
  return reachable ? syncedUrl : "";
}

async function syncListingMediaFileToPublicBase({
  localPath = "",
  localUrl = "",
  publishUrl = "",
  filename = "upload",
  contentType = "application/octet-stream",
  metadata = {}
} = {}) {
  const traceId = String(metadata.save_trace_id || metadata.saveTraceId || "").trim();
  const startedAt = Date.now();
  const token = String(config.localPluginPublicToken || "").trim();
  if (!token || !localPath || !publishUrl || isLocalImportMedia(publishUrl)) {
    logAiVariantSavePerf(traceId, "backend.media.public_sync", startedAt, {
      status: "skipped",
      hasToken: Boolean(token),
      hasLocalPath: Boolean(localPath),
      hasPublishUrl: Boolean(publishUrl)
    });
    return "";
  }
  try {
    const target = new URL("/api/listing/media/public-upload", publishUrl);
    target.searchParams.set("token", token);
    const buffer = await fs.readFile(localPath);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: contentType }), sanitizeListingMediaFilename(filename));
    form.append("skip_public_sync", "1");
    form.append("source_module", String(metadata.source_module || "listing_public_sync"));
    form.append("source_id", String(metadata.source_id || localUrl || ""));
    form.append("batch_id", String(metadata.batch_id || ""));
    form.append("shop_id", String(metadata.shop_id || ""));
    form.append("variant_id", String(metadata.variant_id || ""));
    form.append("role", String(metadata.role || "asset"));
    const response = await fetch(target, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      console.warn("listing media public sync failed:", response.status, payload?.error || payload?.message || "");
      logAiVariantSavePerf(traceId, "backend.media.public_sync", startedAt, {
        status: "failed_response",
        httpStatus: response.status,
        message: payload?.error || payload?.message || ""
      });
      return "";
    }
    const nextUrl = String(payload.publishUrl || payload.url || "").trim();
    logAiVariantSavePerf(traceId, "backend.media.public_sync", startedAt, {
      status: "ok",
      publishUrl: nextUrl.slice(0, 180)
    });
    return nextUrl;
  } catch (error) {
    console.warn("listing media public sync failed:", error?.message || error);
    logAiVariantSavePerf(traceId, "backend.media.public_sync", startedAt, {
      status: error?.name === "TimeoutError" ? "timeout" : "error",
      message: error?.message || String(error)
    });
    return "";
  }
}

async function isReachableRemoteMediaUrl(url = "") {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const response = await fetch(value, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    if (response.ok) return true;
    const rangeResponse = await fetch(value, {
      method: "GET",
      headers: { Range: "bytes=0-1023" },
      signal: AbortSignal.timeout(15000)
    }).catch(() => null);
    return Boolean(rangeResponse?.ok || rangeResponse?.status === 206);
  } catch {
    return false;
  }
}

async function unreachablePublishMediaUrls(urls = []) {
  const remoteUrls = uniqueStringValues(normalizeArray(urls)
    .map((url) => String(url || "").trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .filter(isListingMediaPublicUrl));
  if (!remoteUrls.length) return [];
  const checks = await Promise.all(remoteUrls.slice(0, 12).map(async (url) => {
    try {
      if (await isReachableRemoteMediaUrl(url)) return null;
      return `${url} (unreachable)`;
    } catch (error) {
      return `${url} (${error.message || "unreachable"})`;
    }
  }));
  return checks.filter(Boolean);
}

function uniqueStringValues(values = []) {
  return [...new Set(normalizeArray(values).map((item) => String(item || "").trim()).filter(Boolean))];
}

function isListingMediaPublicUrl(url = "") {
  const publicBase = String(config.listingMediaPublicBaseUrl || config.publicMediaBaseUrl || "").trim();
  if (!publicBase) return false;
  try {
    const left = new URL(url);
    const right = new URL(publicBase);
    return left.origin === right.origin && left.pathname.startsWith("/uploads/listing-media/");
  } catch {
    return false;
  }
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
  const safeDescription = sanitizeOzonBuyerDescription(facts.description);
  const safeRichContent = sanitizeOzonRichContentJson(facts.richContent || "", safeDescription);
  const attrs = facts.attributes
    .filter((item) => item.attribute_id && normalizeAttributeValue(item.value))
    .filter((item) => !isSchemaPlaceholderAttributeValue(item))
    .map((item) => Number(item.attribute_id) === 4191 ? { ...item, value: sanitizeOzonBuyerDescription(item.value || safeDescription) } : item)
    .map((item) => Number(item.attribute_id) === 11254 ? { ...item, value: sanitizeOzonRichContentJson(item.value || safeRichContent, safeDescription) } : item)
    .map((item) => ({
      id: Number(item.attribute_id),
      values: normalizeAttributeValuesForOzon(item)
    }));
  if (safeRichContent && !attrs.some((item) => Number(item.id || 0) === 11254)) {
    attrs.push({
      id: 11254,
      values: [{ value: safeRichContent }]
    });
  }
  const previewTags = publishOzonTagList({ ...facts, name: facts.title, description: safeDescription, tags: facts.tags });
  if (previewTags.length) setOzonAttributeValues(attrs, 23171, previewTags.map((value) => ({ value })));
  const variants = facts.variants.length ? facts.variants : [{ title: facts.title, images: facts.images }];
  return {
    items: variants.map((variant, index) => {
      const variantImages = normalizeImages(variant.images || []).map((item) => item.url).filter(Boolean);
      const finalImages = variantImages.length ? variantImages : baseImages;
      const primaryImage = finalImages[0] || "";
      const itemAttributes = mergeOzonAttributes(attrs, normalizeVariantAttributesForOzon(variant));
      return {
        offer_id: String(variant.offer_id || variant.sku || `NEW-OFFER-${index + 1}`).trim(),
        name: String(variant.title || facts.title || "").trim(),
        price: String(numberFromOzonValue(variant.price || facts.price.value || 0)),
        old_price: String(numberFromOzonValue(variant.old_price || facts.price.old_price || facts.price.value || 0)),
        price_strategy_mode: resolveOzonPriceStrategyMode(variant, facts.price),
        price_strategy_applied: Boolean(variant.price_strategy_applied || variant.priceStrategyApplied || facts.price.strategy_applied || facts.price.strategyApplied),
        ...(facts.price.currency_code ? { currency_code: facts.price.currency_code } : {}),
        vat: String(facts.price.vat || "0"),
        description_category_id: Number(facts.descriptionCategoryId || 0) || undefined,
        type_id: Number(facts.typeId || 0) || undefined,
        depth: Number(variant.length_mm || cmToMm(facts.dimensions.length_cm) || 0),
        width: Number(variant.width_mm || cmToMm(facts.dimensions.width_cm) || 0),
        height: Number(variant.height_mm || cmToMm(facts.dimensions.height_cm) || 0),
        dimension_unit: "mm",
        weight: Number(variant.weight_g || facts.dimensions.weight_g || 0),
        weight_unit: "g",
        primary_image: primaryImage,
        images: finalImages.filter((url) => url !== primaryImage),
        description: sanitizeOzonBuyerDescription(variant.description || safeDescription),
        tags: normalizeArray(variant.tags || variant.main_tags || variant.hashtags || facts.tags),
        color: String(variant.color || facts.color || "").trim(),
        material: String(variant.material || facts.material || "").trim(),
        quantity: String(variant.quantity || facts.quantity || "").trim(),
        vehicle_brand: String(variant.vehicle_brand || facts.vehicleBrand || "").trim(),
        vehicle_model: String(variant.vehicle_model || facts.vehicleModel || "").trim(),
        attributes: itemAttributes,
        complex_attributes: buildOzonComplexAttributesPreview(variant, facts)
      };
    })
  };
}

function mergeOzonAttributes(baseAttributes = [], variantAttributes = []) {
  const byId = new Map();
  normalizeArray(baseAttributes).forEach((attr) => {
    const id = Number(attr.id || attr.attribute_id || 0);
    if (id) byId.set(id, attr);
  });
  normalizeArray(variantAttributes).forEach((attr) => {
    const id = Number(attr.id || attr.attribute_id || 0);
    const values = normalizeArray(attr.values).filter((value) => String(value?.value ?? value ?? "").trim());
    if (id && values.length) byId.set(id, { ...attr, id, values });
  });
  return [...byId.values()];
}

function setOzonAttributeValues(attributes = [], id, values = []) {
  const index = attributes.findIndex((attr) => Number(attr.id || attr.attribute_id || 0) === Number(id));
  const next = { id: Number(id), values: normalizeArray(values).filter((value) => String(value?.value ?? value ?? "").trim()) };
  if (!next.values.length) return attributes;
  if (index >= 0) attributes[index] = next;
  else attributes.push(next);
  return attributes;
}

function isSchemaPlaceholderAttributeValue(item = {}) {
  const valueText = normalizeTranslationSource(normalizeAttributeValue(item.value));
  if (!valueText) return false;
  const names = [
    item.name,
    item.name_zh,
    item.attribute_name,
    item.attributeName,
    item.raw?.definition?.name,
    item.raw?.definition?.name_zh,
    item.raw?.definition?.attribute_name
  ].map((value) => normalizeTranslationSource(value)).filter(Boolean);
  return names.some((name) => name && valueText === name);
}

function normalizeVariantAttributesForOzon(variant = {}) {
  const direct = normalizeArray(variant.attributes);
  const dynamic = normalizeDynamicVariantAttributeEntries(variant.dynamic_attributes || variant.dynamicAttributes);
  return [...direct, ...dynamic]
    .map((attr) => {
      const id = Number(attr.id || attr.attribute_id || attr.attributeId || 0);
      const rawValues = normalizeArray(selectedAttributeValuesForOzon(attr));
      const values = rawValues
        .map((value) => (typeof value === "object" && value !== null ? value : { value }))
        .filter((value) => String(value.value ?? value.name ?? "").trim());
      return { id, values };
    })
    .filter((attr) => attr.id && attr.values.length);
}

function normalizeDynamicVariantAttributeEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, entry]) => {
    if (entry && typeof entry === "object") {
      return {
        ...entry,
        attribute_id: entry.attribute_id || entry.attributeId || (/^\d+$/.test(String(key)) ? key : "")
      };
    }
    return {
      attribute_id: /^\d+$/.test(String(key)) ? key : "",
      value: entry
    };
  });
}

function sanitizeOzonBuyerDescription(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text
    .replace(/\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435\s+\u043E\u0441\u043E\u0431\u0435\u043D\u043D\u043E\u0441\u0442\u0438\s*:\s*[^.?!]+[.?!]?/giu, "")
    .replace(/\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435\s+\u0441\u043B\u043E\u0432\u0430\s*:\s*[^.?!]+[.?!]?/giu, "")
    .replace(/\u0422\u0435\u0433\u0438\s*:\s*[^.?!]+[.?!]?/giu, "")
    .replace(/\u0425\u044D\u0448\u0442\u0435\u0433\u0438\s*:\s*[^.?!]+[.?!]?/giu, "");
  text = text.replace(/#[\p{L}\p{N}_-]+/gu, "");
  text = text
    .replace(/\u0430\u0432\u0442\u043E\u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440\u044B[,;\s]*/giu, "")
    .replace(/\u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440_\u0432_\u0430\u0432\u0442\u043E[,;\s]*/giu, "")
    .replace(/\u0431\u0440\u0435\u043B\u043E\u043A_\u0430\u0432\u0442\u043E[,;\s]*/giu, "")
    .replace(/\u043F\u043E\u0434\u0430\u0440\u043E\u043A_\u0432\u043E\u0434\u0438\u0442\u0435\u043B\u044E[,;\s]*/giu, "");
  text = text.replace(/\s*,\s*,+/g, ", ").replace(/\s+([,.!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  return text;
}

function sanitizeOzonRichContentJson(value, fallbackDescription = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    visitRichContentText(parsed, (text) => sanitizeOzonBuyerDescription(text || fallbackDescription));
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

function visitRichContentText(node, replacer) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => visitRichContentText(item, replacer));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(node, "content") && typeof node.content === "string") {
    node.content = replacer(node.content);
  }
  for (const value of Object.values(node)) visitRichContentText(value, replacer);
}

async function applyShopPublishDefaults(payload = {}, shop = {}) {
  const currencyCode = await resolveShopCurrencyCode(shop.id);
  return {
    ...payload,
    items: await Promise.all(normalizeArray(payload.items).map(async (item) => applyOzonPriceStrategy({
      ...item,
      description: sanitizeOzonBuyerDescription(item.description),
      currency_code: item.currency_code || currencyCode || "CNY",
      complex_attributes: normalizeOzonComplexAttributesForPublish(item.complex_attributes),
      attributes: await normalizeOzonDictionaryAttributes({
        ...item,
        description: sanitizeOzonBuyerDescription(item.description),
        attributes: sanitizeOzonPayloadAttributes(item.attributes)
      }, shop)
    })))
  };
}

function normalizeShopTextVariantPolicy(policy = {}, shops = []) {
  const enabled = Boolean(policy.enabled || policy.enable || policy.generate);
  const shopIds = normalizeArray(shops).map((shop) => Number(shop.id || shop.shop_id || 0)).filter(Boolean);
  const baseShopId = Number(policy.base_shop_id || policy.baseShopId || policy.base_shop || policy.baseShop || shopIds[0] || 0);
  const style = ["light", "ctr", "scene", "material"].includes(String(policy.style || "light"))
    ? String(policy.style || "light")
    : "light";
  const rawShopStyles = policy.shop_styles || policy.shopStyles || {};
  const shopStyles = {};
  for (const shopId of shopIds) {
    const rawStyle = String(rawShopStyles[String(shopId)] || rawShopStyles[shopId] || style || "light");
    shopStyles[String(shopId)] = ["light", "ctr", "scene", "material"].includes(rawStyle) ? rawStyle : style;
  }
  const fields = normalizeArray(policy.fields || ["title", "tags", "description"])
    .map((field) => String(field || "").trim())
    .filter((field) => ["title", "tags", "description"].includes(field));
  return {
    enabled: enabled && shopIds.length > 1 && fields.length > 0,
    baseShopId,
    style,
    shopStyles,
    fields: fields.length ? fields : ["title", "tags", "description"]
  };
}

function textVariantStyleForShop(policy = {}, shopId = 0) {
  const rawStyle = String(policy.shopStyles?.[String(shopId)] || policy.style || "light");
  return ["light", "ctr", "scene", "material"].includes(rawStyle) ? rawStyle : "light";
}

async function applyShopTextVariantToPayload(payload = {}, shop = {}, policy = {}) {
  const next = {
    ...payload,
    items: normalizeArray(payload.items).map((item) => ({
      ...item,
      attributes: normalizeArray(item.attributes).map((attr) => ({ ...attr, values: normalizeArray(attr.values).map((value) => ({ ...value })) }))
    }))
  };
  const shopId = Number(shop.id || shop.shop_id || 0);
  if (!policy.enabled || !shopId || Number(policy.baseShopId || 0) === shopId) {
    next.text_variant_summary = policy.enabled ? { enabled: true, shop_id: shopId, mode: "base_unchanged" } : null;
    return next;
  }
  const shopStyle = textVariantStyleForShop(policy, shopId);
  const shopPolicy = { ...policy, style: shopStyle };
  let changed = 0;
  const failures = [];
  for (const [index, item] of next.items.entries()) {
    try {
      const variant = await generateShopTextVariantForItem(item, shop, shopPolicy, index);
      changed += applyShopTextVariantToItem(item, variant, shopPolicy.fields);
    } catch (error) {
      failures.push(error.message || "鏂囨鍙樹綋鐢熸垚澶辫触");
    }
  }
  next.text_variant_summary = {
    enabled: true,
    shop_id: shopId,
    shop_name: shop.name || "",
    base_shop_id: Number(policy.baseShopId || 0),
    style: shopStyle,
    fields: policy.fields,
    changed,
    failures: failures.slice(0, 3)
  };
  return next;
}

async function generateShopTextVariantForItem(item = {}, shop = {}, policy = {}, index = 0) {
  const fallback = buildRuleBasedShopTextVariant(item, shop, policy, index);
  try {
    const result = await chatWithAiProvider({
      temperature: 0.35,
      maxTokens: 900,
      messages: [
        {
          role: "system",
          content: [
            "You rewrite Ozon Russia marketplace listing copy for one shop.",
            "Return valid JSON only with optional keys: title, tags, description.",
            "Do not change facts: product type, material, quantity, color, dimensions, compatible vehicle model, brand, SKU, offer_id, price, category, attributes.",
            "Do not add unsupported compatibility, warranty, certification, or brand claims.",
            "Russian buyer-facing copy must be natural and concise."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            shop: { id: shop.id, name: shop.name || "" },
            style: policy.style,
            allowedFields: policy.fields,
            original: {
              title: item.name || "",
              tags: normalizeArray(item.tags || publishOzonTagList(item)).slice(0, 20),
              description: item.description || "",
              color: item.color || "",
              material: item.material || "",
              quantity: item.quantity || "",
              vehicle_brand: item.vehicle_brand || "",
              vehicle_model: item.vehicle_model || "",
              category: item.category_name || "",
              offer_id: item.offer_id || ""
            }
          })
        }
      ]
    });
    const parsed = parseShopTextVariantResponse(result.content || "");
    return sanitizeShopTextVariant(parsed, item, fallback, policy.fields);
  } catch (error) {
    return fallback;
  }
}

function parseShopTextVariantResponse(content = "") {
  const raw = String(content || "").trim();
  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  const jsonText = objectStart >= 0 && objectEnd > objectStart ? raw.slice(objectStart, objectEnd + 1) : raw;
  return JSON.parse(jsonText);
}

function sanitizeShopTextVariant(input = {}, item = {}, fallback = {}, fields = []) {
  const next = {};
  if (fields.includes("title")) {
    const title = cleanText(input.title || "", 500);
    next.title = isAcceptableGeneratedListingText(title, item.name || "", 12) ? title : fallback.title;
  }
  if (fields.includes("tags")) {
    const tags = splitTagValue(input.tags || input.keywords || "").filter((tag) => !hasCjkText(tag)).slice(0, 20);
    next.tags = tags.length >= 4 ? tags : fallback.tags;
  }
  if (fields.includes("description")) {
    const description = sanitizeOzonBuyerDescription(input.description || input.summary || "");
    next.description = isAcceptableGeneratedListingText(description, item.description || "", 40) ? description : fallback.description;
  }
  return next;
}

function isAcceptableGeneratedListingText(value = "", original = "", minLength = 1) {
  const text = String(value || "").trim();
  if (text.length < minLength || hasCjkText(text)) return false;
  if (/walmart|amazon|wildberries|ozon\s+seller/i.test(text)) return false;
  const originalText = String(original || "").trim();
  if (originalText && text === originalText) return false;
  return true;
}

function hasCjkText(value = "") {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function buildRuleBasedShopTextVariant(item = {}, shop = {}, policy = {}, index = 0) {
  const style = String(policy.style || "light");
  const title = cleanText(item.name || "", 500);
  const tags = normalizeArray(item.tags || publishOzonTagList(item)).map((tag) => String(tag || "").trim()).filter(Boolean);
  const description = sanitizeOzonBuyerDescription(item.description || "");
  const suffixMap = {
    light: "锌褉邪泻褌懈褔薪褘泄 胁邪褉懈邪薪褌 写谢褟 械卸械写薪械胁薪芯谐芯 懈褋锌芯谢褜蟹芯胁邪薪懈褟",
    ctr: "斜褘褋褌褉邪褟 褍褋褌邪薪芯胁泻邪, 邪泻泻褍褉邪褌薪邪褟 锌芯褋邪写泻邪 懈 薪邪写械卸薪邪褟 蟹邪褖懈褌邪",
    scene: "锌芯写褏芯写懈褌 写谢褟 锌芯胁褋械写薪械胁薪褘褏 锌芯械蟹写芯泻, 褍褏芯写邪 蟹邪 褋邪谢芯薪芯屑 懈 蟹邪褖懈褌褘 写械褌邪谢械泄",
    material: "锌褉懈褟褌薪褘泄 屑邪褌械褉懈邪谢, 褍褋褌芯泄褔懈胁芯褋褌褜 泻 懈蟹薪芯褋褍 懈 邪泻泻褍褉邪褌薪褘泄 胁薪械褕薪懈泄 胁懈写"
  };
  const suffix = suffixMap[style] || suffixMap.light;
  return {
    title: title && !title.toLowerCase().includes(suffix.toLowerCase())
      ? cleanText(`${title}, ${suffix}`, 500)
      : title,
    tags: uniqueStringValues([
      ...tags,
      style === "ctr" ? "#斜褘褋褌褉邪褟_褍褋褌邪薪芯胁泻邪" : "",
      style === "ctr" ? "#蟹邪褖懈褌邪_邪胁褌芯" : "",
      style === "scene" ? "#写谢褟_械卸械写薪械胁薪褘褏_锌芯械蟹写芯泻" : "",
      style === "scene" ? "#邪泻褋械褋褋褍邪褉_胁_邪胁褌芯" : "",
      style === "material" ? "#懈蟹薪芯褋芯褋褌芯泄泻懈泄_屑邪褌械褉懈邪谢" : "",
      style === "material" ? "#邪泻泻褍褉邪褌薪褘泄_胁懈写" : ""
    ]).slice(0, 20),
    description: description
      ? cleanText(`${description} ${suffix[0].toUpperCase()}${suffix.slice(1)}.`, 1200)
      : cleanText(`${title}. ${suffix[0].toUpperCase()}${suffix.slice(1)}.`, 1200)
  };
}

function applyShopTextVariantToItem(item = {}, variant = {}, fields = []) {
  let changed = 0;
  if (fields.includes("title") && variant.title) {
    item.name = variant.title;
    changed += 1;
  }
  if (fields.includes("description") && variant.description) {
    item.description = sanitizeOzonBuyerDescription(variant.description);
    setOzonAttributeValues(item.attributes, 4191, [{ value: item.description }]);
    changed += 1;
  }
  if (fields.includes("tags") && normalizeArray(variant.tags).length) {
    const tags = splitTagValue(variant.tags).slice(0, 20);
    item.tags = tags;
    setOzonAttributeValues(item.attributes, 23171, tags.map((value) => ({ value })));
    changed += 1;
  }
  return changed;
}

async function prepareSafeShopOfferIds(payload = {}, { shop = {}, sourceRecordId = 0, updateExisting = false, sourceProductId = 0 } = {}) {
  const next = {
    ...payload,
    items: normalizeArray(payload.items).map((item) => ({ ...item }))
  };
  if (!next.items.length) return next;
  const shopId = Number(shop.id || shop.shop_id || 0);
  let preservedOfferId = "";
  if (updateExisting && sourceRecordId) {
    const current = await row("SELECT offer_id FROM listing_publish_records WHERE id = ? AND status <> 'deleted'", [Number(sourceRecordId)]);
    preservedOfferId = String(current?.offer_id || "").trim();
  }
  const usedInPayload = new Set();
  for (let index = 0; index < next.items.length; index += 1) {
    const item = next.items[index];
    if (preservedOfferId) {
      item.offer_id = preservedOfferId;
      usedInPayload.add(preservedOfferId);
      continue;
    }
    const rawOfferId = String(item.offer_id || "").trim();
    const conflict = rawOfferId
      ? await findListingOfferIdConflict(shopId, rawOfferId, { sourceRecordId })
      : null;
    if (rawOfferId && !conflict && !usedInPayload.has(rawOfferId)) {
      item.offer_id = rawOfferId;
      usedInPayload.add(rawOfferId);
      continue;
    }
    const generated = await generateUniqueListingOfferId({
      shopId,
      sourceProductId,
      index,
      used: usedInPayload
    });
    item.offer_id = generated;
    usedInPayload.add(generated);
  }
  return next;
}

export async function generateUniqueListingOfferId({ shopId = 0, sourceProductId = 0, index = 0, used = new Set() } = {}) {
  const productToken = await listingOfferProductToken(sourceProductId);
  const shopToken = shopId ? `S${shopId}` : "S0";
  const variantToken = `V${String(index + 1).padStart(2, "0")}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const randomToken = crypto.randomBytes(3).toString("hex").toUpperCase();
    const offerId = `${productToken}-${shopToken}-${variantToken}-${randomToken}`.slice(0, 128);
    if (used.has(offerId)) continue;
    const conflict = await findListingOfferIdConflict(shopId, offerId);
    if (!conflict) return offerId;
  }
  return `${productToken}-${shopToken}-${variantToken}-${Date.now().toString(36).toUpperCase()}`.slice(0, 128);
}

async function listingOfferProductToken(sourceProductId = 0) {
  const id = Number(sourceProductId || 0);
  if (!id) return `PNEW${Date.now().toString(36).toUpperCase().slice(-4)}`;
  const product = await row("SELECT id, code, selection_id FROM products WHERE id = ? LIMIT 1", [id]).catch(() => null);
  const code = String(product?.code || "").trim();
  const codeMatch = code.match(/^P-(\d{8})-(\d{6})-(\d+)$/i);
  if (codeMatch) return `P${codeMatch[2]}${codeMatch[3]}`.slice(0, 18);
  const selection = String(product?.selection_id || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (selection) return selection.slice(0, 18);
  return `P${id}`;
}

async function findListingOfferIdConflict(shopId = 0, offerId = "", { sourceRecordId = 0 } = {}) {
  const shop = Number(shopId || 0);
  const offer = String(offerId || "").trim();
  if (!shop || !offer) return null;
  const online = await row("SELECT id FROM online_products WHERE shop_id = ? AND offer_id = ? LIMIT 1", [shop, offer]).catch(() => null);
  if (online) return { table: "online_products", id: Number(online.id || 0) };
  const record = await row(`
    SELECT id
    FROM listing_publish_records
    WHERE shop_id = ? AND offer_id = ? AND status <> 'deleted' AND id <> ?
    LIMIT 1
  `, [shop, offer, Number(sourceRecordId || 0)]).catch(() => null);
  if (record) return { table: "listing_publish_records", id: Number(record.id || 0) };
  const copy = await row(`
    SELECT id
    FROM listing_shop_copies
    WHERE shop_id = ? AND offer_id = ? AND status <> 'deleted'
    LIMIT 1
  `, [shop, offer]).catch(() => null);
  if (copy) return { table: "listing_shop_copies", id: Number(copy.id || 0) };
  return null;
}

async function resolveListingSourceProductId(template = {}, payload = {}) {
  const editable = normalizeEditablePayload(template.editable_payload || template.editablePayload || {});
  const sourceRaw = objectValue(template.source_raw || template.sourceRaw || editable.source_raw || editable.sourceRaw || {});
  const direct = Number(
    template.source_product_id
    || template.sourceProductId
    || editable.source_product_id
    || editable.sourceProductId
    || sourceRaw.source_product_id
    || sourceRaw.sourceProductId
    || sourceRaw.selection_product_id
    || sourceRaw.selectionProductId
    || 0
  );
  if (direct) return direct;
  const offerId = firstOfferId(payload);
  if (offerId) {
    const mapping = await row("SELECT product_id FROM sku_mappings WHERE offer_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1", [offerId]).catch(() => null);
    if (Number(mapping?.product_id || 0)) return Number(mapping.product_id);
  }
  return 0;
}

function sanitizeOzonPayloadAttributes(attributes = []) {
  return normalizeArray(attributes).map((attr) => {
    const id = Number(attr.id || attr.attribute_id || 0);
    if (![4191, 11254].includes(id)) return attr;
    const values = normalizeArray(attr.values).map((value) => {
      const raw = typeof value === "object" && value !== null ? value.value : value;
      const clean = id === 11254 ? sanitizeOzonRichContentJson(raw) : sanitizeOzonBuyerDescription(raw);
      return typeof value === "object" && value !== null ? { ...value, value: clean } : { value: clean };
    }).filter((value) => String(value?.value || "").trim());
    return { ...attr, values };
  });
}

function normalizeOzonComplexAttributesForPublish(groups = []) {
  return normalizeArray(groups)
    .map((group) => ({
      ...group,
      attributes: normalizeArray(group.attributes)
        .filter((attr) => Number(attr.id || 0) > 0)
        .map((attr) => ({
          ...attr,
          id: Number(attr.id),
          values: normalizeArray(attr.values).filter((value) => String(value?.value || value || "").trim())
        }))
    }))
    .filter((group) => group.attributes.length);
}

async function normalizeOzonDictionaryAttributes(item = {}, shop = {}) {
  const descriptionCategoryId = Number(item.description_category_id || 0);
  const typeId = Number(item.type_id || 0);
  const attributes = normalizeArray(item.attributes)
    .filter((attr) => Number(attr.id || attr.attribute_id || 0) !== 10096 || !looksLikeProductTags(attr));
  const byId = new Map(attributes.map((attr) => [Number(attr.id || attr.attribute_id || 0), attr]));

  if (descriptionCategoryId && typeId) {
    const categoryAttrIds = await getCategoryAttributeIdSet(descriptionCategoryId, typeId);
    const hasCategoryAttr = (id) => !categoryAttrIds.size || categoryAttrIds.has(Number(id));
    if (byId.has(22814) && !hasCategoryAttr(22814)) byId.delete(22814);
    if (byId.has(85)) {
      if (isNoBrandValue(byId.get(85))) {
        byId.set(85, {
          id: 85,
          values: [{
            dictionary_value_id: 126745801,
            value: "\u041d\u0435\u0442 \u0431\u0440\u0435\u043d\u0434\u0430"
          }]
        });
      } else {
        byId.set(85, await withDictionaryValue(byId.get(85), shop, descriptionCategoryId, typeId, 85, ["\u041d\u0435\u0442 \u0431\u0440\u0435\u043d\u0434\u0430", "No brand"], {
          dictionary_value_id: 126745801,
          value: "\u041d\u0435\u0442 \u0431\u0440\u0435\u043d\u0434\u0430"
        }));
      }
    }
    if (hasCategoryAttr(8229)) {
      const productTypeQueries = productTypeDictionaryQueries(item);
      const productTypeFallback = productTypeQueries[0]
        ? { dictionary_value_id: typeId, value: productTypeQueries[0] }
        : { dictionary_value_id: typeId, value: String(item.category_name || item.name || "孝芯胁邪褉").trim() };
      await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 8229, productTypeQueries, productTypeFallback);
    }
    const colorTexts = extractVariantColors(item);
    if (colorTexts.length && hasCategoryAttr(10096)) {
      const colorValues = await resolveDictionaryValuesCollection({
        attr: { id: 10096, values: colorTexts.map((value) => ({ value })) },
        shop,
        descriptionCategoryId,
        typeId,
        attributeId: 10096,
        fallbackQueries: ["black", "\u0447\u0435\u0440\u043d\u044b\u0439"],
        fallbackValue: {
          dictionary_value_id: 61574,
          value: "black"
        }
      });
      if (colorValues.length) byId.set(10096, { id: 10096, values: colorValues });
    }
    addPlainOzonAttribute(byId, 4383, item.weight);
    addPlainOzonAttribute(byId, 4497, item.weight);
    addPlainOzonAttribute(byId, 8415, mmToCm(item.depth));
    addPlainOzonAttribute(byId, 8416, mmToCm(item.width));
    addPlainOzonAttribute(byId, 4191, item.description);
    byId.delete(23171);
    addPlainOzonAttribute(byId, 23171, publishOzonTagList(item).join(" "));
    const inferredQuantity = inferListingPackageQuantity(item);
    if (hasCategoryAttr(4384)) addPlainOzonAttribute(byId, 4384, inferredQuantity.label);
    if (hasCategoryAttr(11650)) addPlainOzonAttribute(byId, 11650, inferredQuantity.count);
    if (hasCategoryAttr(23249)) addPlainOzonAttribute(byId, 23249, inferredQuantity.count);
    if (hasCategoryAttr(7236)) addPlainOzonAttribute(byId, 7236, item.model_name || item.model || item.offer_id || item.name);
    if (hasCategoryAttr(9024)) addPlainOzonAttribute(byId, 9024, item.offer_id);
    if (hasCategoryAttr(4389)) {
      await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 4389, ["China", "?????"], null);
    }
    if (hasCategoryAttr(7578)) addPlainOzonAttribute(byId, 7578, "30");
    if (hasCategoryAttr(4385)) addPlainOzonAttribute(byId, 4385, "30");
    if (hasCategoryAttr(23485) && looksLikeSeatBeltProduct(item)) {
      await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 23485, ["Seat belt", "Safety belt", "Ремень безопасности"], null);
    }

    if (hasCategoryAttr(7202)) await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 7202, [inferredQuantity.label, inferredQuantity.count], null);
    if (hasCategoryAttr(5629)) await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 5629, ["Decorative accessory", "???????? ?????????"], null);
    if (hasCategoryAttr(5635)) await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 5635, ["Interior accessory", "?????????????"], null);
    if (hasCategoryAttr(7303)) await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 7303, ["Plastic", "TPU"], null);
    if (hasCategoryAttr(7287)) await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 7287, ["薪邪泻谢邪写薪芯泄", "斜械蟹 褍褋褌邪薪芯胁泻懈", "褋邪屑芯褋褌芯褟褌械谢褜薪邪褟 褍褋褌邪薪芯胁泻邪"], null);
    if (hasCategoryAttr(7199) && shouldAutoPublishMaterialAttribute(descriptionCategoryId, typeId)) {
      byId.delete(7199);
      await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 7199, materialDictionaryQueries(item.material), materialDictionaryFallback(item.material));
    } else if (hasCategoryAttr(7199) && !shouldAutoPublishMaterialAttribute(descriptionCategoryId, typeId)) {
      byId.delete(7199);
    }
    const vehicle = extractVehicleFacts(item);
    if (hasCategoryAttr(7204)) await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 7204, [item.vehicle_brand, vehicle.brand], null);
    if (hasCategoryAttr(7212)) {
      byId.delete(7212);
      await addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, 7212, [item.vehicle_model, vehicle.model, vehicle.full], null);
    }
    await autoFillKnownSafeCategoryAttributes(byId, {
      item,
      shop,
      descriptionCategoryId,
      typeId
    });
    await autoSelectMissingRequiredDictionaryAttributes(byId, {
      item,
      shop,
      descriptionCategoryId,
      typeId
    });
  }

  return [...byId.values()].filter((attr) => Number(attr.id || attr.attribute_id || 0) && normalizeArray(attr.values).length);
}

async function autoSelectMissingRequiredDictionaryAttributes(byId, { item = {}, shop = {}, descriptionCategoryId = 0, typeId = 0 } = {}) {
  const categoryId = Number(descriptionCategoryId || 0);
  const categoryTypeId = Number(typeId || 0);
  if (!categoryId || !categoryTypeId) return;
  const definitions = await listingOzonCategoryAttributes({
    description_category_id: categoryId,
    type_id: categoryTypeId,
    shop_id: shop.id,
    value_limit: 80,
    sync_values: true,
    auto_sync: true
  }).catch(() => []);
  const missing = normalizeArray(definitions)
    .filter((definition) => Boolean(definition.required || definition.is_required))
    .filter((definition) => Number(definition.dictionary_id || 0) > 0)
    .filter(isSafeAutoRequiredDictionaryAttribute)
    .filter((definition) => !hasPublishDictionaryValue(byId.get(Number(definition.attribute_id || definition.id || 0))));
  if (!missing.length) return;

  const deterministic = [];
  const aiCandidates = [];
  for (const definition of missing) {
    const options = normalizeArray(definition.values)
      .map(normalizeDictionaryOptionForPublish)
      .filter((option) => Number(option.dictionary_value_id || 0) && String(option.value || option.label || "").trim());
    const defaultSelection = selectPublishRequiredDictionaryDefault(definition, options, item);
    if (defaultSelection.length) deterministic.push({ definition, selected: defaultSelection, source: "required_dictionary_default" });
    else if (options.length === 1) deterministic.push({ definition, selected: options[0], source: "single_required_dictionary_option" });
    else if (options.length > 1) aiCandidates.push({ definition, options });
  }

  for (const item of deterministic) setAutoSelectedDictionaryAttribute(byId, item);
  if (!aiCandidates.length) return;
  const aiSelected = await selectRequiredDictionaryOptionsWithAi({
    item,
    shop,
    descriptionCategoryId: categoryId,
    typeId: categoryTypeId,
    candidates: aiCandidates
  }).catch((error) => {
    console.warn("required dictionary AI selection failed", error?.message || error);
    return [];
  });
  for (const selection of aiSelected) setAutoSelectedDictionaryAttribute(byId, selection);
}

async function autoFillKnownSafeCategoryAttributes(byId, { item = {}, shop = {}, descriptionCategoryId = 0, typeId = 0 } = {}) {
  const categoryId = Number(descriptionCategoryId || 0);
  const categoryTypeId = Number(typeId || 0);
  if (!categoryId || !categoryTypeId) return;
  const definitions = await listingOzonCategoryAttributes({
    description_category_id: categoryId,
    type_id: categoryTypeId,
    shop_id: shop.id,
    value_limit: 80,
    sync_values: true,
    auto_sync: true
  }).catch(() => []);
  for (const definition of normalizeArray(definitions)) {
    const attributeId = Number(definition.attribute_id || definition.id || 0);
    if (!attributeId || hasPublishAnyAttributeValue(byId.get(attributeId))) continue;
    if (shouldSkipAutoPublishAttribute(definition)) continue;
    const candidates = safeAutoAttributeCandidates(definition, item, shop);
    if (!candidates.length) continue;
    if (Number(definition.dictionary_id || 0) > 0) {
      await addDictionaryOzonAttribute(byId, shop, categoryId, categoryTypeId, attributeId, candidates, null);
    } else {
      addPlainOzonAttribute(byId, attributeId, candidates[0]);
    }
  }
}

function shouldSkipAutoPublishAttribute(definition = {}) {
  const text = safeAttributeDefinitionText(definition);
  if (/file|pdf|manual|instruction|certificate|document|褋械褉褌懈褎懈泻|懈薪褋褌褉褍泻褑|褎邪泄谢|写芯泻褍屑械薪褌|璇佷功|璇存槑涔鏂囦欢/.test(text)) return true;
  if (/barcode|\u6761\u5f62\u7801/i.test(text)) return true;
  return false;
}

function hasPublishAnyAttributeValue(attr = {}) {
  return normalizeArray(attr?.values).some((value) => String(value?.value ?? value?.name ?? value ?? "").trim());
}

function safeAutoAttributeCandidates(definition = {}, item = {}, shop = {}) {
  const attributeId = Number(definition.attribute_id || definition.id || 0);
  const name = safeAttributeDefinitionText(definition);
  const material = String(item.material || item.material_text || "").trim();
  const quantity = inferListingPackageQuantity(item);
  const colors = extractVariantColors(item);
  const vehicle = extractVehicleFacts(item);
  if (attributeId === 85) return ["袧械褌 斜褉械薪写邪", "No brand"];
  if (attributeId === 8229 || /(^|\s)(type|褌懈锌|胁懈写|鍟嗗搧绫诲瀷|浜у搧绫诲瀷|绫诲埆)(\s|$)/.test(name)) return productTypeDictionaryQueries(item);
  if (attributeId === 10096 || /color|colour|褑胁械褌|棰滆壊/.test(name)) return colors;
  if (attributeId === 7199 || /material|屑邪褌械褉懈邪谢|鏉愯川|鏉愭枡/.test(name)) return materialDictionaryQueries(material);
  if (attributeId === 7204 || /car.*brand|vehicle.*brand|屑邪褉泻邪.*邪胁褌芯|斜褉械薪写.*邪胁褌芯|姹借溅鍝佺墝|閫傜敤鍝佺墝/.test(name)) return [item.vehicle_brand, vehicle.brand].filter(Boolean);
  if (attributeId === 7212 || /car.*model|vehicle.*model|屑芯写械谢褜.*邪胁褌芯|杞﹀瀷|閫傜敤杞﹀瀷/.test(name)) return [item.vehicle_model, vehicle.model, vehicle.full].filter(Boolean);
  if (attributeId === 4389 || /country|origin|manufacturer|made|\u539f\u4ea7\u56fd|\u5236\u9020\u56fd|\u751f\u4ea7\u56fd/i.test(name)) return ["China", "\u4e2d\u56fd"];
  if (attributeId === 7578 || attributeId === 4385 || /warranty|guarantee|谐邪褉邪薪褌|褋褉芯泻 褋谢褍卸斜褘|淇濅慨|璐ㄤ繚/.test(name)) return ["30", "30 写薪械泄"];
  if ([4384, 11650, 23249, 7202].includes(attributeId) || /quantity|泻芯谢懈褔械褋褌胁芯|泻芯屑锌谢械泻褌|褕褌褍泻|鏁伴噺|浠舵暟/.test(name)) {
    return [quantity.label, quantity.count].filter(Boolean);
  }
  if (attributeId === 7236 || /model name|屑芯写械谢褜|鍨嬪彿鍚嶇О|鍨嬪彿/.test(name)) return [item.model_name, item.model, item.offer_id, item.name].filter(Boolean);
  if (attributeId === 9024 || /seller.*code|vendor.*code|article|邪褉褌懈泻褍谢|鍗栧.*浠ｇ爜|璐у彿|缂栫爜/.test(name)) return [item.offer_id].filter(Boolean);
  if (/manufacturer|\u5236\u9020\u5546|\u751f\u4ea7\u5546/i.test(name)) return ["China", shop.name].filter(Boolean);
  return [];
}

function safeAttributeDefinitionText(definition = {}) {
  return [
    definition.name,
    definition.name_zh,
    definition.attribute_name,
    definition.type,
    definition.attribute_type
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean).join(" ");
}

function isSafeAutoRequiredDictionaryAttribute(definition = {}) {
  const name = String(definition.name_zh || definition.name || definition.attribute_name || "").toLowerCase();
  const type = String(definition.type || definition.attribute_type || "").toLowerCase();
  if (/file|pdf|manual|instruction|certificate|document|褋械褉褌懈褎懈泻|懈薪褋褌褉褍泻褑|褎邪泄谢|写芯泻褍屑械薪褌|璇佷功|璇存槑涔鏂囦欢/.test(`${name} ${type}`)) return false;
  return true;
}

function hasPublishDictionaryValue(attr = {}) {
  return normalizeArray(attr?.values).some((value) => Number(value?.dictionary_value_id || value?.id || value?.value_id || 0));
}

function normalizeDictionaryOptionForPublish(option = {}) {
  const dictionaryValueId = Number(option.dictionary_value_id || option.id || option.value_id || 0);
  const value = String(option.value || option.name || option.text || "").trim();
  const label = String(option.display_value_zh || option.label || option.name_zh || "").trim();
  return {
    id: dictionaryValueId,
    dictionary_value_id: dictionaryValueId,
    value,
    label,
    display_value_zh: label
  };
}

function selectPublishRequiredDictionaryDefault(definition = {}, options = [], item = {}) {
  const attributeId = Number(definition.attribute_id || definition.id || 0);
  const name = String(definition.name_zh || definition.name || definition.attribute_name || "").toLowerCase();
  const context = String([item.name, item.title, item.description, item.category_name].filter(Boolean).join(" ")).toLowerCase();
  if (attributeId === 9163 || /gender|sex/i.test(name)) {
    const adultGender = options.filter((option) => /屑褍卸褋泻芯泄|卸械薪褋泻懈泄|鐢峰＋|濂冲＋|male|female/i.test(`${option.value || ""} ${option.label || ""}`));
    const childGender = options.filter((option) => /屑邪谢褜褔懈泻懈|写械胁芯褔泻懈|鐢风|濂崇|boy|girl/i.test(`${option.value || ""} ${option.label || ""}`));
    if (!/child|kid|boy|girl/i.test(context) && adultGender.length >= 2) return adultGender.slice(0, 2);
    if (childGender.length >= 2) return childGender.slice(0, 2);
  }
  return [];
}

function setAutoSelectedDictionaryAttribute(byId, { definition = {}, selected = {}, source = "ai_required_dictionary_option" } = {}) {
  const attributeId = Number(definition.attribute_id || definition.id || 0);
  const selectedValues = normalizeArray(selected)
    .map((option) => ({
      dictionary_value_id: Number(option.dictionary_value_id || option.id || 0),
      value: String(option.value || option.label || ""),
      display_value_zh: String(option.display_value_zh || option.label || "")
    }))
    .filter((option) => Number(option.dictionary_value_id || 0));
  if (!attributeId || !selectedValues.length) return;
  byId.set(attributeId, {
    id: attributeId,
    attribute_id: attributeId,
    name: definition.name || definition.name_zh || "",
    values: selectedValues,
    source
  });
}

async function selectRequiredDictionaryOptionsWithAi({ item = {}, shop = {}, descriptionCategoryId = 0, typeId = 0, candidates = [] } = {}) {
  const compactCandidates = candidates.slice(0, 12).map(({ definition, options }) => ({
    attribute_id: Number(definition.attribute_id || definition.id || 0),
    name: definition.name || "",
    name_zh: definition.name_zh || "",
    options: options.slice(0, 80).map((option) => ({
      dictionary_value_id: Number(option.dictionary_value_id || 0),
      value: option.value || "",
      label: option.label || option.display_value_zh || ""
    }))
  })).filter((entry) => entry.attribute_id && entry.options.length);
  if (!compactCandidates.length) return [];
  const response = await chatWithAiProvider({
    temperature: 0,
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content: [
          "You choose required Ozon dictionary attributes for a product.",
          "Choose only from the provided option dictionary_value_id values.",
          "Do not invent values. If evidence is insufficient, omit the attribute.",
          "Return JSON only: {\"attributes\":{\"ATTRIBUTE_ID\":DICTIONARY_VALUE_ID}}."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          product: requiredDictionaryProductContext(item),
          shop: { id: shop.id, name: shop.name || "" },
          ozon_category: { description_category_id: descriptionCategoryId, type_id: typeId },
          required_dictionary_attributes: compactCandidates
        })
      }
    ]
  });
  const parsed = parseAiContentJson(response.content || "");
  const selectedMap = objectValue(parsed.attributes || parsed.fields?.attributes || {});
  const result = [];
  for (const { definition, options } of candidates) {
    const attributeId = Number(definition.attribute_id || definition.id || 0);
    const selectedId = Number(selectedMap[String(attributeId)] || selectedMap[attributeId] || 0);
    if (!selectedId) continue;
    const selected = options.find((option) => Number(option.dictionary_value_id || option.id || 0) === selectedId);
    if (selected) result.push({ definition, selected, source: "ai_required_dictionary_option" });
  }
  return result;
}

function requiredDictionaryProductContext(item = {}) {
  return {
    title: item.name || item.title || "",
    description: item.description || "",
    category_name: item.category_name || "",
    offer_id: item.offer_id || "",
    color: item.color || "",
    material: item.material || item.material_text || "",
    quantity: item.quantity || item.quantity_text || "",
    vehicle_brand: item.vehicle_brand || "",
    vehicle_model: item.vehicle_model || "",
    attributes: normalizeArray(item.attributes).map((attr) => ({
      id: attr.id || attr.attribute_id || "",
      name: attr.name || attr.name_zh || "",
      value: normalizeAttributeValue(attr.value || attr.values)
    })).slice(0, 80)
  };
}

function looksLikeProductTags(attr = {}) {
  const text = normalizeArray(attr.values).map((value) => value?.value ?? value).join(" ");
  return /(^|\s)#/.test(text);
}

const categoryAttributeIdSetCache = new Map();

async function getCategoryAttributeIdSet(descriptionCategoryId, typeId) {
  const key = `${Number(descriptionCategoryId || 0)}:${Number(typeId || 0)}`;
  if (categoryAttributeIdSetCache.has(key)) return categoryAttributeIdSetCache.get(key);
  const rows = await mysqlQuery(`
    SELECT attribute_id
    FROM ozon_category_attributes
    WHERE description_category_id = ? AND type_id = ? AND status = 'active'
  `, [Number(descriptionCategoryId || 0), Number(typeId || 0)]).catch(() => []);
  const result = new Set(rows.map((row) => Number(row.attribute_id || 0)).filter(Boolean));
  categoryAttributeIdSetCache.set(key, result);
  return result;
}

function looksLikeSeatBeltProduct(item = {}) {
  const text = [
    item.name,
    item.title,
    item.description,
    item.category_name,
    item.product_type
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return /瀹夊叏甯鎶よ偐|seat\s*belt|褉械屑械薪褜 斜械蟹芯锌邪褋薪芯褋褌懈|薪邪泻谢邪写泻邪 薪邪 褉械屑械薪褜/.test(text);
}

function extractVariantColors(item = {}) {
  const rawValues = [
    item.color,
    item.colour,
    item.color_name,
    item.colorValue,
    item.color_value
  ];
  const tokens = rawValues
    .flatMap((value) => String(value || "").split(/[\uFF0C,\/|+]+|(?:\s+-\s+)|(?:\s+and\s+)|(?:\s+\u0438\s+)/i))
    .map((value) => normalizeColorToken(value))
    .filter(Boolean);
  return [...new Set(tokens)];
}

function normalizeColorToken(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/\u91d1|gold|\u0437\u043e\u043b\u043e\u0442/i.test(text)) return "gold";
  if (/\u9ed1|black|\u0447\u0435\u0440\u043d/i.test(text)) return "black";
  if (/\u94f6|silver|gray|grey|\u0441\u0435\u0440\u0435\u0431|\u0441\u0435\u0440\u044b\u0439/i.test(text)) return "silver";
  if (/\u767d|white|\u0431\u0435\u043b/i.test(text)) return "white";
  if (/\u7ea2|red|\u043a\u0440\u0430\u0441\u043d/i.test(text)) return "red";
  if (/\u84dd|blue|\u0441\u0438\u043d/i.test(text)) return "blue";
  if (/\u7eff|green|\u0437\u0435\u043b\u0435\u043d/i.test(text)) return "green";
  if (/\u68d5|brown|\u043a\u043e\u0440\u0438\u0447\u043d\u0435\u0432/i.test(text)) return "brown";
  if (/\u900f\u660e|transparent|\u043f\u0440\u043e\u0437\u0440\u0430\u0447/i.test(text)) return "transparent";
  return text;
}

function addPlainOzonAttribute(byId, id, value) {
  const text = normalizePlainOzonValue(value);
  if (!text || byId.has(Number(id))) return;
  byId.set(Number(id), { id: Number(id), values: [{ value: text }] });
}

function materialDictionaryQueries(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (/tpu|polyurethane|\u70ed\u5851|\u5f39\u6027\u4f53/i.test(text)) return ["TPU", "polyurethane"];
  if (/abs/i.test(text)) return ["ABS", "ABS plastic"];
  if (/silicone|\u7845\u80f6/i.test(text)) return ["silicone", "\u7845\u80f6"];
  if (/leather|\u76ae|\u725b\u76ae/i.test(text)) return ["leather", "artificial leather"];
  if (/plastic|\u5851\u6599/i.test(text)) return ["plastic", "\u5851\u6599"];
  if (/stainless|steel|\u4e0d\u9508\u94a2/i.test(text)) return ["stainless steel", "steel"];
  return [text];
}
function materialDictionaryFallback(value) {
  return null;
}

function productTypeDictionaryQueries(item = {}) {
  const text = [
    item.product_type,
    item.category_name,
    item.name,
    item.title,
    item.description
  ].map((value) => String(value || "")).join(" ");
  if (/杩庡鏉闂ㄦ鏉闂ㄦ淇濇姢|锌芯褉芯谐|锌芯褉芯谐懈|薪邪泻谢邪写泻[邪懈]\s+薪邪\s+锌芯褉芯谐|door\s*sill|threshold/i.test(text)) {
    return ["薪邪泻谢邪写泻懈 薪邪 锌芯褉芯谐懈", "蟹邪褖懈褌邪 锌芯褉芯谐芯胁", "写胁械褉薪褘械 锌芯褉芯谐懈", "锌芯褉芯谐懈 邪胁褌芯"];
  }
  if (/鎵嬬怀|鎸傜怀|閽ュ寵鎵斜褉械谢芯泻|褉械屑械褕芯泻|lanyard|key\s*strap/i.test(text) && !/閽ュ寵澹硘褔械褏芯谢|case|cover/i.test(text)) {
    return ["斜褉械谢芯泻 写谢褟 泻谢褞褔械泄", "褉械屑械褕芯泻 写谢褟 泻谢褞褔械泄", "邪胁褌芯屑芯斜懈谢褜薪褘泄 斜褉械谢芯泻"];
  }
  if (/閽ュ寵澹硘閽ュ寵濂梶褔械褏芯谢.*泻谢褞褔|key\s*(case|cover)/i.test(text)) {
    return ["效械褏芯谢 斜褉械谢泻邪 邪胁褌芯褋懈谐薪邪谢懈蟹邪褑懈懈", "褔械褏芯谢 写谢褟 泻谢褞褔邪", "蟹邪褖懈褌薪褘泄 褔械褏芯谢"];
  }
  if (/瀹夊叏甯鎶よ偐|seat\s*belt|褉械屑械薪褜 斜械蟹芯锌邪褋薪芯褋褌懈|薪邪泻谢邪写泻邪 薪邪 褉械屑械薪褜/i.test(text)) {
    return ["薪邪泻谢邪写泻邪 薪邪 褉械屑械薪褜 斜械蟹芯锌邪褋薪芯褋褌懈", "褉械屑械薪褜 斜械蟹芯锌邪褋薪芯褋褌懈", "邪胁褌芯屑芯斜懈谢褜薪邪褟 薪邪泻谢邪写泻邪"];
  }
  const leaf = String(item.category_name || "").replace(/\([^)]*\)/g, "").split(/[/>|]/).map((part) => part.trim()).filter(Boolean).pop();
  return [item.product_type, leaf, item.name].map((value) => String(value || "").trim()).filter(Boolean);
}

function shouldAutoPublishMaterialAttribute(descriptionCategoryId, typeId) {
  const key = `${Number(descriptionCategoryId || 0)}:${Number(typeId || 0)}`;
  return key !== "17028757:970862668";
}

async function addDictionaryOzonAttribute(byId, shop, descriptionCategoryId, typeId, id, queries = [], fallback = null) {
  const cleanQueries = normalizeArray(queries).map((value) => String(value || "").trim()).filter(Boolean);
  if (!cleanQueries.length && !fallback) return;
  const existing = byId.get(Number(id));
  const attr = await withDictionaryValue(existing || { id, values: cleanQueries.map((value) => ({ value })) }, shop, descriptionCategoryId, typeId, id, cleanQueries, fallback);
  if (!normalizeArray(attr.values).some((value) => Number(value?.dictionary_value_id || value?.id || 0))) {
    if (existing && cleanQueries.length) byId.delete(Number(id));
    return;
  }
  byId.set(Number(id), attr);
}

async function resolveDictionaryValuesCollection({
  attr = {},
  shop,
  descriptionCategoryId,
  typeId,
  attributeId,
  fallbackQueries = [],
  fallbackValue = null
} = {}) {
  const seen = new Set();
  const resolved = [];
  for (const rawValue of normalizeArray(attr.values)) {
    const text = String(rawValue?.value || rawValue?.name || rawValue || "").trim();
    if (!text) continue;
    const entry = await withDictionaryValue(
      { id: Number(attr.id || attr.attribute_id || attributeId), values: [{ value: text }] },
      shop,
      descriptionCategoryId,
      typeId,
      attributeId,
      [text, ...normalizeArray(fallbackQueries)],
      fallbackValue
    );
    for (const value of normalizeArray(entry.values)) {
      const dictionaryValueId = Number(value?.dictionary_value_id || value?.id || 0);
      const key = dictionaryValueId ? `id:${dictionaryValueId}` : `text:${String(value?.value || "").trim().toLowerCase()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      resolved.push({
        dictionary_value_id: dictionaryValueId || undefined,
        value: String(value?.value || text || "")
      });
    }
  }
  return resolved.filter((value) => Number(value.dictionary_value_id || 0) || String(value.value || "").trim());
}

function normalizePlainOzonValue(value) {
  if (Array.isArray(value)) return value.map(normalizePlainOzonValue).filter(Boolean).join(" ");
  if (value && typeof value === "object") return normalizePlainOzonValue(value.value || value.name || value.text || "");
  return String(value ?? "").trim();
}

function inferListingPackageQuantity(item = {}) {
  const explicit = normalizeUnitQuantity(item.quantity || item.quantity_text || item.quantityText || "");
  const fromText = explicit || extractPackageQuantityFromText([
    item.name,
    item.title,
    item.description,
    item.category_name,
    normalizeArray(item.tags || item.hashtags || item.main_tags).join(" ")
  ].join(" "));
  if (!fromText) return { count: "", label: "" };
  return { count: fromText, label: `${fromText} pcs` };
}

function extractPackageQuantityFromText(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const patterns = [
    /(?:set|pack|kit)\s*(?:of\s*)?(\d{1,2})\s*(?:pcs|pieces|piece|pc)?/i,
    /(\d{1,2})\s*(?:pcs|pieces|piece|pc|set|pack|\u4ef6|\u4e2a|\u5957)/i,
    /(?:set|pack|kit)\s*(?:of\s*)?(\d{1,2})/i,
    /(?:\u5957\u88c5|\u7ec4\u5408)\s*(\d{1,2})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const count = Number(match?.[1] || 0);
    if (Number.isInteger(count) && count > 0 && count <= 50) return String(count);
  }
  return "";
}

function normalizeUnitQuantity(value = "") {
  const match = String(value || "").match(/\d+(?:[.,]\d+)?/);
  return match ? match[0].replace(",", ".") : "";
}

function mmToCm(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return String(Math.round((numeric / 10) * 100) / 100);
}

function extractVehicleFacts(item = {}) {
  const haystack = [
    item.name,
    item.title,
    item.description,
    item.vehicle_brand,
    item.vehicle_model
  ].map((value) => String(value || "")).join(" ");
  const brandMatch = haystack.match(/\b(Belgee|Tenet|Chery|Geely|Haval|Lada|Toyota|Kia|Hyundai|Volkswagen|Renault|Skoda|Nissan)\b/i);
  const modelMatch = haystack.match(/\b([A-Z]{1,4}\d{1,3}|X50|X70|T4|T7|T8)\b/i);
  const brand = brandMatch?.[1] || "";
  const model = modelMatch?.[1] || "";
  return {
    brand,
    model,
    full: [brand, model].filter(Boolean).join(" ")
  };
}

async function withDictionaryValue(attr = {}, shop, descriptionCategoryId, typeId, attributeId, queries = [], fallback = null) {
  const existing = normalizeArray(attr.values).find((value) => Number(value?.dictionary_value_id || value?.id || 0));
  if (existing) {
    return {
      id: Number(attr.id || attr.attribute_id || attributeId),
      values: [{ dictionary_value_id: Number(existing.dictionary_value_id || existing.id), value: String(existing.value || "") }]
    };
  }
  for (const query of expandDictionaryQueries(queries)) {
    const cached = await findCachedDictionaryValue(descriptionCategoryId, typeId, attributeId, query).catch(() => null);
    if (cached?.dictionary_value_id) {
      return {
        id: Number(attr.id || attr.attribute_id || attributeId),
        values: [{ dictionary_value_id: Number(cached.dictionary_value_id), value: String(cached.value || query) }]
      };
    }
    const values = await searchOzonCategoryAttributeValues(shop, {
      descriptionCategoryId,
      typeId,
      attributeId,
      value: query,
      language: "DEFAULT",
      limit: 50
    }).catch(() => []);
    const exact = chooseDictionaryMatch(values, query);
    if (exact?.id || exact?.dictionary_value_id) {
      await upsertLocalizedDictionaryValueCache(shop, descriptionCategoryId, typeId, attributeId, exact).catch(() => null);
      return {
        id: Number(attr.id || attr.attribute_id || attributeId),
        values: [{ dictionary_value_id: Number(exact.id || exact.dictionary_value_id), value: String(exact.value || query) }]
      };
    }
  }
  return {
    id: Number(attr.id || attr.attribute_id || attributeId),
    values: fallback ? [fallback] : normalizeAttributeValuesForOzon(attr)
  };
}

async function upsertLocalizedDictionaryValueCache(shop, descriptionCategoryId, typeId, attributeId, item = {}) {
  const dictionaryValueId = Number(item.id || item.dictionary_value_id || item.value_id || 0);
  if (!dictionaryValueId) return null;
  const localized = await fetchLocalizedOzonAttributeValues(shop, {
    descriptionCategoryId,
    typeId,
    attributeId,
    keyword: String(item.value || item.name || "").trim(),
    language: "ZH_HANS",
    limit: 80
  }).catch(() => []);
  const merged = normalizeArray(localized).find((entry) => Number(entry.id || entry.dictionary_value_id || 0) === dictionaryValueId) || item;
  const value = String(item.value || merged.value || merged.name || "").trim();
  const displayValueZh = String(merged.display_value_zh || "").trim() || inferOzonAttributeDisplayValueZh(attributeId, value, merged);
  await run(`
    INSERT INTO ozon_attribute_values
    (description_category_id, type_id, attribute_id, dictionary_value_id, value, display_value_zh, info, source_shop_id, raw_json, status, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      value = VALUES(value),
      display_value_zh = CASE
        WHEN VALUES(display_value_zh) <> '' THEN VALUES(display_value_zh)
        ELSE display_value_zh
      END,
      info = VALUES(info),
      source_shop_id = VALUES(source_shop_id),
      raw_json = VALUES(raw_json),
      status = 'active',
      synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `, [
    Number(descriptionCategoryId || 0),
    Number(typeId || 0),
    Number(attributeId || 0),
    dictionaryValueId,
    value,
    displayValueZh,
    String(merged.info || merged.description || item.info || item.description || "").trim(),
    shop.id,
    JSON.stringify(merged)
  ]);
  return { dictionary_value_id: dictionaryValueId, value, display_value_zh: displayValueZh };
}

function isNoBrandValue(attr = {}) {
  const text = [
    attr?.value,
    ...normalizeArray(attr?.values).map((value) => value?.value || value?.name || value || "")
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean).join(" ");
  return /^(?:\u65e0\u54c1\u724c|no brand|without brand|\u043d\u0435\u0442 \u0431\u0440\u0435\u043d\u0434\u0430|\u0431\u0435\u0437 \u0431\u0440\u0435\u043d\u0434\u0430)$/.test(text)
    || /(?:^|\s)(?:\u65e0\u54c1\u724c|no brand|without brand|\u043d\u0435\u0442 \u0431\u0440\u0435\u043d\u0434\u0430|\u0431\u0435\u0437 \u0431\u0440\u0435\u043d\u0434\u0430)(?:\s|$)/.test(text);
}

function chooseDictionaryMatch(values = [], query = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return null;
  const normalizedNeedle = normalizeDictionaryText(needle);
  return normalizeArray(values).find((item) => normalizeDictionaryText(item.value || "") === normalizedNeedle)
    || normalizeArray(values).find((item) => {
      const value = normalizeDictionaryText(item.value || "");
      return normalizedNeedle.length >= 2 && (value.includes(normalizedNeedle) || normalizedNeedle.includes(value));
    })
    || null;
}

function normalizeDictionaryText(value = "") {
  return String(value || "").toLowerCase().replace(/褢/g, "械").replace(/\s+/g, " ").trim();
}

async function findCachedDictionaryValue(descriptionCategoryId, typeId, attributeId, query) {
  const text = String(query || "").trim();
  if (!text) return null;
  const rows = await mysqlQuery(`
    SELECT dictionary_value_id, value
    FROM ozon_attribute_values
    WHERE description_category_id = ? AND type_id = ? AND attribute_id = ? AND status = 'active'
      AND (LOWER(value) = LOWER(?) OR LOWER(value) LIKE LOWER(?))
    ORDER BY CASE WHEN LOWER(value) = LOWER(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, [Number(descriptionCategoryId || 0), Number(typeId || 0), Number(attributeId || 0), text, `%${text}%`, text]);
  return rows[0] || null;
}

function expandDictionaryQueries(queries = []) {
  const seed = normalizeArray(queries).map((item) => String(item || "").trim()).filter(Boolean);
  const expanded = [];
  for (const query of seed) {
    expanded.push(query);
    const lower = query.toLowerCase();
    if (/榛憒black|褔械褉薪/.test(lower)) expanded.push("black", "褔械褉薪褘泄", "褔械褉薪邪褟");
    if (/浜摱|閾秥silver|褋械褉械斜/.test(lower)) expanded.push("silver", "褋械褉械斜褉懈褋褌褘泄", "褋械褉褘泄");
    if (/鐧絴white|斜械谢/.test(lower)) expanded.push("white", "斜械谢褘泄", "斜械谢邪褟");
    if (/tpu|褌锌褍/i.test(query)) expanded.push("TPU", "孝袩校", "锌芯谢懈褍褉械褌邪薪");
    if (/china|泻懈褌邪泄|涓浗/i.test(query)) expanded.push("China", "袣懈褌邪泄");
    if (/belgee|斜械谢写卸懈|斜械谢谐懈/i.test(query)) expanded.push("Belgee", "袘械谢写卸懈");
  }
  return [...new Set(expanded.map((item) => String(item || "").trim()).filter(Boolean))];
}

function applyOzonPriceStrategy(item = {}) {
  const price = roundOzonMoney(numberFromOzonValue(item.price));
  const oldPrice = roundOzonMoney(numberFromOzonValue(item.old_price || item.oldPrice || 0));
  return {
    ...item,
    price_strategy_mode: PRICE_STRATEGY_FINALIZED,
    price: price ? String(price) : item.price,
    old_price: oldPrice ? String(oldPrice) : item.old_price
  };
}

function normalizeOzonPriceStrategyMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === PRICE_STRATEGY_FINALIZED || normalized === PRICE_STRATEGY_MULTIPLY_ON_PUBLISH) return normalized;
  if (normalized === "collector_box_locked" || normalized === "collector_locked" || normalized === "asset_variant_finalized") {
    return PRICE_STRATEGY_FINALIZED;
  }
  return "";
}

function resolveOzonPriceStrategyMode(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const explicit = normalizeOzonPriceStrategyMode(
      source.price_strategy_mode
      || source.priceStrategyMode
      || source.strategy_mode
      || source.strategyMode
    );
    if (explicit) return explicit;
  }
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (source.price_strategy_applied || source.priceStrategyApplied || source.strategy_applied || source.strategyApplied) {
      return PRICE_STRATEGY_FINALIZED;
    }
  }
  return PRICE_STRATEGY_FINALIZED;
}

async function resolveShopCurrencyCode(shopId) {
  const row = await mysqlQuery(`
    SELECT currency_code
    FROM online_products
    WHERE shop_id = ? AND COALESCE(currency_code, '') <> ''
    GROUP BY currency_code
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `, [Number(shopId)]).then((rows) => rows[0]).catch(() => null);
  return String(row?.currency_code || "").trim().toUpperCase();
}

function cmToMm(value) {
  const numeric = numberFromOzonValue(value);
  return numeric ? Math.round(numeric * 10) : 0;
}

function roundOzonMoney(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100) / 100;
}

function normalizeAttributeValuesForOzon(item = {}) {
  const sourceValues = selectedAttributeValuesForOzon(item);
  const values = Array.isArray(sourceValues) ? sourceValues : [sourceValues];
  const isRichContent = Number(item.attribute_id || item.id || 0) === 11254 || String(item.type || "").toLowerCase().includes("rich");
  const isLongText = [4191, 11254, 23171].includes(Number(item.attribute_id || item.id || 0));
  return values.map((value) => {
    if (value && typeof value === "object") {
      const dictionaryValueId = Number(value.dictionary_value_id || value.id || 0);
      const text = String(value.value || value.name || "").trim();
      if (dictionaryValueId) return { dictionary_value_id: dictionaryValueId, value: text };
      if (!isRichContent && !isLongText && (text.includes(",") || text.includes(";") || text.includes("\n"))) {
        return String(text).split(/[,;\n]+/).map((part) => ({ value: part.trim() })).filter((part) => part.value);
      }
      return { value: text };
    }
    const text = String(value || "").trim();
    const option = normalizeArray(item.values).find((candidate) => String(candidate.value || candidate.name || "") === text);
    if (option?.id || option?.dictionary_value_id) return { dictionary_value_id: Number(option.id || option.dictionary_value_id), value: text };
    return { value: text };
  }).flat().filter((value) => value.value || value.dictionary_value_id);
}

function selectedAttributeValuesForOzon(item = {}) {
  const selectedValues = normalizeArray(item.selected_values || item.selectedValues);
  if (selectedValues.length) return selectedValues;
  const optionValues = normalizeArray(item.values);
  const currentValues = normalizeArray(item.value);
  if (!optionValues.length) return item.value;
  if (!currentValues.length) return optionValues.length <= 2 ? optionValues : item.value;
  const matched = currentValues.map((current) => {
    const currentText = String(current && typeof current === "object" ? current.value || current.label || current.name || current.text || "" : current || "").trim();
    const currentDictId = Number(current && typeof current === "object" ? current.dictionary_value_id || current.id || current.value_id || 0 : 0);
    return optionValues.find((option) => {
      const optionDictId = Number(option?.dictionary_value_id || option?.id || option?.value_id || 0);
      if (currentDictId && optionDictId && currentDictId === optionDictId) return true;
      const candidates = [
        option?.value,
        option?.label,
        option?.display_value_zh,
        option?.name,
        option?.text
      ].map((value) => normalizeTranslationSource(value)).filter(Boolean);
      return currentText && candidates.includes(normalizeTranslationSource(currentText));
    }) || current;
  }).filter((value) => value !== undefined && value !== null && value !== "");
  return matched.length ? matched : item.value;
}

function extractComplexAttributeUrls(item = {}, attributeId = 0) {
  return normalizeArray(item.complex_attributes)
    .flatMap((group) => normalizeArray(group.attributes))
    .filter((attr) => Number(attr.id || 0) === Number(attributeId || 0))
    .flatMap((attr) => normalizeArray(attr.values))
    .map((value) => String(value?.value || value || "").trim())
    .filter(Boolean);
}

function extractVideoUrlsFromItem(item = {}) {
  return normalizeStringList(item.video_urls || item.videos || item.video_url).length
    ? normalizeStringList(item.video_urls || item.videos || item.video_url)
    : extractComplexAttributeUrls(item, 21841);
}

function extractVideoCoverUrlsFromItem(item = {}) {
  return normalizeStringList(item.video_cover_urls || item.cover_video_urls || item.video_cover).length
    ? normalizeStringList(item.video_cover_urls || item.cover_video_urls || item.video_cover)
    : extractComplexAttributeUrls(item, 21845);
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
    ...normalizeArray(item.attributes).flatMap((attr) => normalizeArray(attr.values).map((value) => value.value)),
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

function isPreviewRuntimeWithRemoteListingMediaBase() {
  const cwd = process.cwd().replace(/\\/g, "/").toLowerCase();
  if (!cwd.endsWith("/dist/preview")) return false;
  const base = String(config.listingMediaPublicBaseUrl || config.appBaseUrl || "").trim();
  return Boolean(base) && !isLocalImportMedia(base);
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
    assetVariantSourceTitle: row.asset_variant_source_title || row.assetVariantSourceTitle || metadata.assetVariantSourceTitle || metadata.sourceTitle || metadata.productTitle || "",
    assetVariantId: nullableNumber(row.asset_variant_id ?? row.assetVariantId),
    assetVariantTitle: row.asset_variant_title || row.assetVariantTitle || metadata.assetVariantTitle || "",
    assetVariantTitleZh: row.asset_variant_title_zh || row.assetVariantTitleZh || metadata.assetVariantTitleZh || "",
    assetVariantTags: parseJson(row.asset_variant_tags_json || row.assetVariantTagsJson, []),
    assetVariantTagStyle: row.asset_variant_tag_style || row.assetVariantTagStyle || "",
    assetVariantPriceIndex: Number(row.asset_variant_price_index || row.assetVariantPriceIndex || 0),
    assetVariantInternalPrice: Number(row.asset_variant_internal_price || row.assetVariantInternalPrice || 0),
    assetVariantOzonPrice: Number(row.asset_variant_ozon_price || row.assetVariantOzonPrice || 0),
    assetVariantOzonOldPrice: Number(row.asset_variant_ozon_old_price || row.assetVariantOzonOldPrice || 0),
    assetVariantOzonCategoryName: row.asset_variant_ozon_category_name || row.assetVariantOzonCategoryName || "",
    assetVariantOzonCategoryId: row.asset_variant_ozon_category_id || row.assetVariantOzonCategoryId || "",
    assetVariantColor: row.asset_variant_color || row.assetVariantColor || "",
    assetVariantMaterial: row.asset_variant_material || row.assetVariantMaterial || "",
    assetVariantQuantity: row.asset_variant_quantity || row.assetVariantQuantity || "",
    assetVariantOutputDir: row.asset_variant_output_dir || row.assetVariantOutputDir || metadata.assetVariantOutputDir || "",
    assetVariantCreatedAt: row.asset_variant_created_at || row.assetVariantCreatedAt || "",
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
    manual_facts: objectValue(body.manual_facts || body.manualFacts),
    ai_payload: objectValue(body.ai_payload || body.aiPayload)
  };
}

function normalizeMaterialPackageRow(row = {}) {
  const template = normalizeTemplateRow(row);
  const editable = template.editable_payload || {};
  const sourceRaw = template.source_raw || {};
  const attributes = template.attributes || [];
  const variants = normalizeArray(editable.variants);
  const images = template.images || [];
  const brand = attributeValueByNames(attributes, ["brand", "斜褉械薪写", "鍝佺墝"], [85]) || editable.logistics?.brand || "";
  const model = attributeValueByNames(attributes, ["model", "vehicle model", "car model", "杞﹀瀷", "鍨嬪彿"], [9048, 7212]) || editable.logistics?.model || editable.logistics?.spec || "";
  const productType = template.category_name || editable.category_name || sourceRaw.category_name || "";
  return {
    id: Number(row.id || 0),
    name: template.template_name || template.title || `绱犳潗鍖?${row.id}`,
    packageName: template.template_name || template.title || `绱犳潗鍖?${row.id}`,
    sourceShop: row.shop_name || sourceRaw.shop_name || "",
    shopId: Number(row.source_shop_id || sourceRaw.shop_id || 0) || null,
    brand,
    model,
    productType,
    categoryName: template.category_name || "",
    imageCount: images.length + variants.flatMap((item) => normalizeImages(item.images || [])).length,
    variantCount: variants.length || 1,
    updatedAt: row.updated_at || "",
    templateId: Number(row.id || 0),
    sourceType: row.source_type || "",
    missingFields: materialPackageMissingFields(template)
  };
}

function materialPackageMissingFields(template = {}) {
  const editable = template.editable_payload || {};
  const variants = normalizeArray(editable.variants);
  const images = normalizeImages(template.images || editable.images || []);
  const missing = [];
  if (!template.template_name) missing.push("Local template name is missing");
  if (!template.title && !editable.title) missing.push("鍟嗗搧鏍囬");
  if (!template.category_name && !editable.category_name) missing.push("浜у搧绫荤洰");
  if (!images.length && !variants.some((item) => normalizeImages(item.images || []).length)) missing.push("鍥剧墖绱犳潗");
  if (!variants.length) missing.push("SKU / 瑙勬牸");
  if (!objectValue(editable.price).value) missing.push("浠锋牸淇℃伅");
  if (!objectValue(editable.dimensions).weight_g) missing.push("鍖呰淇℃伅");
  return missing;
}

function buildDeepSeekListingPrompt(type, context = {}) {
  const contract = context?.target?.outputContract || { content: "string", fields: {} };
  const commonRules = [
    `Task type: ${type}`,
    "You are an Ozon Russia listing assistant inside an ERP system.",
    "Return valid JSON only. Do not return markdown. Do not explain your reasoning.",
    "The response must match this contract exactly enough for the ERP to fill the form:",
    JSON.stringify(contract),
    "Use the provided form, Ozon category, attributes, variants, media and source hints.",
    "Buyer-facing title, tags and descriptions must be natural Russian.",
    "Title, tags, summary and rich content must describe the same search intent. Reuse the most important product keywords naturally across them without keyword stuffing.",
    "Descriptions must be natural buyer prose, never comma-separated keyword lists.",
    "Never copy tags, hashtags, shop names, or keyword dumps into summary/description/rich content text.",
    "Do not use phrases like '袣谢褞褔械胁褘械 芯褋芯斜械薪薪芯褋褌懈', '袣谢褞褔械胁褘械 褋谢芯胁邪', '孝械谐懈' or '啸褝褕褌械谐懈' inside buyer-facing descriptions.",
    "Descriptions and rich content should highlight concrete selling points, compatible use cases, material benefits, fitment/vehicle context, color/style and everyday scenarios when present in context.",
    "Rich content is important for organic exposure: its text must not be generic. It should reinforce the title and tags, explain buyer benefits, and include natural Ozon search phrases from the provided tags.",
    "Do not invent a brand. If the product has no brand, use 袧械褌 斜褉械薪写邪.",
    "Do not put material such as TPU/ABS into model name. Model name should be a generated model/article style value.",
    "For any attribute with values/options, choose exactly one of the provided option values. Do not invent an option.",
    "Do not fill PDF, file, certificate, manual, instruction, or document upload attributes.",
    "Return empty string for unknown fields instead of guessing."
  ];

  const typeRules = {
    listingForm: [
      "Generate a complete set of editable listing fields: title, model, tags, summary, richJson when possible, attributes, and variant row values.",
      "Tags must start with #, use Russian words or underscore phrases, max 20 tags, each tag should be short.",
      "Summary must be 150-250 Russian words and read like a coherent product description with smooth sentence flow.",
      "The summary may naturally include product benefits, material, fitment and usage scenes, but do not force every title word or tag into it.",
      "Do not write a keyword block, tag list, or unnatural stitched text; Ozon may reject descriptions that look like keyword stuffing.",
      "If a tail image URL and summary exist, richJson should follow the Ozon raShowcase billboard structure with the image and text. The richJson text must be SEO-aligned with the title, tags and summary."
    ],
    title: ["Return fields.title and content as one Russian Ozon title."],
    tags: ["Return fields.tags as an array of Russian #tags. Do not return prose."],
    keywords: ["Return fields.tags or fields.keywords as an array of Russian #tags."],
    shortDescription: [
      "Return fields.summary and content as a 150-250 word Russian description.",
      "It must be fluent buyer prose with clear sentence logic, not a keyword block or a forced combination of title and tags.",
      "Use only the most relevant search phrases when they fit naturally."
    ],
    description: [
      "Return fields.summary and/or fields.richJson. Rich JSON must be parseable JSON string or object.",
      "The text must use fluent SEO-aware Russian copy connected to the product, but must not include literal tags, hashtag lists, or keyword stuffing."
    ],
    attributeFill: [
      "Fill only the requested attribute or missing required attributes.",
      "Return fields.attributes keyed by attribute_id when available; also include fields.value for a single requested attribute."
    ],
    categorySuggest: ["Suggest category-related text only when requested."],
    translateRu: ["Translate the requested field into Russian."],
    translateZh: [
      "Translate Russian listing copy into concise Chinese meaning for an operator.",
      "Do not rewrite or optimize the source text.",
      "Return fields.titleZh, fields.tagsZh, fields.descriptionZh, and fields.richJsonZh when those source fields exist."
    ],
    optimizeSeo: ["Optimize existing title/tags/summary without changing factual product information."],
    imageCopy: ["Generate short Russian copy based on product images and listing context."]
  };

  return [
    ...commonRules,
    ...(typeRules[type] || []),
    "Context JSON:",
    JSON.stringify(context)
  ].join("\n");
}
function parseAiContentJson(content) {
  const raw = String(content || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    return objectValue(JSON.parse(candidate));
  } catch {
    return { content: raw, fields: {} };
  }
}

function productTypeAbbr(value = "") {
  const text = cleanText(value, 64).toUpperCase();
  if (!text) return "ITEM";
  const known = [
    ["KEY", "KEY"],
    ["SILL", "SILL"],
    ["COVER", "COVER"],
    ["MAT", "MAT"],
  ];
  const hit = known.find(([needle]) => text.includes(needle));
  if (hit) return hit[1];
  return text.replace(/[^A-Z0-9]+/g, "_").split("_").filter(Boolean).map((part) => part.slice(0, 4)).join("").slice(0, 10) || "ITEM";
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

async function hydrateTemplateSelectedDictionaryValues(template = {}) {
  const attributes = normalizeAttributes(template.attributes || template.editable_payload?.attributes || []);
  const selectedRefs = collectSelectedDictionaryRefs(attributes);
  const dictionaryIds = Array.from(new Set(selectedRefs.map((item) => Number(item.dictionary_value_id || 0)).filter(Boolean)));
  const textRefs = collectSelectedDictionaryTexts(attributes);
  const categoryKey = parseSelectedDictionaryCategoryKey(template.ozon_category_id);
  const descriptionCategoryId = Number(template.editable_payload?.description_category_id || categoryKey.description_category_id || 0);
  const typeId = Number(template.editable_payload?.type_id || categoryKey.type_id || 0);
  if (!dictionaryIds.length && (!descriptionCategoryId || !typeId || !textRefs.length)) return template;
  const conditions = [];
  const params = [];
  if (dictionaryIds.length) {
    conditions.push(`dictionary_value_id IN (${dictionaryIds.map(() => "?").join(",")})`);
    params.push(...dictionaryIds);
  }
  if (descriptionCategoryId && typeId && textRefs.length) {
    conditions.push(`(description_category_id = ? AND type_id = ? AND LOWER(value) IN (${textRefs.map(() => "LOWER(?)").join(",")}))`);
    params.push(descriptionCategoryId, typeId, ...textRefs);
  }
  const rows = await all(`
    SELECT description_category_id, type_id, attribute_id, dictionary_value_id, value, display_value_zh
    FROM ozon_attribute_values
    WHERE (${conditions.join(" OR ")})
      AND status = 'active'
    ORDER BY description_category_id DESC, type_id DESC, attribute_id ASC
  `, params);
  const byExact = new Map();
  const byAttribute = new Map();
  const byId = new Map();
  const byText = new Map();
  for (const item of rows.map(normalizeOzonAttributeValueRow)) {
    const dictId = Number(item.dictionary_value_id || 0);
    const attrId = Number(item.attribute_id || 0);
    const categoryScore = Number(item.description_category_id || 0) === descriptionCategoryId && Number(item.type_id || 0) === typeId ? 2 : 0;
    const exactKey = `${attrId}:${dictId}`;
    const existingExact = byExact.get(exactKey);
    if (!existingExact || categoryScore > Number(existingExact.__score || 0)) byExact.set(exactKey, { ...item, __score: categoryScore });
    const existingAttr = byAttribute.get(exactKey);
    if (!existingAttr || categoryScore > Number(existingAttr.__score || 0)) byAttribute.set(exactKey, { ...item, __score: categoryScore });
    const existingId = byId.get(String(dictId));
    if (!existingId || categoryScore > Number(existingId.__score || 0)) byId.set(String(dictId), { ...item, __score: categoryScore });
    for (const candidate of editorAttributeOptionValueCandidates(item)) {
      const textKey = normalizeTranslationSource(candidate);
      if (!textKey) continue;
      const exactTextKey = `${attrId}:${textKey}`;
      const existingText = byText.get(exactTextKey);
      if (!existingText || categoryScore > Number(existingText.__score || 0)) byText.set(exactTextKey, { ...item, __score: categoryScore });
    }
  }
  const hydratedAttributes = attributes.map((field) => {
    const attrId = Number(field.attribute_id || field.id || 0);
    const selectedInputs = collectSelectedDictionaryRefs([field]);
    if (!selectedInputs.length) {
      for (const value of normalizeArray(field.value)) {
        const text = String(value || "").trim();
        if (text) selectedInputs.push({ value: text, label: text, display_value_zh: "" });
      }
    }
    const selectedValues = selectedInputs.map((ref) => {
      const dictId = Number(ref.dictionary_value_id || 0);
      const textKey = normalizeTranslationSource(ref.value || ref.label || "");
      const match = byExact.get(`${attrId}:${dictId}`)
        || byAttribute.get(`${attrId}:${dictId}`)
        || byId.get(String(dictId))
        || byText.get(`${attrId}:${textKey}`);
      if (!match) return ref;
      const { __score, ...clean } = match;
      return {
        ...ref,
        ...clean,
        value: clean.value || ref.value || "",
        label: clean.display_value_zh || clean.label || clean.value || ref.label || ref.value || "",
        display_value_zh: clean.display_value_zh || ref.display_value_zh || ""
      };
    }).filter((item) => item.dictionary_value_id || item.value || item.label);
    if (!selectedValues.length) return field;
    const mergedSelectedValues = mergeSelectedDictionaryOptions(selectedValues, field.selected_values || []);
    const alignedValue = alignAttributeValueToSelectedOptions(field.value, mergedSelectedValues, field.is_collection || field.type === "multiselect");
    return { ...field, value: alignedValue, selected_values: mergedSelectedValues };
  });
  return {
    ...template,
    attributes: hydratedAttributes,
    editable_payload: {
      ...(template.editable_payload || {}),
      attributes: hydratedAttributes
    }
  };
}

async function hydrateTemplateDictionaryDisplayValues(template = {}) {
  const editable = objectValue(template.editable_payload || {});
  const variants = normalizeArray(editable.variants || template.variants);
  if (!variants.length) return template;
  const categoryKey = parseSelectedDictionaryCategoryKey(template.ozon_category_id);
  const descriptionCategoryId = Number(editable.description_category_id || categoryKey.description_category_id || 0);
  const typeId = Number(editable.type_id || categoryKey.type_id || 0);
  const attributeDefinitions = await loadCachedAttributeDefinitionsForVariants({
    descriptionCategoryId,
    typeId,
    attributes: template.attributes || editable.attributes || [],
    variants
  });
  const dictionaryMatches = await loadCachedDictionaryMatchesForVariants({
    descriptionCategoryId,
    typeId,
    variants
  });
  if (!attributeDefinitions.byId.size && !dictionaryMatches.byId.size && !dictionaryMatches.byText.size) return template;
  const hydratedVariants = variants.map((variant) => hydrateVariantDictionaryDisplayValues(variant, {
    attributes: attributeDefinitions,
    dictionaries: dictionaryMatches
  }));
  return {
    ...template,
    variants: hydratedVariants,
    editable_payload: {
      ...editable,
      variants: hydratedVariants
    }
  };
}

async function loadCachedAttributeDefinitionsForVariants({ descriptionCategoryId = 0, typeId = 0, attributes = [], variants = [] } = {}) {
  const byId = new Map();
  for (const attr of normalizeArray(attributes)) {
    const id = Number(attr.attribute_id || attr.id || 0);
    if (!id) continue;
    byId.set(id, attr);
  }
  const ids = [...new Set(variants
    .flatMap((variant) => collectVariantDynamicAttributeEntries(variant))
    .map((entry) => Number(entry.attribute_id || entry.id || 0))
    .filter((id) => id && !byId.has(id)))];
  if (!ids.length) return { byId };
  const rows = await all(`
    SELECT attribute_id, name, name_zh, attribute_type, dictionary_id, is_collection
    FROM ozon_category_attributes
    WHERE status = 'active'
      AND attribute_id IN (${ids.map(() => "?").join(",")})
      ${descriptionCategoryId && typeId ? "AND description_category_id = ? AND type_id = ?" : ""}
  `, descriptionCategoryId && typeId ? [...ids, descriptionCategoryId, typeId] : ids).catch(() => []);
  for (const row of rows) {
    const id = Number(row.attribute_id || 0);
    if (!id || byId.has(id)) continue;
    byId.set(id, normalizeOzonCategoryAttributeRow(row));
  }
  return { byId };
}

async function loadCachedDictionaryMatchesForVariants({ descriptionCategoryId = 0, typeId = 0, variants = [] } = {}) {
  const entries = variants.flatMap((variant) => collectVariantDynamicAttributeEntries(variant));
  const attributeIds = [...new Set(entries.map((entry) => Number(entry.attribute_id || entry.id || 0)).filter(Boolean))];
  const dictionaryIds = [...new Set(entries
    .flatMap((entry) => normalizeArray(entry.values || entry.value).map((value) => Number(value?.dictionary_value_id || value?.id || value?.value_id || dictionaryModelIdFromAny(value) || 0)))
    .filter(Boolean))];
  const texts = [...new Set(entries
    .flatMap((entry) => normalizeArray(entry.values || entry.value).flatMap(editorAttributeOptionValueCandidates))
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
  if (!attributeIds.length || (!dictionaryIds.length && !texts.length)) return { byId: new Map(), byText: new Map() };
  const conditions = [];
  const params = [];
  if (descriptionCategoryId && typeId) {
    conditions.push("(description_category_id = ? AND type_id = ?)");
    params.push(descriptionCategoryId, typeId);
  }
  params.push(...attributeIds);
  const valueConditions = [];
  if (dictionaryIds.length) {
    valueConditions.push(`dictionary_value_id IN (${dictionaryIds.map(() => "?").join(",")})`);
    params.push(...dictionaryIds);
  }
  if (texts.length) {
    valueConditions.push(`LOWER(value) IN (${texts.map(() => "LOWER(?)").join(",")})`);
    params.push(...texts);
    valueConditions.push(`LOWER(display_value_zh) IN (${texts.map(() => "LOWER(?)").join(",")})`);
    params.push(...texts);
  }
  const rows = await all(`
    SELECT description_category_id, type_id, attribute_id, dictionary_value_id, value, display_value_zh, raw_json
    FROM ozon_attribute_values
    WHERE status = 'active'
      ${conditions.length ? `AND ${conditions.join(" AND ")}` : ""}
      AND attribute_id IN (${attributeIds.map(() => "?").join(",")})
      AND (${valueConditions.join(" OR ")})
    ORDER BY dictionary_value_id ASC
    LIMIT 2000
  `, params).catch(() => []);
  return buildCachedDictionaryMatchIndex(rows.map(normalizeOzonAttributeValueRow));
}

function collectVariantDynamicAttributeEntries(variant = {}) {
  const dynamic = objectValue(variant.dynamic_attributes || variant.dynamicAttributes);
  const entries = [];
  for (const [key, value] of Object.entries(dynamic)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      entries.push({ attribute_id: /^\d+$/.test(String(key)) ? Number(key) : 0, name: key, value });
    } else {
      entries.push({
        ...value,
        attribute_id: value.attribute_id || value.id || (/^\d+$/.test(String(key)) ? Number(key) : 0),
        name: value.name || value.attribute_name || key
      });
    }
  }
  return entries;
}

function hydrateVariantDictionaryDisplayValues(variant = {}, indexes = {}) {
  const dynamic = objectValue(variant.dynamic_attributes || variant.dynamicAttributes);
  if (!Object.keys(dynamic).length) return variant;
  const nextDynamic = {};
  for (const [key, value] of Object.entries(dynamic)) {
    const entry = collectVariantDynamicAttributeEntries({ dynamic_attributes: { [key]: value } })[0] || {};
    const attributeId = Number(entry.attribute_id || 0);
    const definition = indexes.attributes?.byId?.get(attributeId) || {};
    const hydratedValues = hydrateVariantDynamicValue(entry, indexes.dictionaries || {});
    const displayValues = normalizeArray(hydratedValues)
      .map((item) => item?.display_value_zh || item?.label || item?.value || item)
      .filter(Boolean);
    nextDynamic[key] = {
      ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
      attribute_id: attributeId || entry.attribute_id || "",
      name: definition.name_zh || definition.name || entry.name || key,
      attribute_name: definition.name_zh || definition.name || entry.attribute_name || entry.name || key,
      value: entry.value ?? "",
      values: hydratedValues,
      selected_values: hydratedValues.filter((item) => item && typeof item === "object" && Number(item.dictionary_value_id || item.id || 0)),
      label: displayValues.join(", "),
      display_value_zh: displayValues.join(", "),
      dictionary_id: entry.dictionary_id || definition.dictionary_id || "",
      type: entry.type || definition.type || definition.attribute_type || "text",
      source: entry.source || "variant_attribute"
    };
  }
  return {
    ...variant,
    dynamic_attributes: nextDynamic
  };
}

function hydrateVariantDynamicValue(entry = {}, index = {}) {
  const attributeId = Number(entry.attribute_id || entry.id || 0);
  const rawValues = normalizeArray(entry.values && entry.values.length ? entry.values : entry.value);
  if (!attributeId || !rawValues.length) return rawValues;
  return rawValues.map((value) => resolveCachedDictionaryOption(attributeId, value, index, entry.values) || value).filter(Boolean);
}

function parseSelectedDictionaryCategoryKey(value = "") {
  const [descriptionCategoryId, typeId] = String(value || "").split(":").map((item) => Number(item || 0));
  return {
    description_category_id: Number.isFinite(descriptionCategoryId) ? descriptionCategoryId : 0,
    type_id: Number.isFinite(typeId) ? typeId : 0
  };
}

function collectSelectedDictionaryRefs(attributes = []) {
  const refs = [];
  for (const field of normalizeArray(attributes)) {
    const values = Array.isArray(field?.value) ? field.value : [field?.value];
    const currentKeys = new Set(values.map((value) => normalizeTranslationSource(value)).filter(Boolean));
    for (const value of values) {
      const ref = dictionaryRefFromValue(value);
      if (ref) refs.push(ref);
    }
    for (const value of normalizeArray(field?.values)) {
      const ref = dictionaryRefFromValue(value);
      if (!ref?.dictionary_value_id) continue;
      if (currentKeys.size && currentKeys.has(normalizeTranslationSource(value?.value || value?.label || value?.name || value?.text || ""))) refs.push(ref);
    }
    for (const value of normalizeArray(field?.selected_values || field?.selectedValues)) {
      const ref = dictionaryRefFromValue(value);
      if (ref) refs.push(ref);
    }
  }
  const seen = new Set();
  return refs.filter((item) => {
    const key = String(item.dictionary_value_id || item.id || item.value || item.label || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function alignAttributeValueToSelectedOptions(value, selectedValues = [], isCollection = false) {
  const options = normalizeArray(selectedValues);
  if (!options.length) return value;
  const resolveValue = (current) => {
    const currentKey = normalizeTranslationSource(editorAttributeOptionText(current));
    const currentId = Number(current && typeof current === "object" ? current.dictionary_value_id || current.id || current.value_id || 0 : dictionaryModelIdFromAny(current));
    const matched = options.find((option) => {
      const optionId = Number(option?.dictionary_value_id || option?.id || option?.value_id || 0);
      if (currentId && optionId && currentId === optionId) return true;
      return editorAttributeOptionValueCandidates(option).map(normalizeTranslationSource).filter(Boolean).includes(currentKey);
    });
    return matched?.value || editorAttributeOptionText(current);
  };
  if (isCollection || Array.isArray(value)) return normalizeArray(value).map(resolveValue).filter(Boolean);
  return resolveValue(value);
}

function collectSelectedDictionaryTexts(attributes = []) {
  const texts = [];
  for (const field of normalizeArray(attributes)) {
    const candidates = [
      ...normalizeArray(field?.value),
      ...normalizeArray(field?.selected_values || field?.selectedValues).flatMap((item) => editorAttributeOptionValueCandidates(item))
    ];
    for (const candidate of candidates) {
      const text = String(candidate || "").trim();
      if (!text || /^dict:\d+$/i.test(text)) continue;
      if (!texts.includes(text)) texts.push(text);
    }
  }
  return texts.slice(0, 80);
}

function dictionaryRefFromValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") {
    const id = Number(value.dictionary_value_id || value.id || value.value_id || 0);
    const text = String(value.value || value.label || value.name || "").trim();
    if (!id && !text) return null;
    return {
      id,
      dictionary_value_id: id,
      value: text,
      label: String(value.display_value_zh || value.label || value.name || value.value || "").trim(),
      display_value_zh: String(value.display_value_zh || value.zh || value.cn || "").trim()
    };
  }
  const text = String(value || "").trim();
  const match = text.match(/^dict:(\d+)$/i);
  if (!match) return null;
  const id = Number(match[1] || 0);
  return { id, dictionary_value_id: id, value: "", label: "", display_value_zh: "" };
}

function mergeSelectedDictionaryOptions(...groups) {
  const seen = new Set();
  return groups.flatMap((group) => normalizeArray(group)).filter((option) => {
    const key = String(option?.dictionary_value_id || option?.id || option?.value || option?.label || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeOzonCategoryRow(row = {}) {
  const descriptionCategoryId = Number(row.description_category_id || row.descriptionCategoryId || 0);
  const typeId = Number(row.type_id || row.typeId || 0);
  const rawNameZh = row.name_zh || row.nameZh || "";
  const nameRu = row.name_ru || row.nameRu || "";
  const rawPathZh = row.path_zh || row.pathZh || "";
  const pathRu = row.path_ru || row.pathRu || "";
  const fallbackZh = descriptionCategoryId && typeId ? `寰呯炕璇戠被鐩?${descriptionCategoryId}:${typeId}` : "";
  const nameZh = rawNameZh && !hasCyrillicText(rawNameZh) ? rawNameZh : "";
  const pathZh = rawPathZh && !hasCyrillicText(rawPathZh) ? rawPathZh : "";
  const displayZh = pathZh || nameZh || fallbackZh;
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
    label: displayZh || `${descriptionCategoryId}:${typeId}`,
    name: nameZh || displayZh || nameRu,
    subLabel: [pathRu || nameRu, descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : ""].filter(Boolean).join(" / "),
    parent_description_category_id: Number(row.parent_description_category_id || 0),
    is_auto: Boolean(row.is_auto),
    source_shop_id: row.source_shop_id ? Number(row.source_shop_id) : null,
    synced_at: row.synced_at || null,
    raw: parseJson(row.raw_json, row.raw || {})
  };
}

function hasCyrillicText(value) {
  return /[\u0400-\u04ff]/.test(String(value || ""));
}

function normalizeOzonCategoryAttributeRow(row = {}) {
  const raw = parseJson(row.raw_json, row.raw || {});
  const attributeId = Number(row.attribute_id || row.attributeId || row.id || raw.id || 0);
  const nameZh = pickOzonAttributeNameZh(row, raw, attributeId);
  const name = row.name || raw.name || nameZh || inferOzonAttributeNameZh(attributeId) || "";
  return {
    id: attributeId,
    attribute_id: attributeId,
    name,
    name_zh: nameZh,
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
  const displayValueZh = row.display_value_zh || raw.display_value_zh || inferOzonAttributeDisplayValueZh(row.attribute_id || row.attributeId, value, raw);
  return {
    id: dictionaryValueId,
    dictionary_value_id: dictionaryValueId,
    description_category_id: Number(row.description_category_id || row.descriptionCategoryId || 0),
    type_id: Number(row.type_id || row.typeId || 0),
    attribute_id: Number(row.attribute_id || row.attributeId || raw.attribute_id || raw.attributeId || 0),
    value,
    label: displayValueZh || value,
    display_value_zh: displayValueZh || "",
    info: row.info || raw.info || raw.description || "",
    raw
  };
}

function inferOzonAttributeNameZh(attributeId) {
  const map = new Map([
    [85, "鍝佺墝"],
    [9048, "鍨嬪彿鍚嶇О"],
    [4191, "Description"],
    [11254, "Rich content JSON"],
    [23171, "浜у搧鏍囩"],
    [10096, "棰滆壊"],
    [7199, "鏉愯川"],
    [7202, "鏁伴噺 / 浠舵暟"],
    [7204, "姹借溅鍝佺墝"],
    [7212, "姹借溅鍨嬪彿"],
    [8229, "鍟嗗搧绫诲瀷"],
    [20189, "Part position"],
    [4384, "閰嶅"],
    [23379, "鍟嗗搧绫诲瀷"],
    [22814, "棰滆壊"],
    [22861, "鏉愯川"],
    [23188, "鍟嗗搧绫诲瀷"]
  ]);
  return map.get(Number(attributeId || 0)) || "";
}

const COMMON_ATTRIBUTE_NAME_ZH_RULES = [
  { pattern: /(斜褉械薪写|brand)/i, label: "鍝佺墝" },
  { pattern: /(薪邪蟹胁.*屑芯写械谢|屑芯写械谢|vendor model|model name|article)/i, label: "鍨嬪彿鍚嶇О" },
  { pattern: /(屑邪褌械褉懈邪谢|material)/i, label: "鏉愯川" },
  { pattern: /(褑胁械褌|color)/i, label: "棰滆壊" },
  { pattern: /(泻芯谢懈褔|褕褌\.?|pieces|quantity)/i, label: "鏁伴噺 / 浠舵暟" },
  { pattern: /(褌懈锌 褌芯胁邪褉邪|褌芯胁邪褉薪.*褌懈锌|product type|category type)/i, label: "鍟嗗搧绫诲瀷" },
  { pattern: /(泻芯屑锌谢械泻褌|泻芯屑锌谢械泻褌邪褑|set)/i, label: "濂楄" },
  { pattern: /(褉邪褋锌芯谢芯卸|屑械褋褌芯 褍褋褌邪薪芯胁|position|side)/i, label: "闆朵欢浣嶇疆" },
  { pattern: /(褋芯胁屑械褋褌|锌芯写褏芯写懈褌|compatible|fitment)/i, label: "閫傞厤杞﹀瀷" },
  { pattern: /(芯锌懈褋邪薪|summary|description)/i, label: "Description" }
];

const COMMON_ATTRIBUTE_VALUE_ZH_RULES = [
  { pattern: /^no$/i, label: "No" },
  { pattern: /^yes$/i, label: "Yes" },
  { pattern: /no\s+brand|without\s+brand/i, label: "No brand" },
  { pattern: /^1\s*(pc|pcs|piece|pieces)?$/i, label: "1 pc" },
  { pattern: /^2\s*(pc|pcs|piece|pieces)?$/i, label: "2 pcs" },
  { pattern: /^4\s*(pc|pcs|piece|pieces)?$/i, label: "4 pcs" },
  { pattern: /tpu/i, label: "TPU" },
  { pattern: /abs/i, label: "ABS" },
  { pattern: /cotton/i, label: "Cotton" },
  { pattern: /plastic/i, label: "Plastic" }
];

function cleanOzonDisplayValue(value = "") {
  return String(value || "")
    .trim()
    .replace(/^[\s,.;:|\\/]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTranslationSource(value = "") {
  return cleanOzonDisplayValue(value).toLowerCase().replace(/褢/g, "械").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function inferCommonAttributeNameZh(value = "") {
  const text = normalizeTranslationSource(value);
  if (!text) return "";
  return COMMON_ATTRIBUTE_NAME_ZH_RULES.find((item) => item.pattern.test(text))?.label || "";
}

function inferCommonAttributeValueZh(value = "") {
  const text = normalizeTranslationSource(value);
  if (!text) return "";
  return COMMON_ATTRIBUTE_VALUE_ZH_RULES.find((item) => item.pattern.test(text))?.label || "";
}

function pickOzonAttributeNameZh(row = {}, raw = {}, attributeId = 0) {
  const candidates = [
    row.name_zh,
    row.nameZh,
    row.display_name_zh,
    row.displayNameZh,
    raw.name_zh,
    raw.nameZh,
    raw.display_name_zh,
    raw.displayNameZh
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const explicitZh = candidates.find((item) => /[\u4e00-\u9fff]/.test(item));
  if (explicitZh) return explicitZh;
  const directName = String(row.name || row.attribute_name || raw.name || raw.attribute_name || "").trim();
  if (/[\u4e00-\u9fff]/.test(directName)) return directName;
  const inferredZh = inferCommonAttributeNameZh(directName || candidates[0] || "");
  if (inferredZh) return inferredZh;
  return inferOzonAttributeNameZh(attributeId) || "";
}

function inferOzonAttributeDisplayValueZh(attributeId, value = "", raw = {}) {
  const text = cleanOzonDisplayValue(value || raw.value || raw.name || "");
  if (!text) return "";
  if (/[\u4e00-\u9fff]/.test(text)) return text;
  const normalized = normalizeTranslationSource(text);
  const inferredZh = inferCommonAttributeValueZh(text);
  if (inferredZh) return inferredZh;
  const colorMap = new Map([
    ["black", "black"], ["white", "white"], ["silver", "silver"], ["gray", "gray"], ["grey", "gray"],
    ["red", "red"], ["blue", "blue"], ["green", "green"], ["gold", "gold"], ["brown", "brown"],
    ["transparent", "transparent"]
  ]);
  const materialMap = new Map([
    ["plastic", "plastic"], ["polymer", "polymer"], ["leather", "leather"],
    ["metal", "metal"], ["steel", "stainless steel"], ["stainless", "stainless steel"],
    ["tpu", "TPU"], ["abs", "ABS plastic"], ["silicone", "silicone"]
  ]);
  const brandMap = new Map([
    ["geely", "Geely"], ["belgee", "Belgee"], ["haval", "Haval"], ["chery", "Chery"],
    ["changan", "Changan"], ["omoda", "Omoda"], ["jaecoo", "Jaecoo"], ["exeed", "Exeed"],
    ["tenet", "TENET"], ["lada", "Lada"], ["toyota", "Toyota"], ["kia", "Kia"],
    ["hyundai", "Hyundai"], ["volkswagen", "Volkswagen"], ["nissan", "Nissan"]
  ]);
  const map = Number(attributeId) === 8229 || Number(attributeId) === 10096
    ? colorMap
    : Number(attributeId) === 7199
      ? materialMap
      : Number(attributeId) === 7204
        ? brandMap
        : null;
  if (map) {
    if (map.has(normalized)) return map.get(normalized);
    for (const [key, label] of map.entries()) {
      if (normalized.includes(key)) return label;
    }
  }
  if (Number(attributeId) === 7212) return text;
  return text;
  return text;
}

function estimateListingQualityFromPayload(payload = {}) {
  const items = normalizeArray(payload.items);
  const item = items[0] || payload || {};
  const attrs = normalizeArray(item.attributes || payload.attributes);
  const images = normalizeArray(item.images || payload.images || item.primary_image || item.primary_image_url).filter(Boolean);
  const videos = normalizeArray(item.video || item.videos || payload.videos).filter(Boolean);
  const richContent = attrs.find((attr) => Number(attr.id || attr.attribute_id || 0) === 11254);
  const tags = attrs.find((attr) => Number(attr.id || attr.attribute_id || 0) === 10096);
  const issues = [];
  let score = 0;

  const titleLength = String(item.name || "").trim().length;
  if (titleLength >= 45) score += 12;
  else issues.push("Title is too short");
  if (titleLength >= 80) score += 4;

  if (item.description_category_id && item.type_id) score += 10;
  else issues.push("Missing Ozon category");

  const requiredCore = [85, 9048];
  const hasCore = requiredCore.every((id) => attrs.some((attr) => Number(attr.id || attr.attribute_id || 0) === id && normalizeArray(attr.values).length));
  if (hasCore) score += 12;
  else issues.push("Missing brand or model attributes");

  const attrCount = attrs.filter((attr) => normalizeArray(attr.values).length).length;
  score += Math.min(18, attrCount * 2);
  if (attrCount < 8) issues.push("Category attribute count is low; consider adding material, color, brand/model, and quantity attributes");

  if (images.length >= 6) score += 18;
  else if (images.length >= 4) score += 13;
  else if (images.length >= 1) score += 6;
  else issues.push("Missing product images");

  if (videos.length) score += 8;
  else issues.push("Missing product video");

  const descriptionLength = String(item.description || "").trim().length;
  if (descriptionLength >= 450) score += 10;
  else if (descriptionLength >= 220) score += 6;
  else issues.push("Description is too short; add a natural product description and avoid keyword stuffing.");

  const tagCount = normalizeArray(tags?.values).length || normalizeStringList(item.tags).length;
  if (tagCount >= 15) score += 8;
  else if (tagCount >= 8) score += 5;
  else issues.push("Product tags are not enough; add more relevant search tags.");

  if (richContent && normalizeArray(richContent.values).some((value) => String(value?.value || value || "").includes("raShowcase"))) score += 10;
  else issues.push("Rich content JSON is missing or invalid");

  if (Number(item.weight || 0) && Number(item.depth || 0) && Number(item.width || 0) && Number(item.height || 0)) score += 8;
  else issues.push("Package weight or dimensions are incomplete");

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    source: "local_estimate",
    issues,
    checked_at: new Date().toISOString()
  };
}

function normalizeOzonContentRating(row = {}) {
  const rawScore = row.rating ?? row.score ?? row.total_rating ?? row.content_rating ?? row.index ?? row.rating_value;
  let score = Number(rawScore);
  if (Number.isFinite(score) && score > 0 && score <= 5) score *= 20;
  const groups = normalizeArray(row.groups || row.rating_groups || row.components || row.details);
  if ((!Number.isFinite(score) || score <= 0) && groups.length) {
    const total = groups.reduce((sum, group) => sum + Number(group.rating || group.score || group.value || 0), 0);
    const max = groups.reduce((sum, group) => sum + Number(group.max_rating || group.max_score || group.max || 0), 0);
    if (max > 0) score = (total / max) * 100;
  }
  const issues = normalizeArray(row.improve_attributes || row.recommendations || row.errors || row.warnings || row.conditions)
    .map((item) => String(item?.message || item?.name || item?.title || item || "").trim())
    .filter(Boolean);
  for (const group of groups) {
    const groupName = String(group.name || group.key || "").trim();
    const fulfilledCost = Math.max(0, ...normalizeArray(group.conditions)
      .filter((condition) => condition?.fulfilled === true)
      .map((condition) => Number(condition.cost || 0)));
    for (const condition of normalizeArray(group.conditions)) {
      const key = String(condition?.key || "").toLowerCase();
      const isMeaningfulUpgrade = Number(condition?.cost || 0) > fulfilledCost || key.includes("video") || key.includes("rich");
      if (condition?.fulfilled === false && isMeaningfulUpgrade) {
        const text = String(condition.description || condition.name || condition.key || "").trim();
        if (text) issues.push(groupName ? `${groupName}: ${text}` : text);
      }
    }
  }
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score * 100) / 100)) : 0,
    source: "ozon_rating_by_sku",
    issues,
    raw: row,
    checked_at: new Date().toISOString()
  };
}

async function refreshPublishRecordQuality(recordId) {
  const record = await row(`
    SELECT r.*, s.name AS shop_name, s.ozon_client_id, COALESCE(NULLIF(s.ozon_api_key, ''), s.api_key_hint) AS api_key_hint
    FROM listing_publish_records r
    LEFT JOIN shops s ON s.id = r.shop_id
    WHERE r.id = ?
  `, [Number(recordId)]);
  if (!record) return null;
  let quality = {
    score: 0,
    source: "ozon_rating_pending",
    issues: ["Ozon 鏆傛湭杩斿洖鐪熷疄鍐呭璇勫垎"],
    checked_at: new Date().toISOString()
  };
  try {
    const refs = extractImportedProductRefs(parseJson(record.response_json, {}), record);
    const productIds = refs.productIds.length ? refs.productIds : [Number(record.ozon_product_id || 0)].filter(Boolean);
    let skus = [];
    if (productIds.length) {
      const products = await fetchOzonProductsByIds(record, productIds);
      skus.push(...products.map((item) => item.ozon_sku || item.sku || item.fbo_sku || item.fbs_sku).filter(Boolean));
    }
    if (!skus.length) {
      const attrs = await fetchOzonProductInfoAttributes(record, {
        productIds,
        offerIds: refs.offerIds.length ? refs.offerIds : [record.offer_id].filter(Boolean),
        limit: 20
      });
      skus.push(...attrs.map((item) => item.sku || item.fbo_sku || item.fbs_sku || item.ozon_sku).filter(Boolean));
    }
    skus = [...new Set(skus
      .map((item) => String(item || "").trim())
      .filter((item) => /^\d+$/.test(item)))];
    if (skus.length) {
      const ratings = await fetchOzonProductContentRating(record, { skus });
      const normalized = ratings.map(normalizeOzonContentRating).filter((item) => item.score > 0);
      if (normalized.length) {
        quality = normalized.sort((a, b) => b.score - a.score)[0];
      }
    } else {
      quality = {
        score: 0,
        source: "ozon_rating_waiting_sku",
        issues: ["Ozon 宸茶繑鍥炰换鍔＄姸鎬侊紝浣嗘殏鏈繑鍥炲彲鏌ヨ鍐呭璇勫垎鐨?SKU"],
        checked_at: new Date().toISOString()
      };
    }
  } catch (error) {
    quality = localQualityFallbackFromRecord(record, "local_estimate_after_ozon_rating_error", ["Ozon 鍐呭璇勫垎鎺ュ彛鏌ヨ澶辫触"]);
    quality.rating_error = error.message;
  }
  await run(`
    UPDATE listing_publish_records
    SET quality_score = ?, quality_source = ?, quality_json = ?, quality_checked_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    Number(quality.score || 0),
    String(quality.source || "").slice(0, 64),
    JSON.stringify(quality),
    Number(recordId)
  ]);
  return quality;
}

function localQualityFallbackFromRecord(record = {}, source = "local_estimate", issues = []) {
  const estimate = estimateListingQualityFromPayload(parseJson(record.request_json, {}));
  return {
    ...estimate,
    source,
    issues: [...normalizeArray(issues), ...normalizeArray(estimate.issues)],
    checked_at: new Date().toISOString()
  };
}

function normalizePublishRecordRow(row = {}, options = {}) {
  const includePayload = options.includePayload !== false;
  const request = parseJson(row.request_json, {});
  const templateSnapshot = parseJson(row.template_snapshot_json, null);
  const response = includePayload ? parseJson(row.response_json, {}) : {};
  const error = parseJson(row.error_json, null);
  const quality = parseJson(row.quality_json, null) || (Number(row.quality_score || 0) ? {
    score: Number(row.quality_score || 0),
    source: row.quality_source || ""
  } : null);
  const firstItem = normalizeArray(request.items)[0] || {
    name: row.item_name || "",
    primary_image: row.item_primary_image || "",
    price: row.item_price || "",
    old_price: row.item_old_price || "",
    currency_code: row.item_currency_code || "",
    weight: row.item_weight || "",
    depth: row.item_depth || "",
    width: row.item_width || "",
    height: row.item_height || "",
    description_category_id: row.item_description_category_id || "",
    type_id: row.item_type_id || ""
  };
  const complexValues = normalizeArray(firstItem.complex_attributes)
    .flatMap((group) => normalizeArray(group.attributes))
    .flatMap((attr) => normalizeArray(attr.values).map((value) => ({ attr, value })));
  const videoUrls = complexValues
    .filter(({ attr }) => Number(attr.id || 0) === 21841)
    .map(({ value }) => String(value?.value || "").trim())
    .filter(Boolean);
  const videoCoverUrls = complexValues
    .filter(({ attr }) => Number(attr.id || 0) === 21845)
    .map(({ value }) => String(value?.value || "").trim())
    .filter(Boolean);
  const images = [
    firstItem.primary_image,
    ...normalizeArray(firstItem.images)
  ].map((item) => localListingPreviewUrl(item)).filter(Boolean);
  const prioritizedImages = prioritizeListingPreviewImages(images);
  const listImageCount = Number(row.item_image_count || 0);
  const onlinePrimaryImage = String(row.online_primary_image || "").trim();
  const qualitySource = row.quality_source || quality?.source || "";
  const hasRealQuality = String(qualitySource || "").includes("ozon_rating_by_sku");
  const realQualityScore = realOzonQualityScore(qualitySource, row.quality_score || quality?.score);
  const {
    request_json: _requestJson,
    response_json: _responseJson,
    error_json: _errorJson,
    quality_json: _qualityJson,
    item_name: _itemName,
    item_primary_image: _itemPrimaryImage,
    item_image_count: _itemImageCount,
    item_price: _itemPrice,
    item_old_price: _itemOldPrice,
    item_currency_code: _itemCurrencyCode,
    item_weight: _itemWeight,
    item_depth: _itemDepth,
    item_width: _itemWidth,
    item_height: _itemHeight,
    item_description_category_id: _itemDescriptionCategoryId,
    item_type_id: _itemTypeId,
    ...baseRow
  } = row;
  const normalized = {
    ...baseRow,
    id: Number(row.id || 0),
    draft_id: Number(row.draft_id || 0),
    shop_id: Number(row.shop_id || 0),
    row_key: `record-${row.id}`,
    row_type: "publish_record",
    source_label: draftProjectSourceText(row.offer_source || row.source_type || "listing_publish"),
    product_name: firstItem.name || row.offer_id || "",
    primary_image: prioritizedImages[0] || localListingPreviewUrl(firstItem.primary_image) || onlinePrimaryImage || "",
    fallback_image: onlinePrimaryImage,
    images: prioritizedImages,
    image_count: prioritizedImages.length || listImageCount || 0,
    video_urls: videoUrls,
    video_cover_urls: videoCoverUrls,
    price: firstItem.price || "",
    old_price: firstItem.old_price || "",
    currency_code: firstItem.currency_code || "",
    weight: firstItem.weight || "",
    depth: firstItem.depth || "",
    width: firstItem.width || "",
    height: firstItem.height || "",
    description_category_id: firstItem.description_category_id || "",
    type_id: firstItem.type_id || "",
    quality: includePayload && hasRealQuality ? quality : {
      score: includePayload ? 0 : realQualityScore,
      source: qualitySource || "ozon_rating_pending",
      issues: qualitySource ? normalizeArray(quality?.issues).slice(0, 8) : ["Ozon 鏆傛湭杩斿洖鐪熷疄鍐呭璇勫垎"]
    },
    quality_score: realQualityScore,
    quality_source: hasRealQuality ? qualitySource : (qualitySource || "ozon_rating_pending"),
    quality_checked_at: row.quality_checked_at || "",
    quality_ok: realQualityScore >= 90,
    quality_issues: hasRealQuality ? normalizeArray(quality?.issues).slice(0, includePayload ? 8 : 2) : [],
    error_summary: friendlyPublishErrorMessage(error),
    error_fix_tip: friendlyPublishErrorFixTip(error),
    error_raw_message: String(error?.raw_message || error?.original_message || "").trim()
  };
  if (includePayload) {
    normalized.response = response;
    normalized.request = request;
    normalized.error = error;
    normalized.template_snapshot = templateSnapshot;
  }
  return normalized;
}

function localListingPreviewUrl(url = "") {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const appOrigin = new URL(config.appBaseUrl || "http://localhost:8788").origin;
      const mediaOrigin = new URL(config.listingMediaPublicBaseUrl || config.appBaseUrl || "http://localhost:8788").origin;
      if ((parsed.origin === appOrigin || parsed.origin === mediaOrigin) && parsed.pathname.startsWith("/uploads/")) return parsed.pathname + parsed.search;
    } catch {
      return value;
    }
  }
  return value;
}

function isDeprioritizedListingPreviewUrl(url = "") {
  const value = String(url || "").trim();
  if (/^\/uploads\/listing-media\//i.test(value)) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const appOrigin = new URL(config.appBaseUrl || "http://localhost:8788").origin;
    return parsed.origin !== appOrigin && parsed.pathname.startsWith("/uploads/");
  } catch {
    return false;
  }
}

function prioritizeListingPreviewImages(images = []) {
  return normalizeStringList(images).sort((left, right) => {
    const leftBad = isDeprioritizedListingPreviewUrl(left) ? 1 : 0;
    const rightBad = isDeprioritizedListingPreviewUrl(right) ? 1 : 0;
    return leftBad - rightBad;
  });
}

function realOzonQualityScore(source = "", score = 0) {
  if (!String(source || "").includes("ozon_rating_by_sku")) return 0;
  return Number(score || 0);
}

function normalizeRetryPublishPayload(payload = {}) {
  const next = objectValue(payload);
  next.items = normalizeArray(next.items).map((item) => {
    const complexAttributes = normalizeArray(item.complex_attributes);
    const richValue = complexAttributes
      .flatMap((group) => normalizeArray(group.attributes || group))
      .find((attr) => String(attr.id || "").toLowerCase() === "rich_content_json")
      ?.values?.[0]?.value;
    const attributes = normalizeArray(item.attributes);
    if (richValue && !attributes.some((attr) => Number(attr.id || attr.attribute_id || 0) === 11254)) {
      attributes.push({ id: 11254, values: [{ value: String(richValue).trim() }] });
    }
    return {
      ...item,
      offer_id: String(item.offer_id || "").trim(),
      name: String(item.name || "").trim(),
      price: String(item.price || ""),
      old_price: String(item.old_price || item.price || ""),
      primary_image: String(item.primary_image || "").trim(),
      images: normalizeStringList(item.images),
      attributes,
      complex_attributes: normalizeOzonComplexAttributesForPublish(complexAttributes)
    };
  });
  return next;
}

function firstOfferId(payload = {}) {
  const first = normalizeArray(payload.items)[0] || {};
  return String(first.offer_id || "").trim();
}

async function updatePublishRecordAfterSubmit(recordId, { taskId = "", response = null, importInfo = null, status = "submitted" } = {}) {
  if (!recordId) return;
  const refs = extractImportedProductRefs(importInfo || response || {}, {});
  const importFailure = extractOzonImportInfoFailure(importInfo);
  const errorPayload = importInfo?.error
    ? buildOzonPublishErrorPayload(importInfo.error, { source: "import_info" })
    : (importFailure ? buildOzonPublishErrorPayload(importFailure, { source: "import_info" }) : null);
  await run(`
    UPDATE listing_publish_records
    SET task_id = ?, status = ?, response_json = ?, error_json = ?, ozon_product_id = ?, offer_id = COALESCE(NULLIF(offer_id, ''), ?), updated_at = CURRENT_TIMESTAMP,
        published_at = CASE WHEN ? IN ('imported', 'published', 'success') THEN CURRENT_TIMESTAMP ELSE published_at END
    WHERE id = ?
  `, [
    String(taskId || ""),
    status || "submitted",
    JSON.stringify({ submit: response, import_info: importInfo }),
    errorPayload ? JSON.stringify(errorPayload) : null,
    refs.productIds[0] ? String(refs.productIds[0]) : "",
    refs.offerIds[0] || "",
    status || "submitted",
    Number(recordId)
  ]);
  await autoBindPublishRecordInventory(recordId).catch((error) => {
    console.warn("[listing-automation] auto bind inventory failed:", error.message);
  });
}

async function autoBindPublishRecordInventory(recordId) {
  const record = await row(`
    SELECT id, shop_id, offer_id, ozon_product_id, source_product_id
    FROM listing_publish_records
    WHERE id = ? AND status <> 'deleted'
  `, [Number(recordId)]);
  const sourceProductId = Number(record?.source_product_id || 0);
  const shopId = Number(record?.shop_id || 0);
  if (!sourceProductId || !shopId) return null;
  const product = await row("SELECT id FROM products WHERE id = ? AND active = 1 LIMIT 1", [sourceProductId]).catch(() => null);
  if (!product) return null;
  const offerId = String(record.offer_id || "").trim();
  const ozonProductId = String(record.ozon_product_id || "").trim();
  if (!offerId && !ozonProductId) return null;
  const online = await row(`
    SELECT id, shop_id, ozon_sku, offer_id, name
    FROM online_products
    WHERE shop_id = ?
      AND (
        (? <> '' AND offer_id = ?)
        OR (? <> '' AND ozon_product_id = ?)
      )
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `, [shopId, offerId, offerId, ozonProductId, ozonProductId]).catch(() => null);
  if (!online) return null;
  await run("UPDATE online_products SET product_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [
    sourceProductId,
    Number(online.id)
  ]);
  const ozonSku = String(online.ozon_sku || "").trim();
  if (!ozonSku) {
    const existingByOnline = await row("SELECT id FROM sku_mappings WHERE online_product_id = ? LIMIT 1", [Number(online.id)]).catch(() => null);
    if (existingByOnline) {
      await run(`
        UPDATE sku_mappings
        SET product_id = ?, offer_id = ?, display_name = ?, active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [sourceProductId, String(online.offer_id || offerId), String(online.name || ""), Number(existingByOnline.id)]);
    }
    return { ok: true, online_product_id: Number(online.id), mapping_id: existingByOnline?.id || null };
  }
  const existing = await row("SELECT id FROM sku_mappings WHERE shop_id = ? AND ozon_sku = ? LIMIT 1", [
    shopId,
    ozonSku
  ]).catch(() => null);
  if (existing) {
    await run(`
      UPDATE sku_mappings
      SET product_id = ?, online_product_id = ?, offer_id = ?, display_name = ?, active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [sourceProductId, Number(online.id), String(online.offer_id || offerId), String(online.name || ""), Number(existing.id)]);
    return { ok: true, online_product_id: Number(online.id), mapping_id: Number(existing.id) };
  }
  const result = await run(`
    INSERT INTO sku_mappings
    (shop_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name)
    VALUES (?, ?, NULL, ?, ?, ?, ?)
  `, [
    shopId,
    sourceProductId,
    Number(online.id),
    ozonSku,
    String(online.offer_id || offerId),
    String(online.name || "")
  ]);
  return { ok: true, online_product_id: Number(online.id), mapping_id: Number(result?.insertId || 0) || null };
}

function buildOzonPublishErrorPayload(error, context = {}) {
  const rawMessage = rawOzonPublishErrorMessage(error);
  const classified = classifyOzonPublishError(rawMessage, context);
  return {
    message: classified.message,
    fix_tip: classified.fixTip,
    code: classified.code,
    raw_message: rawMessage,
    source: context.source || "ozon_product_import",
    at: new Date().toISOString()
  };
}

function rawOzonPublishErrorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error.trim();
  if (typeof error === "object") {
    const direct = [
      error.message,
      error.error,
      error.reason,
      error.detail,
      error.description,
      error.raw
    ].map((item) => String(item || "").trim()).find(Boolean);
    if (direct) {
      const code = String(error.code || error.field || "").trim();
      return code ? `${code}: ${direct}` : direct;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error).trim();
}

function classifyOzonPublishError(message = "", context = {}) {
  const raw = String(message || "").trim();
  const lower = raw.toLowerCase();
  const includesAny = (needles) => needles.some((needle) => lower.includes(needle));
  const prefix = context.source === "import_info" ? "Ozon 瀹℃牳鏈€氳繃" : "Ozon 鎻愪氦澶辫触";
  if (!raw) {
    return {
      code: "unknown",
      message: `${prefix}: no detailed reason returned yet`,
      fixTip: "Open this listing record and check title, category, price, dimensions, weight, images, and required attributes before retrying."
    };
  }
  if (includesAny(["client-id", "api-key", "unauthorized", "forbidden", "permission", "403", "401", "access denied"])) {
    return {
      code: "credential",
      message: `${prefix}: Ozon API credentials or permissions are invalid.`,
      fixTip: "Check shop Client-Id and Api-Key, and confirm product import API permission."
    };
  }
  if (includesAny(["timeout", "fetch failed", "econnreset", "etimedout", "socket", "network"])) {
    return {
      code: "network",
      message: `${prefix}: Ozon request timed out or the network is unstable.`,
      fixTip: "Keep the listing draft, refresh the network, and retry later."
    };
  }
  if (includesAny(["offer_id", "offer id", "article", "vendor code"]) && includesAny(["exist", "duplicate", "already", "used", "not unique"])) {
    return {
      code: "offer_id_duplicate",
      message: `${prefix}: offer_id is already used by this shop.`,
      fixTip: "Change offer_id in the listing editor, save, and retry."
    };
  }
  if (includesAny(["spu_already_exists", "same product", "褌邪泻芯泄 卸械 褌芯胁邪褉", "写褍斜谢懈褉褍械褌褋褟"])) {
    return {
      code: "duplicate_product",
      message: `${prefix}: Ozon detected a duplicate product card.`,
      fixTip: "Make the title, images, model, and key attributes more distinct, or bind to the existing card if it is the same product."
    };
  }
  if (includesAny(["description_decline", "褎芯褌芯 褌芯胁邪褉邪 薪械 褋芯芯褌胁械褌褋褌胁褍械褌", "褎芯褌芯", "photo", "image"]) && includesAny(["type", "褌懈锌", "attribute", "邪褌褉懈斜褍褌"])) {
    return {
      code: "image_type_mismatch",
      message: `${prefix}锛歄zon 璁や负鍟嗗搧鍥剧墖鍜屸€滅被鍨?灞炴€р€濅笉鍖归厤`,
      fixTip: "Check whether the category type attribute is selected correctly, verify the main image matches the product, and retry with a clearer main image if needed."
    };
  }
  if (includesAny(["required", "mandatory", "attribute", "邪褌褉懈斜褍褌", "褏邪褉邪泻褌械褉懈褋褌"])) {
    return {
      code: "required_attribute",
      message: `${prefix}: a required Ozon attribute is missing or invalid for this category.`,
      fixTip: "Fill required attributes in the listing editor and select dictionary values from Ozon candidates."
    };
  }
  if (includesAny(["primary_image", "image", "picture", "photo", "url", "media", "download"])) {
    return {
      code: "media",
      message: `${prefix}: image or media URL is not reachable by Ozon`,
      fixTip: "Use public image URLs for Ozon upload; local /uploads URLs are not enough unless exposed publicly."
    };
  }
  if (includesAny(["price", "old_price", "currency", "vat"])) {
    return {
      code: "price",
      message: `${prefix}: price, old price, currency, or VAT is invalid`,
      fixTip: "Check price fields and VAT before retrying."
    };
  }
  if (includesAny(["weight", "height", "width", "depth", "dimension", "size"])) {
    return {
      code: "dimension",
      message: `${prefix}: package weight or dimensions are invalid`,
      fixTip: "Fill package weight, length, width, and height using values accepted by Ozon."
    };
  }
  if (includesAny(["barcode", "gtin", "ean"])) {
    return {
      code: "barcode",
      message: `${prefix}锛氭潯鐮佸瓧娈典笉绗﹀悎 Ozon 瑕佹眰`,
      fixTip: "Check whether barcode is empty, duplicate, or invalid; apply for barcode exemption if the category allows it."
    };
  }
  if (includesAny(["name", "title"])) {
    return {
      code: "title",
      message: `${prefix}: product title does not meet Ozon requirements.`,
      fixTip: "Check whether the title is empty, too long, contains forbidden words, or mismatches the category."
    };
  }
  if (includesAny(["limit", "quota", "too many", "rate"])) {
    return {
      code: "limit",
      message: `${prefix}: Ozon rate limit or shop submission quota was exceeded.`,
      fixTip: "Retry later or submit fewer products at once."
    };
  }
  return {
    code: "ozon_raw",
    message: `${prefix}: ${cleanOzonPublishMessage(raw)}`,
    fixTip: "Adjust the field mentioned by Ozon; if unclear, check category, required attributes, media URLs, price, and package dimensions."
  };
}

function cleanOzonPublishMessage(message = "") {
  return String(message || "")
    .replace(/^Ozon\s+\/v\d+\/product\/import(?:\/info)?\s+failed:\s*/i, "")
    .replace(/^Ozon\s+\/v\d+\/product\/import(?:\/info)?\s+request failed[^:]*:\s*/i, "")
    .trim()
    .slice(0, 500) || "Ozon 娌℃湁杩斿洖鏄庣‘鍘熷洜";
}

function extractOzonImportInfoFailure(info = null) {
  if (!info || typeof info !== "object") return null;
  if (info.error) return info.error;
  const result = info.result || info;
  const items = normalizeArray(result.items || result.products);
  const failed = items.find((item) => hasBlockingOzonItemError(item) || (() => {
    const status = String(item?.status || item?.state || "").toLowerCase();
    return status.includes("fail") || status.includes("error") || status.includes("rejected");
  })());
  if (!failed) return null;
  const itemErrors = normalizeArray(failed.errors || failed.error || failed.reasons || failed.reason || failed.validation_errors)
    .map(rawOzonPublishErrorMessage)
    .filter(Boolean);
  return itemErrors.join("; ") || failed.message || failed.status || failed;
}

function hasBlockingOzonItemError(item = {}) {
  return normalizeArray(item.errors || item.validation_errors).some((error) => {
    const level = String(error?.level || error?.state || error?.status || "").toLowerCase();
    return level.includes("error") || level.includes("declined") || level.includes("rejected");
  });
}

function friendlyPublishErrorMessage(error = null) {
  if (!error) return "";
  if (typeof error === "string") return buildOzonPublishErrorPayload(error).message;
  return String(error.message || "").trim() || buildOzonPublishErrorPayload(error).message;
}

function friendlyPublishErrorFixTip(error = null) {
  if (!error) return "";
  if (typeof error === "object" && error.fix_tip) return String(error.fix_tip || "").trim();
  return buildOzonPublishErrorPayload(error).fix_tip;
}

function normalizeOzonCategorySyncJobRow(row = {}) {
  return {
    ...row,
    id: Number(row.id || 0),
    shop_id: row.shop_id ? Number(row.shop_id) : null,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, {}),
    warnings: parseJson(row.warning_json, []),
    ok: row.status === "success"
  };
}

async function startOzonCategorySyncJob({ jobType = "scheduled", shopId = null, payload = {}, session = null } = {}) {
  return insert(`
    INSERT INTO ozon_category_sync_jobs
    (job_type, shop_id, status, payload_json, created_by_person_id)
    VALUES (?, ?, 'running', ?, ?)
  `, [
    String(jobType || "scheduled").slice(0, 64),
    shopId ? Number(shopId) : null,
    JSON.stringify(payload || {}),
    personId(session)
  ]);
}

async function finishOzonCategorySyncJob(jobId, status, result = {}, error = null) {
  await run(`
    UPDATE ozon_category_sync_jobs
    SET status = ?, result_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    status,
    JSON.stringify(result || {}),
    error ? String(error.message || error).slice(0, 1000) : null,
    Number(jobId)
  ]);
}

async function appendOzonCategorySyncJobWarning(jobId, warning = {}) {
  const current = await row("SELECT warning_json FROM ozon_category_sync_jobs WHERE id = ?", [Number(jobId)]);
  const warnings = parseJson(current?.warning_json, []);
  warnings.push(warning);
  await run("UPDATE ozon_category_sync_jobs SET warning_json = ? WHERE id = ?", [JSON.stringify(warnings.slice(-200)), Number(jobId)]);
}

async function recordOzonCategoryUsage({ sourceModule = "unknown", sourceId = "", ozonCategoryId = "", categoryName = "" } = {}) {
  const parsed = parseOzonCategoryKey(ozonCategoryId);
  if (!parsed.descriptionCategoryId || !parsed.typeId) return;
  await run(`
    INSERT INTO ozon_category_usage
    (source_module, source_id, description_category_id, type_id, category_name, usage_count, last_used_at)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      category_name = VALUES(category_name),
      usage_count = usage_count + 1,
      last_used_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `, [
    String(sourceModule || "unknown").slice(0, 64),
    String(sourceId || "").slice(0, 128),
    parsed.descriptionCategoryId,
    parsed.typeId,
    String(categoryName || "").slice(0, 500)
  ]);
}

function parseOzonCategoryKey(value = "") {
  const [descriptionCategoryId, typeId] = String(value || "").split(":").map((item) => Number(item || 0));
  return {
    descriptionCategoryId: Number.isFinite(descriptionCategoryId) ? descriptionCategoryId : 0,
    typeId: Number.isFinite(typeId) ? typeId : 0
  };
}

async function usedOzonCategoriesForSync(options = {}) {
  const limit = Math.min(Math.max(Number(options.category_limit || options.categoryLimit || 80), 1), 500);
  const rows = await all(`
    SELECT description_category_id, type_id, MAX(category_name) AS category_name, MAX(last_used_at) AS last_used_at, SUM(usage_count) AS usage_count
    FROM (
      SELECT
        CAST(SUBSTRING_INDEX(ozon_category_id, ':', 1) AS UNSIGNED) AS description_category_id,
        CAST(SUBSTRING_INDEX(ozon_category_id, ':', -1) AS UNSIGNED) AS type_id,
        category_name,
        updated_at AS last_used_at,
        1 AS usage_count
      FROM listing_category_templates
      WHERE status <> 'deleted' AND ozon_category_id LIKE '%:%'
      UNION ALL
      SELECT description_category_id, type_id, category_name, last_used_at, usage_count
      FROM ozon_category_usage
    ) used_categories
    WHERE description_category_id > 0 AND type_id > 0
    GROUP BY description_category_id, type_id
    ORDER BY SUM(usage_count) DESC, MAX(last_used_at) DESC
    LIMIT ?
  `, [limit]);
  if (rows.length) return rows.map((item) => ({
    descriptionCategoryId: Number(item.description_category_id || 0),
    typeId: Number(item.type_id || 0),
    categoryName: item.category_name || ""
  }));
  const fallbackRows = await all(`
    SELECT description_category_id, type_id, name_zh AS category_name
    FROM ozon_category_mappings
    WHERE status = 'active'
    ORDER BY updated_at DESC
    LIMIT ?
  `, [Math.min(limit, 20)]);
  return fallbackRows.map((item) => ({
    descriptionCategoryId: Number(item.description_category_id || 0),
    typeId: Number(item.type_id || 0),
    categoryName: item.category_name || ""
  }));
}

function importInfoStatus(info = {}) {
  if (!info) return "ozon_status_pending";
  if (info.error) return "ozon_status_error";
  const result = info.result || info;
  const items = normalizeArray(result.items || result.products);
  if (items.some(hasBlockingOzonItemError)) return "failed";
  const rawStatus = String(result.status || items[0]?.status || "").toLowerCase();
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
  if (!shop) throw new Error("No shop with valid Ozon API credentials was found; cannot sync real categories");
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
    const ownDescriptionCategoryId = Number(node.description_category_id || node.descriptionCategoryId || node.category_id || 0);
    const descriptionCategoryId = ownDescriptionCategoryId || Number(parents.at(-1)?.descriptionCategoryId || 0);
    const typeId = Number(node.type_id || node.typeId || 0);
    const path = [...parents.map((item) => item.name).filter(Boolean), rawName].filter(Boolean);
    if (descriptionCategoryId && typeId) {
      rows.push({
        descriptionCategoryId,
        typeId,
        nameRu: rawName,
        nameZh: rawName,
        pathRu: path.join(" / "),
        pathZh: path.join(" / "),
        parentDescriptionCategoryId: Number(node.parent_description_category_id || node.parent_id || ownDescriptionCategoryId || parents.at(-1)?.descriptionCategoryId || 0),
        isAuto: node.is_auto !== undefined ? Boolean(node.is_auto) : true,
        raw: node
      });
    }
    for (const child of normalizeArray(node.children || node.childs || node.items || node.types)) {
      walk(child, [...parents, { name: rawName, descriptionCategoryId: ownDescriptionCategoryId || descriptionCategoryId }]);
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
      { name: "鍝佺墝", value: "", required: false },
      { name: "鏉愯川", value: "", required: false },
      { name: "閫傜敤杞﹀瀷/鍦烘櫙", value: "", required: false }
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
    const values = Array.isArray(item?.values) ? item.values.map((option) => ({
      id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
      dictionary_value_id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
      value: String(option?.value ?? option?.name ?? option?.text ?? option ?? "").trim(),
      label: String(option?.display_value_zh || option?.label || option?.name_zh || option?.zh || option?.value || option?.name || option?.text || option || "").trim(),
      display_value_zh: String(option?.display_value_zh || option?.name_zh || option?.zh || "").trim()
    })).filter((option) => option.value) : [];
    const attributeId = item?.attribute_id || item?.id || "";
    const isCollection = Boolean(item?.is_collection || item?.collection || String(item?.type || "").toLowerCase() === "multiselect");
    return {
      name: String(item?.name || item?.attribute_name || item?.title || inferOzonAttributeNameZh(attributeId) || (attributeId ? `灞炴€?${attributeId}` : "")).trim(),
      value: normalizeAttributeFormValue(item?.value ?? item?.attribute_value ?? (values.length ? values : ""), isCollection),
      required: Boolean(item?.required),
      attribute_id: attributeId,
      type: String(item?.type || item?.value_type || (item?.dictionary_id ? "select" : "text")).trim(),
      dictionary_id: item?.dictionary_id || "",
      is_collection: Boolean(item?.is_collection || item?.collection),
      group: String(item?.group || item?.group_name || "").trim(),
      hint: String(item?.hint || item?.description || "").trim(),
      source: String(item?.source || "ozon_copy").trim(),
      values,
      selected_values: Array.isArray(item?.selected_values || item?.selectedValues)
        ? normalizeArray(item.selected_values || item.selectedValues).map((option) => ({
          id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
          dictionary_value_id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
          value: String(option?.value ?? option?.name ?? option?.text ?? option ?? "").trim(),
          label: String(option?.display_value_zh || option?.label || option?.name_zh || option?.zh || option?.value || option?.name || option?.text || option || "").trim(),
          display_value_zh: String(option?.display_value_zh || option?.name_zh || option?.zh || "").trim()
        })).filter((option) => option.dictionary_value_id || option.value || option.label)
        : [],
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
      dictionary_value_id: option?.dictionary_value_id ?? option?.id ?? option?.value_id ?? "",
      value: String(option?.value ?? option?.name ?? option?.text ?? option ?? "").trim(),
      label: String(option?.display_value_zh || option?.label || option?.name_zh || option?.zh || option?.value || option?.name || option?.text || option || "").trim(),
      display_value_zh: String(option?.display_value_zh || option?.name_zh || option?.zh || "").trim()
    })).filter((option) => option.value);
    const fallbackValue = normalizeAttributeValue(item.value ?? item.attribute_value ?? "");
    return {
      name: String(item.name || item.attribute_name || item.title || inferOzonAttributeNameZh(item.attribute_id || item.id) || (item.id || item.attribute_id ? `灞炴€?${item.id || item.attribute_id}` : "")).trim(),
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
  add(["鏍囬", "袧邪蟹胁邪薪懈械"], facts.title, { name: "鏍囬", required: true });
  add(["鍝佺墝", "袘褉械薪写"], facts.brand, { name: "鍝佺墝", required: true, attributeIds: [85], attribute_id: 85 });
  add(["鍨嬪彿", "袦芯写械谢褜"], facts.model, { name: "鍨嬪彿鍚嶇О", required: true, attributeIds: [9048], attribute_id: 9048 });
  add(["浜у搧鏍囩", "涓诲浘鏍囩", "泻谢褞褔械胁褘械 褋谢芯胁邪", "褌械谐"], facts.tags, { name: "浜у搧鏍囩", type: "multiselect" });
  add(["Description", "Аннотация", "Описание"], facts.description, { name: "Description", attributeIds: [4191], attribute_id: 4191, type: "textarea" });
  add(["Rich content JSON", "Rich", "rich"], facts.richJson, { name: "Rich content JSON", attributeIds: [11254], attribute_id: 11254, type: "rich_json" });
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
  return prepareOzonAttributeEditModel(valueAttributes, definitions, { includeUnmapped: true }).attributes;
}

function prepareOzonAttributeEditModel(valueAttributes = [], definitions = [], options = {}) {
  const normalizedValues = normalizeArray(valueAttributes);
  const attributeContextText = normalizedValues
    .map((item) => normalizeAttributeValue(item.value || item.values || item.name || ""))
    .join(" ");
  const valuesById = new Map(normalizedValues
    .map((item) => [String(item.attribute_id || item.id || ""), item])
    .filter(([id]) => id));
  const valuesByName = new Map(normalizedValues
    .map((item) => [normalizeAttributeNameKey(item.name || item.attribute_name), item])
    .filter(([name]) => name));
  const attributes = [];
  const unmapped = [];
  const includeUnmapped = options.includeUnmapped !== false;
  for (const definition of normalizeArray(definitions)) {
    const id = String(definition.id || definition.attribute_id || "");
    const definitionName = normalizeAttributeNameKey(definition.name || definition.attribute_name);
    const value = (id && valuesById.get(id)) || (definitionName && valuesByName.get(definitionName)) || null;
    if (id) valuesById.delete(id);
    if (definitionName) valuesByName.delete(definitionName);
    const confidence = value
      ? (id && String(value.attribute_id || value.id || "") === id ? "exact" : "name_guess")
      : "empty_schema";
    const mergedOptions = mergeAttributeValueOptions(value, definition);
    const normalizedValue = normalizeMergedCategoryAttributeValue(value, definition);
    const attribute = ensureFixedDictionaryOptions({
      name: String(definition.name || definition.attribute_name || value?.name || (id ? `灞炴€?${id}` : "")).trim(),
      value: normalizedValue,
      required: Boolean(definition.is_required || definition.required || value?.required),
      attribute_id: id || value?.attribute_id || "",
      type: categoryAttributeType(definition, value),
      dictionary_id: definition.dictionary_id || value?.dictionary_id || "",
      is_collection: Boolean(definition.is_collection || definition.collection || value?.is_collection),
      group: String(definition.group_name || definition.group || value?.group || "").trim(),
      hint: String(definition.description || definition.hint || value?.hint || "").trim(),
      source: value ? "source_value+ozon_category_definition" : "ozon_category_definition",
      confidence,
      values: mergedOptions,
      raw: { definition, value: value?.raw || value || null },
      sort_order: Number(definition.sort_order || value?.sort_order || attributes.length + 1)
    });
    attributes.push(autoSelectSingleRequiredDictionaryValue(applyRequiredAttributeDefault(attribute, attributeContextText)));
  }
  for (const item of valuesById.values()) {
    unmapped.push({ ...item, confidence: "outside_category", source: item.source || "source_unmapped" });
  }
  for (const item of valuesByName.values()) {
    if (!item?.attribute_id && !attributes.some((attribute) => normalizeAttributeNameKey(attribute.name) === normalizeAttributeNameKey(item.name))) {
      unmapped.push({ ...item, confidence: "outside_category", source: item.source || "source_unmapped" });
    }
  }
  const result = attributes.filter((item) => item.name || item.value || item.attribute_id);
  if (includeUnmapped) {
    return {
      attributes: [
        ...result,
        ...unmapped.filter((item) => item.name || item.value || item.attribute_id)
      ],
      unmapped
    };
  }
  return { attributes: result, unmapped };
}

function mergeAttributeValueOptions(value = null, definition = {}) {
  const definitionValues = normalizeArray(definition.values);
  const selectedValues = extractSelectedDictionaryValues(value) || normalizeArray(value?.values).filter((item) => Number(item?.dictionary_value_id || item?.id || item?.value_id || 0) === 0);
  if (!selectedValues.length) return definitionValues;
  const definitionById = new Map(definitionValues
    .map((item) => [String(item?.dictionary_value_id || item?.id || item?.value_id || ""), item])
    .filter(([id]) => id));
  const mergedSelected = selectedValues.map((item) => {
    const id = String(item?.dictionary_value_id || item?.id || item?.value_id || "");
    const matched = id ? definitionById.get(id) : null;
    if (!matched) return item;
    return {
      ...item,
      id: item.id || item.dictionary_value_id || matched.id || matched.dictionary_value_id,
      dictionary_value_id: item.dictionary_value_id || item.id || matched.dictionary_value_id || matched.id,
      label: matched.display_value_zh || matched.label || matched.value || item.label || item.value || "",
      display_value_zh: matched.display_value_zh || matched.label || ""
    };
  });
  const seen = new Set();
  return [...mergedSelected, ...definitionValues].filter((item) => {
    const key = String(item?.dictionary_value_id || item?.id || item?.value || item?.label || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ensureFixedDictionaryOptions(attribute = {}) {
  if (Number(attribute.attribute_id || attribute.id || 0) !== 85 || !isNoBrandValue(attribute)) return attribute;
  const values = normalizeArray(attribute.values);
  const noBrandOption = {
    id: 126745801,
    dictionary_value_id: 126745801,
    value: "袧械褌 斜褉械薪写邪",
    label: "No brand",
    display_value_zh: "No brand"
  };
  if (values.some((item) => Number(item?.dictionary_value_id || item?.id || 0) === 126745801)) return attribute;
  return { ...attribute, values: [noBrandOption, ...values] };
}

function autoSelectSingleRequiredDictionaryValue(attribute = {}) {
  if (!attribute.required || !Number(attribute.dictionary_id || 0) || normalizeAttributeValue(attribute.value)) return attribute;
  const options = normalizeArray(attribute.values)
    .filter((item) => item && typeof item === "object")
    .filter((item) => Number(item.dictionary_value_id || item.id || item.value_id || 0) || String(item.value || item.name || item.text || item.label || "").trim());
  if (options.length !== 1) return attribute;
  const option = options[0];
  const selected = {
    ...option,
    dictionary_value_id: Number(option.dictionary_value_id || option.id || option.value_id || 0) || option.dictionary_value_id,
    value: String(option.value || option.name || option.text || option.label || "").trim()
  };
  const displayValue = dictionaryOptionDisplayValue(selected, options);
  return {
    ...attribute,
    value: attribute.is_collection ? [displayValue].filter(Boolean) : displayValue,
    selected_values: [selected]
  };
}

function applyRequiredAttributeDefault(attribute = {}, contextText = "") {
  if (!attribute.required || normalizeAttributeValue(attribute.value)) return attribute;
  const attributeId = Number(attribute.attribute_id || attribute.id || 0);
  const name = normalizeTranslationSource(attribute.name || attribute.attribute_name || "");
  const context = normalizeTranslationSource(contextText);
  if (attributeId === 8229 && /褌械褉屑芯褕邪锌|褕邪锌芯褔.*胁芯谢芯褋|鍔犵儹鍙戝附|鎶ゅ彂甯絴锌芯写芯谐褉械胁.*胁芯谢芯褋|hair.*cap|heating.*cap/.test(context)) {
    return selectRequiredDictionaryDefault(attribute, ["孝械褉屑芯褕邪锌泻邪", "鍔犵儹鍙戝附"]);
  }
  if (attributeId === 23487 || /manufacturer|懈蟹谐芯褌芯胁懈褌械谢|锌褉芯懈蟹胁芯写懈褌械谢|鍒堕€犲晢/.test(name)) {
    return { ...attribute, value: "袧械褌 斜褉械薪写邪" };
  }
  if (attributeId === 4389 || /country of origin|origin country|\u539f\u4ea7\u56fd/i.test(name)) {
    return selectRequiredDictionaryDefault(attribute, ["China", "\u4e2d\u56fd"]);
  }
  return attribute;
}

function selectRequiredDictionaryDefault(attribute = {}, candidates = []) {
  const fallback = candidates.find(Boolean) || "";
  const options = normalizeArray(attribute.values);
  const option = findDictionaryOptionByTexts(options, candidates);
  if (!option) return { ...attribute, value: attribute.is_collection ? [fallback].filter(Boolean) : fallback };
  const selected = {
    ...option,
    dictionary_value_id: Number(option.dictionary_value_id || option.id || option.value_id || 0) || option.dictionary_value_id,
    value: String(option.value || option.name || option.text || option.label || fallback || "").trim()
  };
  const displayValue = dictionaryOptionDisplayValue(selected, options) || fallback;
  return {
    ...attribute,
    value: attribute.is_collection ? [displayValue].filter(Boolean) : displayValue,
    selected_values: [selected]
  };
}

function findDictionaryOptionByTexts(options = [], texts = []) {
  const targets = new Set(normalizeArray(texts).map((item) => normalizeTranslationSource(item)).filter(Boolean));
  if (!targets.size) return null;
  return normalizeArray(options).find((option) => {
    const fields = [
      option?.value,
      option?.name,
      option?.text,
      option?.label,
      option?.display_value,
      option?.display_value_zh,
      option?.ru,
      option?.zh,
      option?.en
    ];
    return fields.some((field) => targets.has(normalizeTranslationSource(field)));
  }) || null;
}

function normalizeAttributeFormValue(value, isCollection = false) {
  if (!isCollection) return normalizeAttributeValue(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object") return item.value ?? item.name ?? item.text ?? "";
      return item;
    }).map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (value && typeof value === "object") {
    return normalizeStringList(value.value || value.name || value.text || "");
  }
  return normalizeStringList(value);
}

function normalizeMergedCategoryAttributeValue(value = null, definition = {}) {
  if (!value) return "";
  const isCollection = Boolean(definition.is_collection || definition.collection || value.is_collection || value.type === "multiselect");
  const hasExplicitValue = value.value !== undefined && value.value !== null && value.value !== "";
  const hasExplicitValues = Array.isArray(value.values) && value.values.length > 0;
  if (isCollection) {
    const selectedDictionaryValues = extractSelectedDictionaryValues(value);
    if (selectedDictionaryValues?.length) return selectedDictionaryValues
      .map((item) => dictionaryOptionDisplayValue(item, definition.values))
      .filter(Boolean);
    if (Array.isArray(value.value)) return normalizeCollectionValueAgainstDictionary(value.value, definition.values);
    if (hasExplicitValues) {
      return normalizeCollectionValueAgainstDictionary(value.values.map((item) => item?.value || item?.name || item?.text || item), definition.values);
    }
    if (hasExplicitValue) return normalizeCollectionValueAgainstDictionary(normalizeStringList(value.value || ""), definition.values);
    return [];
  }
  if (Array.isArray(value.value)) return value.value.map((item) => dictionaryOptionDisplayValue(item, definition.values)).filter(Boolean).join(", ");
  if (!hasExplicitValue && !hasExplicitValues) return "";
  return dictionaryOptionDisplayValue(value.value ?? value.values?.[0] ?? "", definition.values) || "";
}

function extractSelectedDictionaryValues(source = null, depth = 0) {
  if (!source || depth > 6) return null;
  if (Array.isArray(source)) {
    const selected = source.filter((item) => item && typeof item === "object"
      && Number(item.dictionary_value_id || item.id || item.value_id || 0));
    return selected.length ? selected : null;
  }
  if (typeof source !== "object") return null;
  const rawValues = extractSelectedDictionaryValues(source.raw?.value?.values, depth + 1);
  if (rawValues?.length) return rawValues;
  const rawDirectValues = extractSelectedDictionaryValues(source.raw?.values, depth + 1);
  if (rawDirectValues?.length) return rawDirectValues;
  const nestedValueValues = extractSelectedDictionaryValues(source.value?.values, depth + 1);
  if (nestedValueValues?.length) return nestedValueValues;
  const nestedValue = source.value && typeof source.value === "object" ? extractSelectedDictionaryValues(source.value, depth + 1) : null;
  return nestedValue?.length ? nestedValue : null;
}

function dictionaryModelIdFromAny(value = "") {
  const text = typeof value === "object"
    ? String(value?.value || value?.label || value?.name || value?.text || "").trim()
    : String(value || "").trim();
  const match = text.match(/^dict:(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function dictionaryOptionDisplayValue(value = "", dictionaryValues = []) {
  const raw = value && typeof value === "object" ? value : { value };
  const dictionaryValueId = Number(raw.dictionary_value_id || raw.id || raw.value_id || dictionaryModelIdFromAny(raw) || 0);
  if (dictionaryValueId) {
    const matched = normalizeArray(dictionaryValues).find((item) => Number(item?.dictionary_value_id || item?.id || item?.value_id || 0) === dictionaryValueId);
    const matchedValue = String(matched?.value || matched?.name || matched?.text || matched?.label || "").trim();
    if (matchedValue) return matchedValue;
  }
  const text = String(raw.value || raw.name || raw.text || raw.label || "").trim();
  return dictionaryModelIdFromAny(text) ? "" : text;
}

function normalizeCollectionValueAgainstDictionary(values = [], dictionaryValues = []) {
  const tokens = normalizeArray(values).map((item) => String(item || "").trim()).filter(Boolean);
  if (!tokens.length) return [];
  const resolvedTokens = tokens
    .map((item) => dictionaryOptionDisplayValue(item, dictionaryValues))
    .filter(Boolean);
  if (resolvedTokens.length && resolvedTokens.length === tokens.length) return [...new Set(resolvedTokens)];
  const dictionary = normalizeArray(dictionaryValues)
    .map((item) => String(item?.value || item?.name || item?.label || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!dictionary.length) return tokens;
  const normalizedDictionary = dictionary.map((value) => ({ value, key: normalizeDictionaryText(value) }));
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let matched = null;
    let matchedEnd = index;
    for (let end = Math.min(tokens.length, index + 8); end > index; end -= 1) {
      const phrase = tokens.slice(index, end).join(" ");
      const key = normalizeDictionaryText(phrase);
      const exact = normalizedDictionary.find((item) => item.key === key);
      if (exact) {
        matched = exact.value;
        matchedEnd = end;
        break;
      }
    }
    if (matched) {
      result.push(matched);
      index = matchedEnd - 1;
    } else {
      result.push(tokens[index]);
    }
  }
  return [...new Set(result)];
}

async function mergeCachedCategoryAttributeDefinitions(valueAttributes = [], descriptionCategoryId, typeId, options = {}) {
  const definitions = await listingOzonCategoryAttributes({
    description_category_id: descriptionCategoryId,
    type_id: typeId,
    value_limit: 80,
    sync_values: options.syncValues !== false && options.sync_values !== false,
    auto_sync: options.autoSync !== false && options.auto_sync !== false
  }).catch(() => []);
  const model = prepareOzonAttributeEditModel(valueAttributes, definitions, { includeUnmapped: false });
  const inferred = inferCollectedAttributeValues(model.attributes);
  const resolved = await preResolveAttributeDictionaryValues(inferred, descriptionCategoryId, typeId);
  return hydrateAttributeNamesFromAnyCategory(resolved);
}

async function preResolveAttributeDictionaryValues(attributes = [], descriptionCategoryId, typeId) {
  const categoryId = Number(descriptionCategoryId || 0);
  const categoryTypeId = Number(typeId || 0);
  if (!categoryId || !categoryTypeId) return attributes;
  const plans = normalizeArray(attributes)
    .map((attribute) => buildAttributeDictionaryResolvePlan(attribute))
    .filter((plan) => plan.attributeId && (plan.dictionaryIds.length || plan.texts.length));
  if (!plans.length) return attributes;
  const rows = await loadCachedDictionaryMatches(categoryId, categoryTypeId, plans).catch(() => []);
  if (!rows.length) return attributes;
  const index = buildCachedDictionaryMatchIndex(rows);
  return normalizeArray(attributes).map((attribute) => applyCachedDictionaryResolution(attribute, index));
}

function buildAttributeDictionaryResolvePlan(attribute = {}) {
  const attributeId = Number(attribute.attribute_id || attribute.id || 0);
  const dictionaryIds = [];
  const texts = [];
  const pushId = (value) => {
    const id = Number(value || 0);
    if (id && !dictionaryIds.includes(id)) dictionaryIds.push(id);
  };
  const pushText = (value) => {
    const text = String(value || "").trim();
    if (text && !texts.includes(text)) texts.push(text);
  };
  for (const value of normalizeArray(attribute.value)) collectDictionaryLookupCandidates(value, pushId, pushText);
  for (const value of normalizeArray(attribute.selected_values || attribute.selectedValues)) collectDictionaryLookupCandidates(value, pushId, pushText);
  for (const value of normalizeArray(attribute.values)) {
    const optionId = Number(value?.dictionary_value_id || value?.id || value?.value_id || 0);
    if (!optionId) continue;
    const optionTexts = editorAttributeOptionValueCandidates(value).map(normalizeTranslationSource).filter(Boolean);
    const currentTexts = normalizeArray(attribute.value).map((item) => normalizeTranslationSource(editorAttributeOptionText(item))).filter(Boolean);
    if (currentTexts.some((item) => optionTexts.includes(item))) collectDictionaryLookupCandidates(value, pushId, pushText);
  }
  return { attributeId, dictionaryIds, texts };
}

function collectDictionaryLookupCandidates(value, pushId, pushText) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "object") {
    pushId(value.dictionary_value_id || value.id || value.value_id);
    for (const candidate of editorAttributeOptionValueCandidates(value)) pushText(candidate);
    return;
  }
  const text = String(value || "").trim();
  const dictId = dictionaryModelIdFromAny(text);
  if (dictId) pushId(dictId);
  else pushText(text);
}

async function loadCachedDictionaryMatches(descriptionCategoryId, typeId, plans = []) {
  const attributeIds = [...new Set(plans.map((plan) => plan.attributeId).filter(Boolean))];
  const dictionaryIds = [...new Set(plans.flatMap((plan) => plan.dictionaryIds).filter(Boolean))];
  const texts = [...new Set(plans.flatMap((plan) => plan.texts).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!attributeIds.length || (!dictionaryIds.length && !texts.length)) return [];
  const conditions = [];
  const params = [descriptionCategoryId, typeId, ...attributeIds];
  if (dictionaryIds.length) {
    conditions.push(`dictionary_value_id IN (${dictionaryIds.map(() => "?").join(",")})`);
    params.push(...dictionaryIds);
  }
  if (texts.length) {
    conditions.push(`LOWER(value) IN (${texts.map(() => "LOWER(?)").join(",")})`);
    params.push(...texts);
    conditions.push(`LOWER(display_value_zh) IN (${texts.map(() => "LOWER(?)").join(",")})`);
    params.push(...texts);
  }
  const limit = Math.min(Math.max(attributeIds.length * Math.max(texts.length + dictionaryIds.length, 1), 50), 2000);
  params.push(limit);
  const rows = await all(`
    SELECT description_category_id, type_id, attribute_id, dictionary_value_id, value, display_value_zh, raw_json
    FROM ozon_attribute_values
    WHERE description_category_id = ? AND type_id = ? AND status = 'active'
      AND attribute_id IN (${attributeIds.map(() => "?").join(",")})
      AND (${conditions.join(" OR ")})
    ORDER BY dictionary_value_id ASC
    LIMIT ?
  `, params);
  return rows.map(normalizeOzonAttributeValueRow);
}

function buildCachedDictionaryMatchIndex(rows = []) {
  const byId = new Map();
  const byText = new Map();
  for (const row of normalizeArray(rows)) {
    const attributeId = Number(row.attribute_id || row.attributeId || row.raw?.attribute_id || 0);
    const dictionaryValueId = Number(row.dictionary_value_id || row.id || 0);
    if (!attributeId) continue;
    if (dictionaryValueId) byId.set(`${attributeId}:${dictionaryValueId}`, row);
    for (const candidate of editorAttributeOptionValueCandidates(row)) {
      const key = normalizeTranslationSource(candidate);
      if (key && !byText.has(`${attributeId}:${key}`)) byText.set(`${attributeId}:${key}`, row);
    }
  }
  return { byId, byText };
}

function applyCachedDictionaryResolution(attribute = {}, index = {}) {
  const attributeId = Number(attribute.attribute_id || attribute.id || 0);
  if (!attributeId) return attribute;
  const selectedInputs = normalizeArray(attribute.selected_values || attribute.selectedValues).length
    ? normalizeArray(attribute.selected_values || attribute.selectedValues)
    : normalizeArray(attribute.value);
  const resolvedSelected = selectedInputs
    .map((value) => resolveCachedDictionaryOption(attributeId, value, index, attribute.values))
    .filter(Boolean);
  if (!resolvedSelected.length) return attribute;
  const selectedValues = mergeSelectedDictionaryOptions(resolvedSelected, attribute.selected_values || []);
  const values = mergeSelectedDictionaryOptions(resolvedSelected, attribute.values || []);
  const resolvedValue = attribute.is_collection || Array.isArray(attribute.value)
    ? selectedValues.map((item) => item.value || item.label).filter(Boolean)
    : (selectedValues[0]?.value || attribute.value || "");
  return {
    ...attribute,
    value: resolvedValue,
    selected_values: selectedValues,
    values
  };
}

function resolveCachedDictionaryOption(attributeId, value, index = {}, localValues = []) {
  const rawId = value && typeof value === "object" ? value.dictionary_value_id || value.id || value.value_id : dictionaryModelIdFromAny(value);
  const dictionaryValueId = Number(rawId || 0);
  const texts = value && typeof value === "object" ? editorAttributeOptionValueCandidates(value) : [String(value || "").trim()];
  const localMatch = findLocalDictionaryOption(attributeId, dictionaryValueId, texts, localValues);
  const cached = (dictionaryValueId ? index.byId?.get(`${attributeId}:${dictionaryValueId}`) : null)
    || texts.map((text) => index.byText?.get(`${attributeId}:${normalizeTranslationSource(text)}`)).find(Boolean)
    || localMatch;
  if (!cached) return null;
  const id = Number(cached.dictionary_value_id || cached.id || dictionaryValueId || 0);
  const fallbackText = texts.find(Boolean) || "";
  const canonicalValue = String(cached.value || fallbackText || "").trim();
  const displayValueZh = String(cached.display_value_zh || cached.label || "").trim();
  return {
    id,
    dictionary_value_id: id,
    value: canonicalValue,
    label: displayValueZh || canonicalValue,
    display_value_zh: displayValueZh
  };
}

function findLocalDictionaryOption(attributeId, dictionaryValueId = 0, texts = [], values = []) {
  const normalizedTexts = texts.map(normalizeTranslationSource).filter(Boolean);
  return normalizeArray(values).find((option) => {
    const optionId = Number(option?.dictionary_value_id || option?.id || option?.value_id || 0);
    if (dictionaryValueId && optionId === dictionaryValueId) return true;
    const optionTexts = editorAttributeOptionValueCandidates(option).map(normalizeTranslationSource).filter(Boolean);
    return normalizedTexts.some((text) => optionTexts.includes(text));
  }) || null;
}

function inferCollectedAttributeValues(attributes = []) {
  return normalizeArray(attributes).map((item) => {
    if (item.value !== undefined && item.value !== null && item.value !== "" && (!Array.isArray(item.value) || item.value.length)) return item;
    const inferred = inferCollectedAttributeValue(item);
    return inferred === undefined ? item : { ...item, value: inferred, source: `${item.source || "ozon_category_definition"}+inferred` };
  });
}

function inferCollectedAttributeValue(attribute = {}) {
  const id = Number(attribute.attribute_id || attribute.id || 0);
  const values = normalizeArray(attribute.values);
  const byText = (...patterns) => {
    const matched = values.find((option) => patterns.some((pattern) => new RegExp(pattern, "i").test(String(option.value || option.label || option.name || ""))));
    return matched?.value || matched?.label || "";
  };
  if (id === 85) return byText("No brand", "??? ??????", "no brand") || "No brand";
  if (id === 9782) return byText("?? ????", "???????", "no", "???") || "";
  if (id === 8229) return byText("????????", "?????", "????????", "????", "spray", "gel") || "";
  return undefined;
}

async function hydrateAttributeNamesFromAnyCategory(attributes = []) {
  const needIds = normalizeArray(attributes)
    .filter((item) => item.attribute_id && /^灞炴€s+\d+$/i.test(String(item.name || "")))
    .map((item) => Number(item.attribute_id || 0))
    .filter(Boolean);
  const ids = [...new Set(needIds)];
  if (!ids.length) return attributes;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await all(`
    SELECT attribute_id, MAX(NULLIF(name, '')) AS name, MAX(NULLIF(attribute_type, '')) AS attribute_type,
           MAX(dictionary_id) AS dictionary_id, MAX(is_collection) AS is_collection
    FROM ozon_category_attributes
    WHERE attribute_id IN (${placeholders}) AND status = 'active'
    GROUP BY attribute_id
  `, ids).catch(() => []);
  const byId = new Map(rows.map((item) => [String(item.attribute_id), item]));
  return attributes.map((item) => {
    const cached = byId.get(String(item.attribute_id || ""));
    if (!cached?.name) return item;
    return {
      ...item,
      name: cached.name,
      type: item.type && item.type !== "text" ? item.type : categoryAttributeType(cached, item),
      dictionary_id: item.dictionary_id || cached.dictionary_id || "",
      is_collection: Boolean(item.is_collection || cached.is_collection)
    };
  });
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
    attributeValueByNames(attributes, ["Description", "Аннотация", "Описание"], [4191]) ||
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
    attributeValueByNames(attributes, ["JSON rich content", "Rich", "rich"], [11254]) ||
    "";
  if (!value) return { value: null, text: "" };
  if (typeof value === "string") return { value, text: value };
  return { value, text: JSON.stringify(value, null, 2) };
}

function splitTagValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
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
  const lengthRaw = detail.depth ?? detail.length ?? detail.package_length ?? attributeValueByNames(attributes, ["闀垮害", "袛谢懈薪邪"]);
  const widthRaw = detail.width ?? detail.package_width ?? attributeValueByNames(attributes, ["瀹藉害", "楔懈褉懈薪邪"]);
  const heightRaw = detail.height ?? detail.package_height ?? attributeValueByNames(attributes, ["楂樺害", "袙褘褋芯褌邪"]);
  const weightUnit = String(detail.weight_unit || "").toLowerCase();
  return {
    length_cm: normalizeDimensionToMm(lengthRaw, unit),
    width_cm: normalizeDimensionToMm(widthRaw, unit),
    height_cm: normalizeDimensionToMm(heightRaw, unit),
    weight_g: normalizeWeightToGram(detail.weight ?? detail.package_weight ?? attributeValueByNames(attributes, ["閲嶉噺", "袙械褋"]), weightUnit)
  };
}

function normalizeDimensionToMm(value, unit = "") {
  const number = numberFromOzonValue(value);
  if (!number) return 0;
  if (unit.includes("cm") || unit.includes("褋m") || unit.includes("褋屑")) return number * 10;
  if (unit.includes("m") && !unit.includes("mm") && !unit.includes("屑屑")) return number * 1000;
  return number;
}

function normalizeWeightToGram(value, unit = "") {
  const number = numberFromOzonValue(value);
  if (!number) return 0;
  if (unit.includes("kg") || unit.includes("泻谐")) return number * 1000;
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

function normalizePublishProjectRow(row = {}) {
  return {
    ...row,
    row_key: `record-${row.id}`,
    row_type: "publish_record",
    source_label: draftProjectSourceText(row.offer_source || row.source_type || "listing_publish")
  };
}

function normalizeDraftProjectRow(row = {}) {
  const images = normalizeArray(row.source_images)
    .map((item) => typeof item === "string" ? item : item?.url || "")
    .filter(Boolean);
  const status = Number(row.shop_copy_count || 0) > 0 ? "waiting" : "editing";
  return {
    ...row,
    row_key: "draft-" + row.id,
    row_type: "draft",
    status,
    source_label: draftProjectSourceText(row.ai_payload?.source || row.manual_facts?.source || row.source_type || "listing_draft"),
    shop_name: Number(row.shop_copy_count || 0) > 0 ? "Shop copies: " + row.shop_copy_count : "Draft not assigned",
    offer_id: row.internal_code || ("DRAFT-" + row.id),
    primary_image: images[0] || "",
    images,
    image_count: images.length,
    video_urls: [],
    quality_score: 0,
    quality_source: "",
    price: row.sale_price || "",
    currency_code: "RMB",
    error_summary: "",
    error_fix_tip: ""
  };
}

function draftProjectSourceText(source = "") {
  const value = String(source || "").toLowerCase();
  if (value.includes("ai_optimization")) return "AI optimization";
  if (value.includes("online_product")) return "Online product";
  if (value.includes("collect")) return "Collected data";
  if (value.includes("listing_publish")) return "Listing publish";
  if (value.includes("publish_record")) return "Publish record";
  return "Listing publish";
}

function draftProjectMatchesQuery(row = {}, query = {}) {
  const nameKeyword = cleanText(query.nameQuery || query.name || "", 120).toLowerCase();
  const keyword = cleanText(query.query || query.keyword || "", 160).toLowerCase();
  const quality = cleanText(query.quality || "all", 40);
  const status = cleanText(query.status || "all", 40);
  const shopId = String(query.shopId || query.shop_id || "all");
  if (quality !== "all") return false;
  if (status && status !== "all" && row.status !== status) return false;
  if (shopId !== "all" && row.status !== "waiting") return false;
  if (nameKeyword && ![row.product_name, row.offer_id].some((value) => String(value || "").toLowerCase().includes(nameKeyword))) return false;
  if (keyword && ![row.product_name, row.offer_id, row.category_name, row.template_name, row.source_label].some((value) => String(value || "").toLowerCase().includes(keyword))) return false;
  return true;
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

async function buildMappingDiagnostics({
  sourceType = "",
  sourceId = "",
  title = "",
  category = {},
  attributes = [],
  variants = [],
  images = [],
  normalizationDiagnostics = {},
  shopId = "",
  autoSync = true
} = {}) {
  const descriptionCategoryId = Number(category.description_category_id || category.descriptionCategoryId || 0);
  const typeId = Number(category.type_id || category.typeId || 0);
  const normalizedAttributes = normalizeAttributes(attributes);
  const categoryAttributes = descriptionCategoryId && typeId
    ? await listingOzonCategoryAttributes({
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      shop_id: shopId,
      value_limit: 120,
      sync_values: autoSync,
      auto_sync: autoSync
    }).catch(() => [])
    : [];
  const schemaById = new Map(categoryAttributes.map((item) => [String(item.attribute_id || item.id || ""), item]).filter(([id]) => id));
  const schemaByName = new Map(categoryAttributes.map((item) => [normalizeAttributeNameKey(item.name || item.attribute_name), item]).filter(([name]) => name));
  const matched = [];
  const nameMatched = [];
  const outsideCategory = [];
  const dictionaryUnresolved = [];
  const duplicateIds = [];
  const seenIds = new Set();

  for (const attr of normalizedAttributes) {
    const attributeId = String(attr.attribute_id || attr.id || "").trim();
    const nameKey = normalizeAttributeNameKey(attr.name || attr.attribute_name);
    const schema = (attributeId && schemaById.get(attributeId)) || (nameKey && schemaByName.get(nameKey)) || null;
    const hasValue = hasMappingAttributeValue(attr);
    if (attributeId && seenIds.has(attributeId)) {
      duplicateIds.push(compactDiagnosticAttribute(attr, schema));
    }
    if (attributeId) seenIds.add(attributeId);
    if (schema) {
      const item = compactDiagnosticAttribute(attr, schema);
      if (!attributeId && nameKey) nameMatched.push(item);
      matched.push(item);
      if (hasValue && Number(schema.dictionary_id || attr.dictionary_id || 0) && !hasDictionaryValueId(attr)) {
        dictionaryUnresolved.push(item);
      }
    } else if (attributeId || hasValue || attr.name) {
      outsideCategory.push(compactDiagnosticAttribute(attr, null));
    }
  }

  const missingRequired = categoryAttributes
    .filter((schema) => Boolean(schema.required || schema.is_required))
    .filter((schema) => {
      const id = String(schema.attribute_id || schema.id || "");
      const nameKey = normalizeAttributeNameKey(schema.name || schema.attribute_name);
      const attr = normalizedAttributes.find((item) => {
        if (id && String(item.attribute_id || item.id || "") === id) return true;
        return nameKey && normalizeAttributeNameKey(item.name || item.attribute_name) === nameKey;
      });
      return !hasMappingAttributeValue(attr);
    })
    .map((schema) => compactDiagnosticAttribute({}, schema));

  const issues = [];
  if (!descriptionCategoryId || !typeId) {
    issues.push({
      level: "blocker",
      code: "category_missing",
      title: "Missing Ozon category",
      message: "Missing description_category_id/type_id, attributes cannot be validated against the Ozon schema."
    });
  }
  for (const item of missingRequired.slice(0, 20)) {
    issues.push({
      level: "blocker",
      code: "required_missing",
      title: "Required attribute missing",
      message: `${item.name || `attribute ${item.attribute_id}`} has no submit-ready value.`,
      attribute: item
    });
  }
  for (const item of dictionaryUnresolved.slice(0, 20)) {
    issues.push({
      level: "warning",
      code: "dictionary_unresolved",
      title: "Dictionary value unresolved",
      message: `${item.name || `attribute ${item.attribute_id}`} has a display value but no confirmed dictionary_value_id.`,
      attribute: item
    });
  }
  for (const item of outsideCategory.slice(0, 20)) {
    issues.push({
      level: "warning",
      code: "outside_category_attribute",
      title: "Attribute outside current category",
      message: `${item.name || `attribute ${item.attribute_id || "-"}`} is not defined in the current Ozon category.`,
      attribute: item
    });
  }
  for (const item of nameMatched.slice(0, 20)) {
    issues.push({
      level: "info",
      code: "name_only_match",
      title: "Matched by name only",
      message: `${item.name || "attribute"} has no attribute_id and was matched by name only.`,
      attribute: item
    });
  }
  for (const item of duplicateIds.slice(0, 20)) {
    issues.push({
      level: "warning",
      code: "duplicate_attribute",
      title: "Duplicate attribute",
      message: `${item.name || `attribute ${item.attribute_id}`} appears more than once in the template.`,
      attribute: item
    });
  }

  const blockers = issues.filter((item) => item.level === "blocker");
  const warnings = issues.filter((item) => item.level === "warning");
  const score = Math.max(0, Math.min(100,
    100
    - blockers.length * 18
    - warnings.length * 5
    - nameMatched.length * 2
    - (descriptionCategoryId && typeId && !categoryAttributes.length ? 10 : 0)
  ));
  return {
    ok: blockers.length === 0,
    score,
    source: {
      type: sourceType,
      id: sourceId,
      title
    },
    category: {
      ok: Boolean(descriptionCategoryId && typeId),
      description_category_id: descriptionCategoryId || "",
      type_id: typeId || "",
      ozon_category_id: category.ozon_category_id || category.ozonCategoryId || (descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : ""),
      name: category.category_name || category.name || ""
    },
    summary: {
      issues: issues.length,
      blockers: blockers.length,
      warnings: warnings.length,
      schema_attributes: categoryAttributes.length,
      template_attributes: normalizedAttributes.length,
      matched_attributes: matched.length,
      missing_required: missingRequired.length,
      dictionary_unresolved: dictionaryUnresolved.length,
      outside_category: outsideCategory.length,
      name_only_matches: nameMatched.length,
      variants: normalizeArray(variants).length,
      images: normalizeImages(images).length
    },
    issues,
    groups: {
      missing_required: missingRequired,
      dictionary_unresolved: dictionaryUnresolved,
      outside_category: outsideCategory,
      name_only_matches: nameMatched,
      duplicate_attributes: duplicateIds,
      matched_attributes: matched.slice(0, 120)
    },
    normalization_diagnostics: normalizationDiagnostics || {}
  };
}

function hasMappingAttributeValue(attr = {}) {
  if (!attr) return false;
  if (Array.isArray(attr.value)) return attr.value.length > 0;
  if (attr.value !== undefined && attr.value !== null && String(attr.value).trim() !== "") return true;
  return normalizeArray(attr.values).some((value) => {
    if (value && typeof value === "object") return String(value.value || value.name || value.text || value.dictionary_value_id || value.id || "").trim();
    return String(value || "").trim();
  });
}

function hasDictionaryValueId(attr = {}) {
  return normalizeArray(attr.values).some((value) => Number(value?.dictionary_value_id || value?.id || value?.value_id || 0));
}

function compactDiagnosticAttribute(attr = {}, schema = null) {
  const source = schema || attr || {};
  return {
    attribute_id: String(source.attribute_id || source.id || attr.attribute_id || attr.id || ""),
    name: String(source.name_zh || source.name || source.attribute_name || attr.name || "").trim(),
    value: attr.value ?? "",
    required: Boolean(source.required || source.is_required || attr.required),
    dictionary_id: source.dictionary_id || attr.dictionary_id || "",
    type: source.type || source.attribute_type || attr.type || "",
    source: attr.source || "",
    matched_by: schema ? (attr.attribute_id || attr.id ? "attribute_id" : "name") : "none"
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

function cleanText(value, maxLength = 255) {
  const text = String(value ?? "").trim();
  return maxLength ? text.slice(0, maxLength) : text;
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
    const error = new Error("璇蜂娇鐢?multipart/form-data 涓婁紶绱犳潗");
    error.status = 400;
    throw error;
  }
  const body = await readRequestBuffer(req, LISTING_MEDIA_MAX_BYTES + 1024 * 1024);
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  let file = null;
  for (const part of splitMultipartBuffer(body, boundary)) {
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headerText = part.subarray(0, separator).toString("utf8");
    const name = headerText.match(/name="([^"]*)"/i)?.[1] || "";
    if (!name) continue;
    if (name === "file") {
      file = {
        filename: headerText.match(/filename="([^"]*)"/i)?.[1] || "upload",
        contentType: headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "",
        buffer: part.subarray(separator + 4)
      };
    } else {
      fields[name] = part.subarray(separator + 4).toString("utf8").trim();
    }
  }
  if (file) return { ...file, fields };
  const error = new Error("鏈壘鍒颁笂浼犲瓧娈?file");
  error.status = 400;
  throw error;
}

async function readRequestBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("涓婃灦绱犳潗涓嶈兘瓒呰繃 200MB");
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

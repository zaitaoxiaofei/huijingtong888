import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

export async function materialAssets(query = {}) {
  await ensureMaterialAssetsTable();
  const paged = String(query.paged || "") === "1" || String(query.paged || "").toLowerCase() === "true";
  const page = Math.max(Number(query.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || query.limit || 20), 1), 100);
  const clauses = [];
  const params = [];
  if (query.source_type) {
    clauses.push("source_type = ?");
    params.push(String(query.source_type));
  }
  if (query.asset_type) {
    clauses.push("asset_type = ?");
    params.push(String(query.asset_type));
  }
  if (query.role) {
    clauses.push("role = ?");
    params.push(String(query.role));
  }
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status));
  }
  const keyword = String(query.q || query.keyword || "").trim().toLowerCase();
  if (keyword) {
    clauses.push(`(
      LOWER(title) LIKE ? OR
      LOWER(product_name) LIKE ? OR
      LOWER(target_brand) LIKE ? OR
      LOWER(target_model) LIKE ? OR
      LOWER(source_type) LIKE ? OR
      LOWER(source_id) LIKE ? OR
      LOWER(variant_task_id) LIKE ? OR
      LOWER(variant_result_id) LIKE ? OR
      LOWER(metadata_json) LIKE ?
    )`);
    params.push(...Array(9).fill(`%${keyword}%`));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(query.limit || 200), 1), 1000);
  if (paged) {
    const countRow = await mysqlQuery(`SELECT COUNT(*) AS total FROM material_assets ${where}`, params).then((rows) => rows[0]);
    const total = Number(countRow?.total || 0);
    const rows = await mysqlQuery(`
      SELECT *
      FROM material_assets
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, [...params, pageSize, (page - 1) * pageSize]);
    return {
      rows: rows.map(normalizeMaterialAssetRow),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      mode: "paged"
    };
  }
  const rows = await mysqlQuery(`
    SELECT *
    FROM material_assets
    ${where}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${limit}
  `, params);
  return rows.map(normalizeMaterialAssetRow);
}

export async function createMaterialAsset(body = {}, personId = null) {
  await ensureMaterialAssetsTable();
  const payload = normalizeMaterialAssetPayload(body);
  const result = await mysqlExecute(`
    INSERT INTO material_assets (
      asset_type, role, title, url, thumbnail_url, content_text, source_type, source_id,
      source_selection_id, source_package_id, variant_task_id, variant_result_id,
      target_brand, target_model, product_name, style, ratio, prompt_template_id,
      final_prompt, negative_prompt, provider, model, status, metadata_json, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    payload.asset_type,
    payload.role,
    payload.title,
    payload.url,
    payload.thumbnail_url,
    payload.content_text,
    payload.source_type,
    payload.source_id,
    payload.source_selection_id,
    payload.source_package_id,
    payload.variant_task_id,
    payload.variant_result_id,
    payload.target_brand,
    payload.target_model,
    payload.product_name,
    payload.style,
    payload.ratio,
    payload.prompt_template_id,
    payload.final_prompt,
    payload.negative_prompt,
    payload.provider,
    payload.model,
    payload.status,
    payload.metadata_json,
    personId ? Number(personId) : null
  ]);
  return materialAssetDetail(result.insertId);
}

export async function materialAssetDetail(id) {
  await ensureMaterialAssetsTable();
  const row = await mysqlQuery("SELECT * FROM material_assets WHERE id = ? LIMIT 1", [Number(id)]).then((rows) => rows[0]);
  if (!row) throw statusError("素材资产不存在", 404);
  return normalizeMaterialAssetRow(row);
}

export async function updateMaterialAsset(id, body = {}) {
  await ensureMaterialAssetsTable();
  const current = await materialAssetDetail(id);
  const payload = normalizeMaterialAssetPayload({ ...current, ...body });
  await mysqlExecute(`
    UPDATE material_assets
    SET role = ?,
        title = ?,
        status = ?,
        usage_count = ?,
        metadata_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    payload.role,
    payload.title,
    payload.status,
    Number(body.usage_count ?? current.usage_count ?? 0),
    payload.metadata_json,
    Number(id)
  ]);
  return materialAssetDetail(id);
}

export async function archiveMaterialAsset(id) {
  await ensureMaterialAssetsTable();
  await mysqlExecute("UPDATE material_assets SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  return materialAssetDetail(id);
}

async function ensureMaterialAssetsTable() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS material_assets (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      asset_type VARCHAR(32) NOT NULL DEFAULT 'image',
      role VARCHAR(64) NOT NULL DEFAULT 'main_image',
      title VARCHAR(191) NOT NULL DEFAULT '',
      url LONGTEXT NULL,
      thumbnail_url LONGTEXT NULL,
      content_text LONGTEXT NULL,
      source_type VARCHAR(64) NOT NULL DEFAULT '',
      source_id VARCHAR(128) NOT NULL DEFAULT '',
      source_selection_id BIGINT NULL,
      source_package_id VARCHAR(128) NOT NULL DEFAULT '',
      variant_task_id VARCHAR(128) NOT NULL DEFAULT '',
      variant_result_id VARCHAR(128) NOT NULL DEFAULT '',
      target_brand VARCHAR(128) NOT NULL DEFAULT '',
      target_model VARCHAR(128) NOT NULL DEFAULT '',
      product_name VARCHAR(255) NOT NULL DEFAULT '',
      style VARCHAR(128) NOT NULL DEFAULT '',
      ratio VARCHAR(16) NOT NULL DEFAULT '3:4',
      prompt_template_id BIGINT NULL,
      final_prompt LONGTEXT NULL,
      negative_prompt LONGTEXT NULL,
      provider VARCHAR(64) NOT NULL DEFAULT '',
      model VARCHAR(128) NOT NULL DEFAULT '',
      status VARCHAR(64) NOT NULL DEFAULT 'pending_review',
      usage_count INT NOT NULL DEFAULT 0,
      metadata_json LONGTEXT NULL,
      created_by BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_material_assets_role (asset_type, role, status),
      INDEX idx_material_assets_source (source_type, source_id),
      INDEX idx_material_assets_selection (source_selection_id),
      INDEX idx_material_assets_variant (variant_task_id, variant_result_id),
      INDEX idx_material_assets_updated (updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

function normalizeMaterialAssetPayload(body = {}) {
  return {
    asset_type: cleanText(body.asset_type || body.assetType || "image", 32),
    role: cleanText(body.role || "main_image", 64),
    title: cleanText(body.title || body.name || "AI生成素材", 191),
    url: String(body.url || body.imageUrl || "").trim(),
    thumbnail_url: String(body.thumbnail_url || body.thumbnailUrl || body.url || body.imageUrl || "").trim(),
    content_text: String(body.content_text || body.contentText || "").trim(),
    source_type: cleanText(body.source_type || body.sourceType || "ai_generated", 64),
    source_id: cleanText(body.source_id || body.sourceId || "", 128),
    source_selection_id: nullableInteger(body.source_selection_id || body.sourceSelectionId),
    source_package_id: cleanText(body.source_package_id || body.sourcePackageId || "", 128),
    variant_task_id: cleanText(body.variant_task_id || body.variantTaskId || "", 128),
    variant_result_id: cleanText(body.variant_result_id || body.variantResultId || "", 128),
    target_brand: cleanText(body.target_brand || body.targetBrand || "", 128),
    target_model: cleanText(body.target_model || body.targetModel || "", 128),
    product_name: cleanText(body.product_name || body.productName || "", 255),
    style: cleanText(body.style || "", 128),
    ratio: cleanText(body.ratio || "3:4", 16),
    prompt_template_id: nullableInteger(body.prompt_template_id || body.promptTemplateId),
    final_prompt: String(body.final_prompt || body.finalPrompt || "").trim(),
    negative_prompt: String(body.negative_prompt || body.negativePrompt || "").trim(),
    provider: cleanText(body.provider || "cctq-image2", 64),
    model: cleanText(body.model || "gpt-image-2", 128),
    status: cleanText(body.status || "pending_review", 64),
    metadata_json: normalizeJson(body.metadata_json || body.metadataJson || body.metadata || {})
  };
}

function normalizeMaterialAssetRow(row = {}) {
  return {
    ...row,
    id: Number(row.id),
    source_selection_id: row.source_selection_id == null ? null : Number(row.source_selection_id),
    prompt_template_id: row.prompt_template_id == null ? null : Number(row.prompt_template_id),
    usage_count: Number(row.usage_count || 0),
    metadata: parseJson(row.metadata_json, {})
  };
}

function normalizeJson(value) {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return "{}";
    }
  }
  return JSON.stringify(value || {});
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function nullableInteger(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function cleanText(value, max = 191) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

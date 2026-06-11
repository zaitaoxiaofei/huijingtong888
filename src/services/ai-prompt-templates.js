import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const DEFAULT_TEMPLATES = [
  {
    name: "主图裂变-图生图-高端原厂风",
    scene: "main_image_variant",
    mode: "image_to_image",
    description: "基于母商品主图生成高端质感的新主图。",
    positive_prompt: [
      "Use the uploaded reference product image as the main product subject.",
      "Keep the product structure, material, angle and core shape consistent.",
      "Product: {{product_name}}.",
      "Target brand/model: {{target_brand}} {{target_model}}.",
      "Material: {{material}}. Color: {{color}}.",
      "Selling points: {{selling_points}}.",
      "Style direction: premium OEM style, refined studio lighting, realistic metal/plastic texture.",
      "User extra instruction: {{user_prompt}}.",
      "Generate a professional Ozon marketplace main image in {{ratio}} ratio."
    ].join("\n"),
    negative_prompt: [
      "No watermark.",
      "No fake certification.",
      "No distorted product shape.",
      "No unreadable text.",
      "No extra accessories not present in the reference image.",
      "No misleading official authorization marks."
    ].join("\n"),
    variables_json: JSON.stringify(defaultVariables()),
    default_ratio: "3:4",
    default_count: 1,
    is_default: 1,
    enabled: 1,
    sort_order: 10
  },
  {
    name: "主图裂变-图生图-白底清晰风",
    scene: "main_image_variant",
    mode: "image_to_image",
    description: "适合做清晰白底商品主图。",
    positive_prompt: [
      "Use the uploaded reference product image as the main product subject.",
      "Keep the original product shape, color and material accurate.",
      "Product: {{product_name}}.",
      "Target brand/model: {{target_brand}} {{target_model}}.",
      "Create a clean white background e-commerce main image with sharp edges and natural shadow.",
      "User extra instruction: {{user_prompt}}.",
      "Aspect ratio: {{ratio}}."
    ].join("\n"),
    negative_prompt: "No watermark. No messy background. No distorted product. No unreadable text. No fake logo.",
    variables_json: JSON.stringify(defaultVariables()),
    default_ratio: "3:4",
    default_count: 1,
    is_default: 0,
    enabled: 1,
    sort_order: 20
  },
  {
    name: "Logo文字替换-局部替换",
    scene: "logo_text_replace",
    mode: "inpaint",
    description: "保持原构图，仅替换产品上的车型/品牌文字。",
    positive_prompt: [
      "Edit only the text/logo area on the product.",
      "Keep the original composition, product shape, lighting and background unchanged.",
      "Replace text '{{replace_from_text}}' with '{{replace_to_text}}'.",
      "Logo/text content: {{logo_text}}.",
      "Target brand/model: {{target_brand}} {{target_model}}.",
      "The final image must look realistic and marketplace-ready."
    ].join("\n"),
    negative_prompt: "Do not change the product structure. Do not regenerate the full background. No watermark. No unreadable text.",
    variables_json: JSON.stringify(defaultVariables()),
    default_ratio: "3:4",
    default_count: 1,
    is_default: 1,
    enabled: 1,
    sort_order: 30
  },
  {
    name: "详情图生成-卖点说明图",
    scene: "detail_image",
    mode: "image_to_image",
    description: "基于商品图生成详情页卖点说明图，适合展示材质、安装、尺寸和使用场景。",
    positive_prompt: [
      "Use the uploaded product image as the accurate product reference.",
      "Create a marketplace detail image for {{product_name}}.",
      "Detail image type: {{detail_image_type}}.",
      "Target brand/model: {{target_brand}} {{target_model}}.",
      "Material and color: {{material}}, {{color}}.",
      "Key selling points: {{selling_points}}.",
      "The layout should explain the benefit clearly with clean visual hierarchy.",
      "Keep the product realistic, sharp, and consistent with the reference.",
      "User extra instruction: {{user_prompt}}.",
      "Aspect ratio: {{ratio}}."
    ].join("\n"),
    negative_prompt: [
      "No watermark.",
      "No fake certification badge.",
      "No misleading official authorization.",
      "No distorted product shape.",
      "No unreadable text.",
      "No extra accessories that are not in the source product."
    ].join("\n"),
    variables_json: JSON.stringify(defaultVariables()),
    default_ratio: "3:4",
    default_count: 1,
    is_default: 1,
    enabled: 1,
    sort_order: 40
  },
  {
    name: "标题生成-Ozon搜索标题",
    scene: "title_generation",
    mode: "text",
    description: "生成覆盖品牌、车型、类目、材质和核心卖点的 Ozon 商品标题。",
    positive_prompt: [
      "Generate 5 Ozon product title options.",
      "Product: {{product_name}}.",
      "Target brand/model: {{target_brand}} {{target_model}}.",
      "Category: {{ozon_category}}.",
      "Material/color: {{material}}, {{color}}.",
      "Required keywords: {{title_keywords}}.",
      "Selling points: {{selling_points}}.",
      "Keep titles concise, searchable, readable, and marketplace-compliant.",
      "Avoid fake official claims and unsupported certification wording.",
      "User extra instruction: {{user_prompt}}."
    ].join("\n"),
    negative_prompt: "No fake official authorization. No exaggerated claims. No unrelated brand names. No keyword stuffing.",
    variables_json: JSON.stringify(defaultVariables()),
    default_ratio: "3:4",
    default_count: 1,
    is_default: 1,
    enabled: 1,
    sort_order: 50
  },
  {
    name: "标签生成-Ozon搜索标签",
    scene: "tag_generation",
    mode: "text",
    description: "生成围绕品牌、车型、类目、材质、功能和场景的搜索标签。",
    positive_prompt: [
      "Generate Ozon search tags for {{product_name}}.",
      "Target brand/model: {{target_brand}} {{target_model}}.",
      "Category: {{ozon_category}}.",
      "Material/color: {{material}}, {{color}}.",
      "Seed keywords: {{tags_keywords}}.",
      "Selling points: {{selling_points}}.",
      "Group tags by brand/model, category, material, function, and usage scenario.",
      "Return concise tags only, without unrelated words.",
      "User extra instruction: {{user_prompt}}."
    ].join("\n"),
    negative_prompt: "No unrelated brands. No duplicate tags. No fake certification terms. No misleading compatibility claims.",
    variables_json: JSON.stringify(defaultVariables()),
    default_ratio: "3:4",
    default_count: 1,
    is_default: 1,
    enabled: 1,
    sort_order: 60
  },
  {
    name: "描述生成-卖点与适配说明",
    scene: "description_generation",
    mode: "text",
    description: "生成商品描述、卖点段落和适配说明，可用于简介或富文本草稿。",
    positive_prompt: [
      "Write a clear Ozon product description for {{product_name}}.",
      "Target brand/model: {{target_brand}} {{target_model}}.",
      "Category: {{ozon_category}}.",
      "Material/color: {{material}}, {{color}}.",
      "Description points: {{description_points}}.",
      "Selling points: {{selling_points}}.",
      "Include fitment, material benefits, installation notes, package reminder, and buyer reassurance.",
      "Use concise marketplace copy with practical details.",
      "Avoid unsupported official claims.",
      "User extra instruction: {{user_prompt}}."
    ].join("\n"),
    negative_prompt: "No fake official authorization. No unsupported warranty promise. No exaggerated or unverifiable claims. No unrelated vehicle models.",
    variables_json: JSON.stringify(defaultVariables()),
    default_ratio: "3:4",
    default_count: 1,
    is_default: 1,
    enabled: 1,
    sort_order: 70
  },
  {
    name: "全局负面提示词-电商图片",
    scene: "global_negative",
    mode: "global",
    description: "所有电商图片生成任务可复用的通用禁止项。",
    positive_prompt: "",
    negative_prompt: [
      "No watermark.",
      "No fake certification badge.",
      "No platform logo.",
      "No misleading official authorization.",
      "No distorted product geometry.",
      "No gibberish text.",
      "No Chinese text or Chinese characters.",
      "No extra accessories not present in the reference image."
    ].join("\n"),
    variables_json: "[]",
    default_ratio: "3:4",
    default_count: 1,
    is_default: 1,
    enabled: 1,
    sort_order: 90
  }
];

export async function aiPromptTemplates(query = {}) {
  await ensureAiPromptTemplateTable();
  const clauses = [];
  const params = [];
  if (query.scene) {
    clauses.push("scene = ?");
    params.push(String(query.scene));
  }
  if (query.mode) {
    clauses.push("mode = ?");
    params.push(String(query.mode));
  }
  if (query.enabled !== undefined && query.enabled !== "") {
    clauses.push("enabled = ?");
    params.push(Number(query.enabled) ? 1 : 0);
  }
  const keyword = cleanText(query.keyword || query.q || query.search);
  if (keyword) {
    clauses.push("(name LIKE ? OR keywords LIKE ? OR description LIKE ? OR prompt_payload_json LIKE ?)");
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await mysqlQuery(`
    SELECT *
    FROM ai_prompt_templates
    ${where}
    ORDER BY sort_order ASC, id ASC
  `, params);
  return rows.map(normalizeTemplateRow);
}

export async function aiPromptTemplateDetail(id) {
  await ensureAiPromptTemplateTable();
  const row = await mysqlQuery("SELECT * FROM ai_prompt_templates WHERE id = ? LIMIT 1", [Number(id)]).then((rows) => rows[0]);
  if (!row) throw statusError("提示词模板不存在", 404);
  return normalizeTemplateRow(row);
}

export async function createAiPromptTemplate(body = {}, personId = null) {
  await ensureAiPromptTemplateTable();
  const payload = normalizeTemplatePayload(body);
  if (payload.is_default) await clearDefaultTemplate(payload.scene, payload.mode);
  const result = await mysqlExecute(`
    INSERT INTO ai_prompt_templates (
      name, scene, mode, keywords, description, positive_prompt, negative_prompt, variables_json, prompt_payload_json,
      default_ratio, default_count, is_default, enabled, sort_order, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    payload.name,
    payload.scene,
    payload.mode,
    payload.keywords,
    payload.description,
    payload.positive_prompt,
    payload.negative_prompt,
    payload.variables_json,
    payload.prompt_payload_json,
    payload.default_ratio,
    payload.default_count,
    payload.is_default,
    payload.enabled,
    payload.sort_order,
    personId ? Number(personId) : null
  ]);
  return aiPromptTemplateDetail(result.insertId);
}

export async function updateAiPromptTemplate(id, body = {}) {
  await ensureAiPromptTemplateTable();
  const previous = await aiPromptTemplateDetail(id);
  if ((body.updated_at || body.updatedAt) && !sameSecond(body.updated_at || body.updatedAt, previous.updated_at || previous.updatedAt)) {
    throw statusError("AI 提示词模板已被其他用户保存，请刷新后再继续编辑", 409);
  }
  const payload = normalizeTemplatePayload({ ...previous, ...body });
  if (payload.is_default) await clearDefaultTemplate(payload.scene, payload.mode, Number(id));
  await mysqlExecute(`
    UPDATE ai_prompt_templates
    SET name = ?,
        scene = ?,
        mode = ?,
        keywords = ?,
        description = ?,
        positive_prompt = ?,
        negative_prompt = ?,
        variables_json = ?,
        prompt_payload_json = ?,
        default_ratio = ?,
        default_count = ?,
        is_default = ?,
        enabled = ?,
        sort_order = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    payload.name,
    payload.scene,
    payload.mode,
    payload.keywords,
    payload.description,
    payload.positive_prompt,
    payload.negative_prompt,
    payload.variables_json,
    payload.prompt_payload_json,
    payload.default_ratio,
    payload.default_count,
    payload.is_default,
    payload.enabled,
    payload.sort_order,
    Number(id)
  ]);
  return aiPromptTemplateDetail(id);
}

export async function deleteAiPromptTemplate(id) {
  await ensureAiPromptTemplateTable();
  await mysqlExecute("DELETE FROM ai_prompt_templates WHERE id = ?", [Number(id)]);
  return { ok: true };
}

export async function duplicateAiPromptTemplate(id, personId = null) {
  const row = await aiPromptTemplateDetail(id);
  return createAiPromptTemplate({
    ...row,
    name: `${row.name} 副本`,
    is_default: 0,
    sort_order: Number(row.sort_order || 0) + 1
  }, personId);
}

export async function setDefaultAiPromptTemplate(id) {
  const row = await aiPromptTemplateDetail(id);
  await clearDefaultTemplate(row.scene, row.mode, row.id);
  await mysqlExecute("UPDATE ai_prompt_templates SET is_default = 1, enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  return aiPromptTemplateDetail(id);
}

export async function renderAiPromptTemplate(body = {}) {
  await ensureAiPromptTemplateTable();
  const template = body.templateId ? await aiPromptTemplateDetail(body.templateId) : normalizeTemplatePayload(body.template || {});
  const variables = normalizeVariables(body.variables || {});
  const positiveSource = String(body.positive_prompt ?? body.positivePrompt ?? template.positive_prompt ?? "");
  const negativeSource = String(body.negative_prompt ?? body.negativePrompt ?? template.negative_prompt ?? "");
  const finalPositivePrompt = renderTemplateText(positiveSource, variables);
  const finalNegativePrompt = renderTemplateText(negativeSource, variables);
  const missingVariables = collectMissingVariables(`${positiveSource}\n${negativeSource}`, variables);
  return {
    template,
    variables,
    finalPositivePrompt,
    finalNegativePrompt,
    missingVariables
  };
}

export async function ensureAiPromptTemplateTable() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_prompt_templates (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(191) NOT NULL,
      scene VARCHAR(64) NOT NULL DEFAULT '',
      mode VARCHAR(64) NOT NULL DEFAULT '',
      keywords TEXT NULL,
      description TEXT NULL,
      positive_prompt LONGTEXT NULL,
      negative_prompt LONGTEXT NULL,
      variables_json LONGTEXT NULL,
      prompt_payload_json LONGTEXT NULL,
      default_ratio VARCHAR(16) NOT NULL DEFAULT '3:4',
      default_count INT NOT NULL DEFAULT 1,
      is_default TINYINT NOT NULL DEFAULT 0,
      enabled TINYINT NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_by BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_prompt_templates_scene_mode (scene, mode),
      INDEX idx_ai_prompt_templates_enabled (enabled)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await addAiPromptTemplateColumn("keywords", "TEXT NULL");
  await addAiPromptTemplateColumn("prompt_payload_json", "LONGTEXT NULL");
  await ensureDefaultPromptTemplates();
  await ensureGlobalNegativeNoChineseRule();
}

async function addAiPromptTemplateColumn(column, definition) {
  await mysqlExecute(`ALTER TABLE ai_prompt_templates ADD COLUMN ${column} ${definition}`).catch((error) => {
    const message = String(error?.message || "");
    if (message.includes("Duplicate column") || message.includes("重复")) return;
    throw error;
  });
}

async function ensureDefaultPromptTemplates() {
  for (const item of DEFAULT_TEMPLATES) {
    const exists = await mysqlQuery("SELECT id FROM ai_prompt_templates WHERE name = ? LIMIT 1", [item.name]).then((rows) => rows[0]);
    if (exists) continue;
    const defaultExists = item.is_default
      ? await mysqlQuery(
        "SELECT id FROM ai_prompt_templates WHERE scene = ? AND mode = ? AND is_default = 1 LIMIT 1",
        [item.scene, item.mode]
      ).then((rows) => rows[0])
      : null;
    await mysqlExecute(`
      INSERT INTO ai_prompt_templates (
        name, scene, mode, description, positive_prompt, negative_prompt, variables_json,
        default_ratio, default_count, is_default, enabled, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      item.name,
      item.scene,
      item.mode,
      item.description,
      item.positive_prompt,
      item.negative_prompt,
      item.variables_json,
      item.default_ratio,
      item.default_count,
      defaultExists ? 0 : item.is_default,
      item.enabled,
      item.sort_order
    ]);
  }
}

async function ensureGlobalNegativeNoChineseRule() {
  const rule = "No Chinese text or Chinese characters.";
  const rows = await mysqlQuery(`
    SELECT id, negative_prompt
    FROM ai_prompt_templates
    WHERE scene = 'global_negative'
      AND enabled = 1
  `);
  for (const row of rows) {
    const current = String(row.negative_prompt || "");
    if (current.toLowerCase().includes("no chinese text") || current.includes("不能有中文")) continue;
    await mysqlExecute(
      "UPDATE ai_prompt_templates SET negative_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [[current, rule].filter(Boolean).join("\n"), Number(row.id)]
    );
  }
}

function normalizeTemplatePayload(body = {}) {
  const name = cleanText(body.name);
  if (!name) throw statusError("模板名称不能为空", 400);
  return {
    name,
    scene: cleanText(body.scene || "main_image_variant"),
    mode: cleanText(body.mode || "image_to_image"),
    keywords: normalizeKeywords(body.keywords ?? body.keywordText ?? body.keyword),
    description: cleanLongText(body.description),
    positive_prompt: cleanLongText(body.positive_prompt ?? body.positivePrompt),
    negative_prompt: cleanLongText(body.negative_prompt ?? body.negativePrompt),
    variables_json: normalizeVariablesJson(body.variables_json ?? body.variablesJson ?? body.variables),
    prompt_payload_json: normalizeJsonText(body.prompt_payload_json ?? body.promptPayloadJson ?? body.promptPayload),
    default_ratio: cleanText(body.default_ratio ?? body.defaultRatio ?? "3:4") || "3:4",
    default_count: clampInteger(body.default_count ?? body.defaultCount, 1, 8, 1),
    is_default: Number(body.is_default ?? body.isDefault ?? 0) ? 1 : 0,
    enabled: Number(body.enabled ?? 1) ? 1 : 0,
    sort_order: clampInteger(body.sort_order ?? body.sortOrder, -999999, 999999, 0)
  };
}

function normalizeTemplateRow(row = {}) {
  return {
    ...row,
    id: Number(row.id),
    updatedAt: row.updated_at || row.updatedAt || "",
    default_count: Number(row.default_count || 1),
    is_default: Number(row.is_default || 0),
    enabled: Number(row.enabled || 0),
    sort_order: Number(row.sort_order || 0),
    keywords: String(row.keywords || ""),
    keywordList: splitKeywords(row.keywords),
    variables: parseJsonArray(row.variables_json),
    promptPayload: parseJsonObject(row.prompt_payload_json)
  };
}

function normalizeVariablesJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  const text = String(value || "").trim();
  if (!text) return "[]";
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(Array.isArray(parsed) ? parsed : []);
  } catch {
    return JSON.stringify(text.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean));
  }
}

function normalizeVariables(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, item == null ? "" : String(item)]));
}

function normalizeJsonText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean).join(", ");
  return String(value || "")
    .split(/\r?\n|[,，、;；]/)
    .map((item) => cleanText(item))
    .filter(Boolean)
    .join(", ");
}

function renderTemplateText(template, variables) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => variables[key] || "");
}

function collectMissingVariables(template, variables) {
  const names = new Set();
  String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!String(variables[key] || "").trim()) names.add(key);
    return "";
  });
  return [...names];
}

async function clearDefaultTemplate(scene, mode, exceptId = 0) {
  await mysqlExecute("UPDATE ai_prompt_templates SET is_default = 0 WHERE scene = ? AND mode = ? AND id <> ?", [scene, mode, Number(exceptId || 0)]);
}

function defaultVariables() {
  return [
    "product_name",
    "brand",
    "vehicle_model",
    "target_brand",
    "target_model",
    "material",
    "color",
    "selling_points",
    "ozon_category",
    "main_image_style",
    "detail_image_type",
    "title_keywords",
    "tags_keywords",
    "description_points",
    "source_image_url",
    "replace_from_text",
    "replace_to_text",
    "logo_text",
    "user_prompt",
    "ratio"
  ];
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function splitKeywords(value) {
  return String(value || "")
    .split(/\r?\n|[,，、;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 191);
}

function cleanLongText(value) {
  return String(value || "").trim();
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sameSecond(left, right) {
  return normalizeSecond(left) === normalizeSecond(right);
}

function normalizeSecond(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) return Math.floor(date.getTime() / 1000);
  return String(value).trim().slice(0, 19);
}

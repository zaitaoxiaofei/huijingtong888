import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const LIBRARY_VERSION = "2026.05.phase2";

const STRATEGY_SEED = [
  seedStrategy("main-subject-70", "主体占比70%", ["主体占比提升到70%", "主图主体强化", "主体强化"], ["low_ctr", "high_ad_cost"], ["main_image"], 90, [
    "Make the product the dominant visual subject, occupying about 70% of the canvas.",
    "Keep clear marketplace-safe margins while preserving a strong product silhouette."
  ], ["Do not make the product too small or lost in the background."]),
  seedStrategy("vehicle-model-emphasis", "车型强化", ["车型信息强化", "车型适配强化", "型号强化", "主图型号强化", "车型词覆盖"], ["low_ctr", "low_exposure", "multi_model_variant"], ["main_image", "title", "tags"], 86, [
    "Use the provided target model as the source of truth for compatibility wording.",
    "Clearly communicate model fit without inventing unsupported vehicle models."
  ], ["Do not add random vehicle models or unsupported compatibility claims."]),
  seedStrategy("high-contrast-click-composition", "高对比点击构图", ["高点击主图风", "高点击基础图风", "高对比构图"], ["low_ctr", "high_ad_cost"], ["main_image"], 82, [
    "Use a high-click ecommerce composition with stronger product contrast and clear visual hierarchy.",
    "Prioritize readability at small thumbnail size on Ozon search results."
  ], ["Avoid cluttered layouts, tiny product scale, or unreadable decorative text."]),
  seedStrategy("premium-material-texture", "高级质感强化", ["高级感强化", "品牌质感强化", "质感强化", "高端原厂风"], ["low_ctr", "premium_feel"], ["main_image", "detail_image"], 78, [
    "Enhance premium material texture with realistic highlights, refined shadows, and clean product edges.",
    "Keep the real product structure and material identity."
  ], ["Do not over-gloss the product or change its material identity."]),
  seedStrategy("handheld-context", "手持场景强化", ["手持主体", "真实使用感"], ["low_ctr", "low_conversion"], ["main_image", "detail_image"], 72, [
    "If a scene is needed, show a realistic hand-held or in-use context that explains product scale.",
    "Keep the product as the focus; the hand or scene must support the product."
  ], ["Do not add unrealistic hands, distorted fingers, or unrelated lifestyle objects."], ["white-background-clean"]),
  seedStrategy("white-background-clean", "白底清晰风", ["白底图补充", "白底清晰图", "白底搜索图"], ["low_ctr", "low_exposure", "multi_ratio_variant"], ["main_image"], 70, [
    "Use a clean white or near-white ecommerce background with natural shadow and crisp edges.",
    "Make the product easy to inspect with no distracting scene elements."
  ], ["No busy background, no heavy texture, no lifestyle scene."], ["handheld-context"]),
  seedStrategy("seo-title-structure", "高搜索标题结构", ["高搜索标题", "Ozon爆款标题", "俄语标题结构优化"], ["low_exposure", "title_optimize"], ["title"], 88, [
    "Build the title with product type, target model, material, core function, and Ozon search terms.",
    "Prefer concise Russian marketplace wording."
  ], ["Do not stuff irrelevant keywords or unsupported compatibility claims."]),
  seedStrategy("tag-expansion", "标签扩展", ["Ozon搜索标签", "品牌词标签", "材质功能标签"], ["low_exposure", "tag_optimize"], ["tags"], 68, [
    "Generate searchable tags covering brand, model, product type, material, function, and buyer intent.",
    "Keep tags specific and deduplicated."
  ], ["Do not include unrelated brands, random models, or misleading platform names."]),
  seedStrategy("installation-detail", "安装场景说明", ["安装图", "安装方式说明", "安装步骤图", "安装路径说明", "安装位置强化"], ["low_conversion", "high_cart_low_order"], ["detail_image", "description"], 76, [
    "Explain where and how the product is installed with clear visual steps or callouts.",
    "Use practical buyer-facing language that reduces installation uncertainty."
  ], ["Do not show impossible installation positions or unsupported vehicle parts."]),
  seedStrategy("material-detail", "材质细节说明", ["材质细节图", "材质词覆盖", "材质功能词强化"], ["low_conversion", "low_exposure"], ["detail_image", "title", "tags", "description"], 66, [
    "Show or describe material texture, durability, protective function, and tactile details.",
    "Make material benefits concrete and relevant to the product."
  ], ["Do not claim certifications or material grades not present in source data."]),
  seedStrategy("size-fit-detail", "尺寸信息说明", ["尺寸说明", "尺寸适配说明", "尺寸参数说明"], ["low_conversion", "high_cart_low_order"], ["detail_image", "description"], 62, [
    "Include size or fit information using provided package and product dimensions when available.",
    "Use a clear comparison or dimension explanation to reduce buyer uncertainty."
  ], ["Do not invent exact measurements if not provided."]),
  seedStrategy("ab-main-image-set", "A/B主图套组", ["生成3套A/B主图", "多版本主图A/B测试", "A/B主图"], ["low_ctr", "high_ad_cost"], ["main_image"], 54, [
    "Prepare the image as one candidate in an A/B test set with a distinct visual angle.",
    "Keep product identity consistent across variants."
  ], ["Do not create duplicate compositions across variants."]),
  seedStrategy("model-batch-variant", "车型变量替换", ["每个车型独立主图", "车型文字强化", "标题型号替换", "批量任务生成"], ["multi_model_variant"], ["main_image", "title", "tags"], 92, [
    "Generate one independent task per target model.",
    "Replace only model-specific wording while preserving product structure and base creative direction."
  ], ["Do not mix multiple target models in one generated asset."], [], ["product_variant"])
];

const LAYER_RULE_SEED = [
  seedLayer("global", "global-default", "全局策略", [], {
    low_ctr: ["main-subject-70", "vehicle-model-emphasis", "high-contrast-click-composition"],
    low_exposure: ["seo-title-structure", "vehicle-model-emphasis", "tag-expansion"],
    low_conversion: ["installation-detail", "material-detail", "size-fit-detail"],
    multi_model_variant: ["model-batch-variant", "vehicle-model-emphasis"]
  }, 10),
  seedLayer("platform", "ozon", "Ozon平台策略", ["ozon", "озон"], {
    low_ctr: ["high-contrast-click-composition"],
    low_exposure: ["seo-title-structure", "tag-expansion"]
  }, 20),
  seedLayer("category", "key-shell", "钥匙壳类目策略", ["钥匙壳", "key shell", "key case"], {
    low_ctr: ["premium-material-texture", "handheld-context", "main-subject-70", "vehicle-model-emphasis"],
    low_conversion: ["material-detail", "size-fit-detail"],
    low_exposure: ["seo-title-structure", "vehicle-model-emphasis", "tag-expansion"]
  }, 50),
  seedLayer("category", "auto-accessory", "通用汽车配件类目策略", ["汽车配件", "汽车用品", "auto accessory"], {
    low_ctr: ["main-subject-70", "vehicle-model-emphasis", "high-contrast-click-composition", "ab-main-image-set"],
    low_conversion: ["installation-detail", "material-detail", "size-fit-detail"],
    low_exposure: ["seo-title-structure", "vehicle-model-emphasis", "tag-expansion"]
  }, 60)
];

export async function aiStrategies(query = {}) {
  await ensureAiStrategyTables();
  const clauses = [];
  const params = [];
  if (query.enabled !== undefined && query.enabled !== "") {
    clauses.push("enabled = ?");
    params.push(Number(query.enabled) ? 1 : 0);
  }
  if (query.goal) {
    clauses.push("JSON_CONTAINS(applicable_goals_json, JSON_QUOTE(?))");
    params.push(String(query.goal));
  }
  if (query.asset) {
    clauses.push("JSON_CONTAINS(applicable_assets_json, JSON_QUOTE(?))");
    params.push(String(query.asset));
  }
  const keyword = String(query.q || query.keyword || "").trim().toLowerCase();
  if (keyword) {
    clauses.push("(LOWER(title) LIKE ? OR LOWER(strategy_key) LIKE ? OR LOWER(aliases_json) LIKE ?)");
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await mysqlQuery(`
    SELECT *
    FROM ai_strategies
    ${where}
    ORDER BY priority DESC, id ASC
  `, params);
  return rows.map(normalizeStrategyRow);
}

export async function aiStrategyDetail(id) {
  await ensureAiStrategyTables();
  const row = await mysqlQuery("SELECT * FROM ai_strategies WHERE id = ? LIMIT 1", [Number(id)]).then((rows) => rows[0]);
  if (!row) throw statusError("AI策略不存在", 404);
  return normalizeStrategyRow(row);
}

export async function createAiStrategy(body = {}, personId = null) {
  await ensureAiStrategyTables();
  const payload = normalizeStrategyPayload(body);
  const result = await mysqlExecute(`
    INSERT INTO ai_strategies (
      strategy_key, title, business_modes_json, applicable_goals_json, applicable_assets_json,
      aliases_json, positive_modules_json, negative_modules_json, conflict_strategy_keys_json,
      priority, enabled, version, metadata_json, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    payload.strategy_key,
    payload.title,
    payload.business_modes_json,
    payload.applicable_goals_json,
    payload.applicable_assets_json,
    payload.aliases_json,
    payload.positive_modules_json,
    payload.negative_modules_json,
    payload.conflict_strategy_keys_json,
    payload.priority,
    payload.enabled,
    payload.version,
    payload.metadata_json,
    personId ? Number(personId) : null
  ]);
  return aiStrategyDetail(result.insertId);
}

export async function updateAiStrategy(id, body = {}) {
  await ensureAiStrategyTables();
  const previous = await aiStrategyDetail(id);
  if ((body.updated_at || body.updatedAt) && !sameSecond(body.updated_at || body.updatedAt, previous.updated_at || previous.updatedAt)) {
    throw statusError("AI 策略已被其他用户保存，请刷新后再继续编辑", 409);
  }
  const payload = normalizeStrategyPayload({ ...previous, ...body });
  await mysqlExecute(`
    UPDATE ai_strategies
    SET strategy_key = ?,
        title = ?,
        business_modes_json = ?,
        applicable_goals_json = ?,
        applicable_assets_json = ?,
        aliases_json = ?,
        positive_modules_json = ?,
        negative_modules_json = ?,
        conflict_strategy_keys_json = ?,
        priority = ?,
        enabled = ?,
        version = ?,
        metadata_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    payload.strategy_key,
    payload.title,
    payload.business_modes_json,
    payload.applicable_goals_json,
    payload.applicable_assets_json,
    payload.aliases_json,
    payload.positive_modules_json,
    payload.negative_modules_json,
    payload.conflict_strategy_keys_json,
    payload.priority,
    payload.enabled,
    payload.version,
    payload.metadata_json,
    Number(id)
  ]);
  return aiStrategyDetail(id);
}

export async function deleteAiStrategy(id) {
  await ensureAiStrategyTables();
  await mysqlExecute("UPDATE ai_strategies SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  return aiStrategyDetail(id);
}

export async function aiStrategyLayerRules(query = {}) {
  await ensureAiStrategyTables();
  const clauses = [];
  const params = [];
  if (query.scope) {
    clauses.push("scope = ?");
    params.push(String(query.scope));
  }
  if (query.enabled !== undefined && query.enabled !== "") {
    clauses.push("enabled = ?");
    params.push(Number(query.enabled) ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await mysqlQuery(`SELECT * FROM ai_strategy_layer_rules ${where} ORDER BY sort_order ASC, id ASC`, params);
  return rows.map(normalizeLayerRuleRow);
}

export async function resolveAiStrategyPlan(body = {}) {
  await ensureAiStrategyTables();
  const businessMode = cleanText(body.businessMode || body.business_mode || "product_optimization", 64);
  const goalKey = cleanText(body.goalKey || body.goal_key || body.goal || "low_ctr", 64);
  const selectedTitles = normalizeArray(body.selectedTitles || body.selected_titles || body.selectedStrategies || body.selected_strategies);
  const fallbackTitles = normalizeArray(body.fallbackTitles || body.fallback_titles || body.fallbackStrategies || body.fallback_strategies);
  const categoryText = cleanLongText(body.categoryText || body.category_text || "");
  const selected = selectedTitles.length ? selectedTitles : fallbackTitles;
  const strategies = (await aiStrategies({ enabled: 1 })).filter((item) => strategyMatches(item, businessMode, goalKey));
  const byKey = new Map(strategies.map((item) => [item.strategy_key, item]));
  const byTitle = new Map();
  for (const item of strategies) {
    [item.title, ...(item.aliases || [])].forEach((title) => byTitle.set(normalize(title), item));
  }
  const layers = await resolveMatchingLayers(goalKey, categoryText);
  const selectedStrategies = selected
    .map((title) => byTitle.get(normalize(title)) || createTemporaryStrategy(title, businessMode, goalKey))
    .filter(Boolean);
  const inheritedStrategies = layers.flatMap((layer) => layer.strategy_keys.map((key) => byKey.get(key)).filter(Boolean));
  const merged = dedupeStrategies([...selectedStrategies, ...inheritedStrategies])
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  const conflictKeys = new Set();
  const chosen = [];
  for (const item of merged) {
    if (conflictKeys.has(item.strategy_key)) continue;
    chosen.push(item);
    (item.conflict_strategy_keys || []).forEach((key) => conflictKeys.add(key));
  }
  return {
    version: LIBRARY_VERSION,
    businessMode,
    goalKey,
    layers,
    strategies: chosen,
    strategyIds: chosen.map((item) => item.strategy_key),
    strategyTitles: chosen.map((item) => item.title),
    positiveModules: chosen.flatMap((item) => item.positive_modules || []),
    negativeModules: chosen.flatMap((item) => item.negative_modules || []),
    assets: [...new Set(chosen.flatMap((item) => item.applicable_assets || []))]
  };
}

export async function ensureAiStrategyTables() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_strategies (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      strategy_key VARCHAR(128) NOT NULL UNIQUE,
      title VARCHAR(191) NOT NULL,
      business_modes_json LONGTEXT NULL,
      applicable_goals_json LONGTEXT NULL,
      applicable_assets_json LONGTEXT NULL,
      aliases_json LONGTEXT NULL,
      positive_modules_json LONGTEXT NULL,
      negative_modules_json LONGTEXT NULL,
      conflict_strategy_keys_json LONGTEXT NULL,
      priority INT NOT NULL DEFAULT 0,
      enabled TINYINT NOT NULL DEFAULT 1,
      version INT NOT NULL DEFAULT 1,
      metadata_json LONGTEXT NULL,
      created_by BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_strategies_enabled_priority (enabled, priority),
      INDEX idx_ai_strategies_key (strategy_key)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_strategy_layer_rules (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      scope VARCHAR(32) NOT NULL DEFAULT 'global',
      rule_key VARCHAR(128) NOT NULL UNIQUE,
      title VARCHAR(191) NOT NULL,
      aliases_json LONGTEXT NULL,
      goal_strategy_map_json LONGTEXT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      enabled TINYINT NOT NULL DEFAULT 1,
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_strategy_layer_scope (scope, enabled, sort_order)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await seedAiStrategies();
}

async function seedAiStrategies() {
  const strategyCount = await mysqlQuery("SELECT COUNT(*) AS count FROM ai_strategies").then((rows) => Number(rows[0]?.count || 0));
  if (!strategyCount) {
    for (const item of STRATEGY_SEED) {
      const payload = normalizeStrategyPayload(item);
      await mysqlExecute(`
        INSERT INTO ai_strategies (
          strategy_key, title, business_modes_json, applicable_goals_json, applicable_assets_json,
          aliases_json, positive_modules_json, negative_modules_json, conflict_strategy_keys_json,
          priority, enabled, version, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        payload.strategy_key,
        payload.title,
        payload.business_modes_json,
        payload.applicable_goals_json,
        payload.applicable_assets_json,
        payload.aliases_json,
        payload.positive_modules_json,
        payload.negative_modules_json,
        payload.conflict_strategy_keys_json,
        payload.priority,
        payload.enabled,
        payload.version,
        payload.metadata_json
      ]);
    }
  }
  const layerCount = await mysqlQuery("SELECT COUNT(*) AS count FROM ai_strategy_layer_rules").then((rows) => Number(rows[0]?.count || 0));
  if (!layerCount) {
    for (const item of LAYER_RULE_SEED) {
      await mysqlExecute(`
        INSERT INTO ai_strategy_layer_rules (
          scope, rule_key, title, aliases_json, goal_strategy_map_json, sort_order, enabled, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        item.scope,
        item.rule_key,
        item.title,
        JSON.stringify(item.aliases),
        JSON.stringify(item.goal_strategy_map),
        item.sort_order,
        item.enabled,
        JSON.stringify(item.metadata || {})
      ]);
    }
  }
}

async function resolveMatchingLayers(goalKey, categoryText) {
  const text = normalize(categoryText);
  const rows = await aiStrategyLayerRules({ enabled: 1 });
  return rows
    .filter((layer) => Array.isArray(layer.goal_strategy_map?.[goalKey]) && layer.goal_strategy_map[goalKey].length)
    .filter((layer) => layer.scope !== "category" || layer.aliases.some((alias) => text.includes(normalize(alias))))
    .map((layer) => ({
      id: layer.id,
      scope: layer.scope,
      key: layer.rule_key,
      title: layer.title,
      strategy_keys: layer.goal_strategy_map[goalKey]
    }));
}

function normalizeStrategyPayload(body = {}) {
  return {
    strategy_key: cleanText(body.strategy_key || body.strategyKey || body.key, 128),
    title: cleanText(body.title || body.name, 191),
    business_modes_json: stringifyArray(body.business_modes || body.businessModes || ["product_optimization", "product_variant"]),
    applicable_goals_json: stringifyArray(body.applicable_goals || body.applicableGoals || body.goals),
    applicable_assets_json: stringifyArray(body.applicable_assets || body.applicableAssets || body.assets),
    aliases_json: stringifyArray(body.aliases),
    positive_modules_json: stringifyArray(body.positive_modules || body.positiveModules || body.positive),
    negative_modules_json: stringifyArray(body.negative_modules || body.negativeModules || body.negative),
    conflict_strategy_keys_json: stringifyArray(body.conflict_strategy_keys || body.conflictStrategyKeys || body.conflicts),
    priority: clampInt(body.priority, -999999, 999999, 0),
    enabled: Number(body.enabled ?? 1) ? 1 : 0,
    version: clampInt(body.version, 1, 999999, 1),
    metadata_json: normalizeJson(body.metadata_json || body.metadataJson || body.metadata || {})
  };
}

function normalizeStrategyRow(row = {}) {
  return {
    ...row,
    id: Number(row.id),
    updatedAt: row.updated_at || row.updatedAt || "",
    business_modes: parseArray(row.business_modes_json),
    applicable_goals: parseArray(row.applicable_goals_json),
    applicable_assets: parseArray(row.applicable_assets_json),
    aliases: parseArray(row.aliases_json),
    positive_modules: parseArray(row.positive_modules_json),
    negative_modules: parseArray(row.negative_modules_json),
    conflict_strategy_keys: parseArray(row.conflict_strategy_keys_json),
    priority: Number(row.priority || 0),
    enabled: Number(row.enabled || 0),
    version: Number(row.version || 1),
    metadata: parseJson(row.metadata_json, {})
  };
}

function normalizeLayerRuleRow(row = {}) {
  return {
    ...row,
    id: Number(row.id),
    aliases: parseArray(row.aliases_json),
    goal_strategy_map: parseJson(row.goal_strategy_map_json, {}),
    sort_order: Number(row.sort_order || 0),
    enabled: Number(row.enabled || 0),
    metadata: parseJson(row.metadata_json, {})
  };
}

function seedStrategy(key, title, aliases, goals, assets, priority, positive, negative, conflicts = [], businessModes = ["product_optimization", "product_variant"]) {
  return {
    key,
    title,
    aliases,
    goals,
    assets,
    priority,
    positive,
    negative,
    conflicts,
    businessModes,
    enabled: 1,
    version: 1,
    metadata: { seed: true, libraryVersion: LIBRARY_VERSION }
  };
}

function seedLayer(scope, key, title, aliases, goalMap, sortOrder) {
  return {
    scope,
    rule_key: key,
    title,
    aliases,
    goal_strategy_map: goalMap,
    sort_order: sortOrder,
    enabled: 1,
    metadata: { seed: true, libraryVersion: LIBRARY_VERSION }
  };
}

function strategyMatches(item, businessMode, goalKey) {
  return (item.business_modes || []).includes(businessMode) && (item.applicable_goals || []).includes(goalKey);
}

function dedupeStrategies(items = []) {
  const map = new Map();
  for (const item of items) {
    if (!item?.strategy_key || map.has(item.strategy_key)) continue;
    map.set(item.strategy_key, item);
  }
  return [...map.values()];
}

function createTemporaryStrategy(title, businessMode, goalKey) {
  const clean = cleanText(title, 191);
  if (!clean) return null;
  return {
    strategy_key: `temporary-${normalize(clean).replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").slice(0, 48)}`,
    title: clean,
    business_modes: [businessMode],
    applicable_goals: [goalKey],
    applicable_assets: ["main_image", "title", "tags", "detail_image"],
    aliases: [],
    positive_modules: [`Apply the business strategy "${clean}" in a concrete, product-faithful way.`],
    negative_modules: [`Do not apply "${clean}" in a misleading or unsupported way.`],
    conflict_strategy_keys: [],
    priority: 10,
    enabled: 1,
    version: 1,
    metadata: { temporary: true }
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function stringifyArray(value) {
  return JSON.stringify(normalizeArray(value));
}

function parseArray(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
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

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, max = 191) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanLongText(value) {
  return String(value || "").trim();
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sameSecond(left, right) {
  const leftText = normalizeSecond(left);
  const rightText = normalizeSecond(right);
  return Boolean(leftText && rightText && leftText === rightText);
}

function normalizeSecond(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  return String(value).replace("T", " ").replace("Z", "").slice(0, 19);
}

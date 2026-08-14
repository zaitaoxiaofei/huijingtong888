import crypto from "node:crypto";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { chatWithAiProvider } from "./ai-provider-settings.js";

const WORD_BOUNDARY = "[^a-z0-9а-яё]";

const BRAND_DEFINITIONS = [
  ["Toyota", ["toyota", "тойота"]],
  ["Volkswagen", ["volkswagen", "vw", "фольксваген"]],
  ["Hyundai", ["hyundai", "хендай", "хундай"]],
  ["Kia", ["kia", "киа"]],
  ["Lada", ["lada", "ваз", "лада"]],
  ["Renault", ["renault", "рено"]],
  ["Nissan", ["nissan", "ниссан"]],
  ["BMW", ["bmw", "бмв"]],
  ["Mercedes-Benz", ["mercedes benz", "mercedes-benz", "mercedes", "benz", "мерседес"]],
  ["Audi", ["audi", "ауди"]],
  ["Honda", ["honda", "хонда"]],
  ["Mazda", ["mazda", "мазда"]],
  ["Ford", ["ford", "форд"]],
  ["Chevrolet", ["chevrolet", "chevy", "шевроле"]],
  ["Skoda", ["skoda", "шкода"]],
  ["Chery", ["chery", "чери"]],
  ["Geely", ["geely", "джили"]],
  ["Haval", ["haval", "хавал"]],
  ["Mitsubishi", ["mitsubishi", "митсубиси"]],
  ["Lexus", ["lexus", "лексус"]],
  ["Subaru", ["subaru", "субару"]],
  ["Suzuki", ["suzuki", "сузуки"]],
  ["Peugeot", ["peugeot", "пежо"]],
  ["Citroen", ["citroen", "citroën", "ситроен"]],
  ["Opel", ["opel", "опель"]],
  ["Volvo", ["volvo", "вольво"]],
  ["Porsche", ["porsche", "порше"]],
  ["Land Rover", ["land rover", "лэнд ровер"]],
  ["Range Rover", ["range rover", "рейндж ровер"]],
  ["Jeep", ["jeep", "джип"]],
  ["Fiat", ["fiat", "фиат"]],
  ["Great Wall", ["great wall", "грейт волл"]],
  ["Exeed", ["exeed", "эксид"]],
  ["Jetour", ["jetour", "джетур"]],
  ["UAZ", ["uaz", "уаз"]],
  ["GAZ", ["gaz", "газ"]]
].map(([label, aliases]) => ({ label, aliases }));

const MODEL_DEFINITIONS = [
  ["Toyota", "Camry", ["camry", "камри"]],
  ["Toyota", "Corolla", ["corolla", "королла"]],
  ["Toyota", "RAV4", ["rav4", "rav 4", "рав4", "рав 4"]],
  ["Toyota", "Land Cruiser", ["land cruiser", "lc200", "lc 200", "lc300", "lc 300"]],
  ["Toyota", "Prado", ["prado", "прадо"]],
  ["Toyota", "Highlander", ["highlander", "хайлендер"]],
  ["Toyota", "Hilux", ["hilux", "хайлюкс"]],
  ["Toyota", "Prius", ["prius", "приус"]],
  ["Toyota", "C-HR", ["c-hr", "chr"]],
  ["Volkswagen", "Tiguan", ["tiguan", "тигуан"]],
  ["Volkswagen", "Polo", ["polo", "поло"]],
  ["Volkswagen", "Passat", ["passat", "пассат"]],
  ["Volkswagen", "Golf", ["golf", "гольф"]],
  ["Volkswagen", "Jetta", ["jetta", "джетта"]],
  ["Volkswagen", "Touareg", ["touareg", "туарег"]],
  ["Volkswagen", "Teramont", ["teramont", "террамонт"]],
  ["Hyundai", "Solaris", ["solaris", "солярис"]],
  ["Hyundai", "Creta", ["creta", "крета"]],
  ["Hyundai", "Tucson", ["tucson", "туссан"]],
  ["Hyundai", "Santa Fe", ["santa fe", "santafe", "санта фе"]],
  ["Hyundai", "Elantra", ["elantra", "элантра"]],
  ["Hyundai", "Sonata", ["sonata", "соната"]],
  ["Hyundai", "ix35", ["ix35", "ix 35"]],
  ["Kia", "Rio", ["rio", "рио"]],
  ["Kia", "Sportage", ["sportage", "спортейдж"]],
  ["Kia", "Sorento", ["sorento", "соренто"]],
  ["Kia", "Ceed", ["ceed", "сид"]],
  ["Kia", "K5", ["k5", "к5"]],
  ["Lada", "Vesta", ["vesta", "веста"]],
  ["Lada", "Granta", ["granta", "гранта"]],
  ["Lada", "Largus", ["largus", "ларгус"]],
  ["Lada", "Niva", ["niva", "нива"]],
  ["Lada", "Kalina", ["kalina", "калина"]],
  ["Renault", "Duster", ["duster", "дастер"]],
  ["Renault", "Logan", ["logan", "логан"]],
  ["Renault", "Sandero", ["sandero", "сандеро"]],
  ["Renault", "Arkana", ["arkana", "аркана"]],
  ["Renault", "Kaptur", ["kaptur", "captur", "каптур"]],
  ["Nissan", "Qashqai", ["qashqai", "кашкай"]],
  ["Nissan", "X-Trail", ["x-trail", "x trail", "икстрейл"]],
  ["Nissan", "Juke", ["juke", "жук"]],
  ["Nissan", "Almera", ["almera", "альмера"]],
  ["Nissan", "Murano", ["murano", "мурано"]],
  ["Nissan", "Teana", ["teana", "теана"]],
  ["BMW", "X1", ["x1", "х1"]],
  ["BMW", "X3", ["x3", "х3"]],
  ["BMW", "X5", ["x5", "х5"]],
  ["BMW", "X6", ["x6", "х6"]],
  ["Mercedes-Benz", "GLC", ["glc", "глц"]],
  ["Mercedes-Benz", "GLE", ["gle", "гле"]],
  ["Mercedes-Benz", "GLS", ["gls", "глс"]],
  ["Audi", "A3", ["a3", "а3"]],
  ["Audi", "A4", ["a4", "а4"]],
  ["Audi", "A6", ["a6", "а6"]],
  ["Audi", "Q3", ["q3", "q 3", "ку3"]],
  ["Audi", "Q5", ["q5", "q 5", "ку5"]],
  ["Audi", "Q7", ["q7", "q 7", "ку7"]],
  ["Honda", "Civic", ["civic", "сивик"]],
  ["Honda", "CR-V", ["cr-v", "crv", "срв"]],
  ["Honda", "Accord", ["accord", "аккорд"]],
  ["Honda", "Fit", ["fit", "фит"]],
  ["Mazda", "CX-5", ["cx-5", "cx5", "сх5"]],
  ["Mazda", "CX-7", ["cx-7", "cx7", "сх7"]],
  ["Mazda", "CX-9", ["cx-9", "cx9", "сх9"]],
  ["Mazda", "Mazda 3", ["mazda 3", "mazda3", "мазда 3"]],
  ["Mazda", "Mazda 6", ["mazda 6", "mazda6", "мазда 6"]],
  ["Ford", "Focus", ["focus", "фокус"]],
  ["Ford", "Mondeo", ["mondeo", "мондео"]],
  ["Ford", "Kuga", ["kuga", "куга"]],
  ["Ford", "Fiesta", ["fiesta", "фиеста"]],
  ["Ford", "Explorer", ["explorer", "эксплорер"]],
  ["Chevrolet", "Cruze", ["cruze", "круз"]],
  ["Chevrolet", "Aveo", ["aveo", "авео"]],
  ["Chevrolet", "Cobalt", ["cobalt", "кобальт"]],
  ["Chevrolet", "Lacetti", ["lacetti", "лачетти"]],
  ["Chevrolet", "Captiva", ["captiva", "каптива"]],
  ["Skoda", "Octavia", ["octavia", "октавия"]],
  ["Skoda", "Rapid", ["rapid", "рапид"]],
  ["Skoda", "Kodiaq", ["kodiaq", "кодиак"]],
  ["Skoda", "Karoq", ["karoq", "карок"]],
  ["Skoda", "Superb", ["superb", "суперб"]],
  ["Chery", "Tiggo", ["tiggo", "тигго"]],
  ["Chery", "Arrizo", ["arrizo", "арризо"]],
  ["Geely", "Coolray", ["coolray", "кулрей"]],
  ["Geely", "Atlas", ["atlas", "атлас"]],
  ["Geely", "Emgrand", ["emgrand", "эмгранд"]],
  ["Geely", "Monjaro", ["monjaro", "монжаро"]],
  ["Haval", "Jolion", ["jolion", "джолион"]],
  ["Haval", "F7", ["f7", "ф7"]],
  ["Haval", "H6", ["h6", "н6"]],
  ["Haval", "Dargo", ["dargo", "дарго"]],
  ["Mitsubishi", "Outlander", ["outlander", "аутлендер"]],
  ["Mitsubishi", "Lancer", ["lancer", "лансер"]],
  ["Mitsubishi", "Pajero", ["pajero", "паджеро"]],
  ["Mitsubishi", "ASX", ["asx", "асх"]],
  ["Lexus", "RX", ["rx", "рх"]],
  ["Lexus", "NX", ["nx", "нх"]],
  ["Lexus", "LX", ["lx", "лх"]],
  ["Lexus", "GX", ["gx", "гх"]],
  ["Lexus", "ES", ["es", "ес"]],
  ["Subaru", "Forester", ["forester", "форестер"]],
  ["Subaru", "Outback", ["outback", "аутбек"]],
  ["Subaru", "XV", ["xv", "хв"]],
  ["Suzuki", "Swift", ["swift", "свифт"]],
  ["Suzuki", "Vitara", ["vitara", "витара"]],
  ["Peugeot", "3008", ["3008"]],
  ["Peugeot", "408", ["408"]],
  ["Citroen", "C4", ["c4", "с4"]],
  ["Opel", "Astra", ["astra", "астра"]],
  ["Opel", "Mokka", ["mokka", "мокка"]],
  ["Volvo", "XC60", ["xc60", "xc 60"]],
  ["Volvo", "XC90", ["xc90", "xc 90"]],
  ["Porsche", "Cayenne", ["cayenne", "кайен"]],
  ["Porsche", "Macan", ["macan", "макан"]],
  ["Range Rover", "Evoque", ["evoque", "эвок"]],
  ["Land Rover", "Discovery", ["discovery", "дискавери"]],
  ["Land Rover", "Freelander", ["freelander", "фрилендер"]],
  ["Land Rover", "Defender", ["defender", "дефендер"]],
  ["Jeep", "Compass", ["compass", "компас"]],
  ["Jeep", "Renegade", ["renegade", "ренегат"]],
  ["Jeep", "Grand Cherokee", ["grand cherokee", "cherokee", "чероки"]],
  ["Fiat", "Ducato", ["ducato", "дукато"]],
  ["Great Wall", "Hover", ["hover", "ховер"]],
  ["Great Wall", "Poer", ["poer", "поер"]],
  ["Exeed", "VX", ["vx", "вх"]],
  ["Exeed", "TXL", ["txl", "тхл"]],
  ["Jetour", "Dashing", ["dashing", "дашинг"]]
].map(([brand, label, aliases]) => ({ brand, label, aliases }));

const PRODUCT_KEYWORDS = [
  ["floor_mat", "脚垫", ["floor mat", "floor mats", "коврик", "коврики", "ковров", "ковра", "脚垫", "地垫"]],
  ["trunk_mat", "后备箱垫", ["trunk mat", "boot mat", "cargo liner", "багажник", "багажника", "багажный", "后备箱", "尾箱"]],
  ["seat_cover", "座套", ["seat cover", "seat covers", "чехол", "чехлы", "сидень", "座套", "坐垫"]],
  ["wiper", "雨刮", ["wiper", "wipers", "щетка", "щетки", "дворник", "дворники", "雨刮", "雨刷"]],
  ["mud_flap", "挡泥板", ["mud flap", "mudflap", "брызговик", "брызговики", "挡泥板"]],
  ["door_sill", "门槛条", ["door sill", "threshold", "накладка на порог", "порог", "пороги", "门槛", "迎宾踏板"]],
  ["sunshade", "遮阳", ["sunshade", "shade", "шторка", "шторки", "遮阳", "遮光"]],
  ["organizer", "收纳", ["organizer", "органайзер", "storage box", "收纳", "置物"]],
  ["armrest", "扶手箱", ["armrest", "подлокотник", "扶手箱"]],
  ["steering_cover", "方向盘套", ["steering wheel cover", "руля", "руль", "方向盘"]],
  ["mirror_cover", "后视镜壳", ["mirror cover", "зеркал", "后视镜"]],
  ["bumper_guard", "保险杠护板", ["bumper", "бампер", "保险杠"]],
  ["phone_holder", "手机支架", ["phone holder", "держатель", "手机支架"]],
  ["air_filter", "空调滤芯", ["air filter", "cabin filter", "фильтр", "滤芯", "空调滤"]],
  ["deflector", "晴雨挡", ["deflector", "ветровик", "дефлектор", "晴雨挡", "雨眉"]],
  ["screen_protector", "屏幕膜", ["screen protector", "защитная пленка", "пленка", "屏幕膜", "保护膜"]],
  ["key_case", "钥匙套", ["key case", "ключ", "ключа", "钥匙套", "钥匙壳"]]
].map(([key, label, aliases]) => ({ key, label, aliases }));

const UNKNOWN_BRAND = "未识别品牌";
const UNKNOWN_MODEL = "未识别车型";
const UNKNOWN_PRODUCT_KEY = "unknown_product";
const UNKNOWN_PRODUCT_LABEL = "未识别产品";

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function titleHash(value = "") {
  return crypto.createHash("sha256").update(normalizeText(value)).digest("hex");
}

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

async function ensureOrderCarHeatmapSchema() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS order_vehicle_title_tags (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title_hash CHAR(64) NOT NULL,
      title_text TEXT NOT NULL,
      brand VARCHAR(128) NOT NULL DEFAULT '',
      model VARCHAR(128) NOT NULL DEFAULT '',
      product_key VARCHAR(128) NOT NULL DEFAULT '',
      product_label VARCHAR(128) NOT NULL DEFAULT '',
      years_json JSON NULL,
      confidence DECIMAL(5,4) NOT NULL DEFAULT 0,
      source VARCHAR(32) NOT NULL DEFAULT 'rule',
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      sample_ozon_sku VARCHAR(128) NOT NULL DEFAULT '',
      sample_offer_id VARCHAR(255) NOT NULL DEFAULT '',
      raw_response_json LONGTEXT NULL,
      reviewed_by_person_id BIGINT NULL,
      reviewed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_order_vehicle_title_tags_hash (title_hash),
      KEY idx_order_vehicle_title_tags_status (status, source, updated_at),
      KEY idx_order_vehicle_title_tags_vehicle (brand, model),
      KEY idx_order_vehicle_title_tags_product (product_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function normalizeTagRecord(value = {}) {
  const brand = String(value.brand || "").trim() || UNKNOWN_BRAND;
  const model = String(value.model || "").trim() || UNKNOWN_MODEL;
  const productKey = String(value.product_key || value.productKey || "").trim() || UNKNOWN_PRODUCT_KEY;
  const knownProductLabel = productLabelByKey(productKey);
  const productLabel = productKey === UNKNOWN_PRODUCT_KEY
    ? (String(value.product_label || value.productLabel || "").trim() || knownProductLabel)
    : knownProductLabel;
  const confidence = Math.max(0, Math.min(1, Number(value.confidence || 0)));
  const years = Array.isArray(value.years) ? value.years.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [];
  return {
    brand,
    model,
    product_key: productKey,
    product_label: productLabel,
    years,
    confidence,
    matched: brand !== UNKNOWN_BRAND && model !== UNKNOWN_MODEL,
    product_matched: productKey !== UNKNOWN_PRODUCT_KEY,
    source: String(value.source || "rule").trim() || "rule",
    status: String(value.status || tagStatus(confidence, brand, model)).trim() || "pending"
  };
}

function productLabelByKey(key) {
  return PRODUCT_KEYWORDS.find((item) => item.key === key)?.label || UNKNOWN_PRODUCT_LABEL;
}

function tagStatus(confidence, brand, model) {
  if (brand === UNKNOWN_BRAND || model === UNKNOWN_MODEL) return "unmatched";
  if (Number(confidence || 0) >= 0.85) return "accepted";
  return "review";
}

function dbTagToParsed(row = {}) {
  const normalized = normalizeTagRecord({
    brand: row.brand,
    model: row.model,
    product_key: row.product_key,
    product_label: row.product_label,
    years: safeJsonParse(row.years_json, []),
    confidence: row.confidence,
    source: row.source,
    status: row.status
  });
  return {
    ...normalized,
    title_hash: row.title_hash,
    source: row.source || normalized.source,
    status: row.status || normalized.status
  };
}

async function loadTagCacheForRows(rows = []) {
  await ensureOrderCarHeatmapSchema();
  const hashes = [...new Set(rows.map((row) => titleHash(rowTitle(row))).filter(Boolean))];
  if (!hashes.length) return new Map();
  const cache = new Map();
  const chunkSize = 500;
  for (let index = 0; index < hashes.length; index += chunkSize) {
    const chunk = hashes.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const records = await mysqlQuery(`
      SELECT *
      FROM order_vehicle_title_tags
      WHERE title_hash IN (${placeholders})
    `, chunk);
    for (const record of records) {
      cache.set(record.title_hash, dbTagToParsed(record));
    }
  }
  return cache;
}

function parsedForRow(row = {}, cache = new Map()) {
  const hash = titleHash(rowTitle(row));
  const cached = cache.get(hash);
  if (cached && cached.source !== "rule") return cached;
  if (cached && Number(cached.confidence || 0) >= 0.85) return cached;
  return {
    ...parseOrderVehicleTitle(rowTitle(row)),
    title_hash: hash,
    source: "rule",
    status: "rule"
  };
}

async function saveTitleTag(tag = {}, options = {}) {
  await ensureOrderCarHeatmapSchema();
  const title = String(tag.title || tag.title_text || "").trim();
  if (!title) throw new Error("标题不能为空");
  const hash = String(tag.title_hash || titleHash(title));
  const normalized = normalizeTagRecord(tag);
  await mysqlExecute(`
    INSERT INTO order_vehicle_title_tags (
      title_hash, title_text, brand, model, product_key, product_label, years_json,
      confidence, source, status, sample_ozon_sku, sample_offer_id, raw_response_json,
      reviewed_by_person_id, reviewed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title_text = VALUES(title_text),
      brand = VALUES(brand),
      model = VALUES(model),
      product_key = VALUES(product_key),
      product_label = VALUES(product_label),
      years_json = VALUES(years_json),
      confidence = VALUES(confidence),
      source = VALUES(source),
      status = VALUES(status),
      sample_ozon_sku = COALESCE(NULLIF(VALUES(sample_ozon_sku), ''), sample_ozon_sku),
      sample_offer_id = COALESCE(NULLIF(VALUES(sample_offer_id), ''), sample_offer_id),
      raw_response_json = VALUES(raw_response_json),
      reviewed_by_person_id = COALESCE(VALUES(reviewed_by_person_id), reviewed_by_person_id),
      reviewed_at = COALESCE(VALUES(reviewed_at), reviewed_at),
      updated_at = CURRENT_TIMESTAMP
  `, [
    hash,
    title,
    normalized.brand,
    normalized.model,
    normalized.product_key,
    normalized.product_label,
    JSON.stringify(normalized.years || []),
    normalized.confidence,
    normalized.source,
    normalized.status,
    String(tag.sample_ozon_sku || tag.ozon_sku || ""),
    String(tag.sample_offer_id || tag.offer_id || ""),
    tag.raw_response_json ? JSON.stringify(tag.raw_response_json) : null,
    options.personId || null,
    options.personId ? new Date() : null
  ]);
  return { ok: true, title_hash: hash, ...normalized };
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(alias = "") {
  return normalizeText(alias).split(/[\s-]+/).map(escapeRegExp).join("[\\s-]*");
}

function hasAlias(text, alias) {
  if (!alias) return false;
  const pattern = aliasPattern(alias);
  return new RegExp(`(^|${WORD_BOUNDARY})${pattern}($|${WORD_BOUNDARY})`, "i").test(text);
}

function findFirstMatch(text, definitions) {
  return definitions.find((definition) => definition.aliases.some((alias) => hasAlias(text, alias))) || null;
}

function findModelMatches(text) {
  return MODEL_DEFINITIONS
    .filter((definition) => definition.aliases.some((alias) => hasAlias(text, alias)))
    .sort((a, b) => b.label.length - a.label.length);
}

function extractYears(text) {
  const years = new Set();
  for (const match of text.matchAll(/\b(19[8-9]\d|20[0-3]\d)\b/g)) {
    years.add(match[1]);
  }
  return [...years].sort();
}

export function parseOrderVehicleTitle(title = "") {
  const normalized = normalizeText(title);
  const brandMatch = findFirstMatch(normalized, BRAND_DEFINITIONS);
  const modelMatches = findModelMatches(normalized);
  const productMatch = findFirstMatch(normalized, PRODUCT_KEYWORDS);
  const brand = brandMatch?.label || modelMatches[0]?.brand || UNKNOWN_BRAND;
  const brandModels = modelMatches.filter((item) => !brandMatch || item.brand === brandMatch.label);
  const modelMatch = brandModels[0] || modelMatches[0] || null;
  const productKey = productMatch?.key || UNKNOWN_PRODUCT_KEY;
  const confidence = [
    brand !== UNKNOWN_BRAND ? 0.35 : 0,
    modelMatch ? 0.45 : 0,
    productMatch ? 0.2 : 0
  ].reduce((sum, value) => sum + value, 0);
  return {
    brand,
    model: modelMatch?.label || UNKNOWN_MODEL,
    product_key: productKey,
    product_label: productMatch?.label || UNKNOWN_PRODUCT_LABEL,
    years: extractYears(normalized),
    confidence: Number(confidence.toFixed(2)),
    matched: brand !== UNKNOWN_BRAND && Boolean(modelMatch),
    product_matched: Boolean(productMatch)
  };
}

function normalizeDateKey(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function chinaDateSql(expr) {
  return `DATE(CONVERT_TZ(${expr}, '+00:00', '+08:00'))`;
}

function statusText(row = {}) {
  return `${row.status || ""} ${row.tracking_stage || ""} ${row.logistics_status || ""}`.toLowerCase();
}

function isCancelledRow(row = {}) {
  const text = statusText(row);
  return text.includes("cancel") || text.includes("return") || text.includes("not_accepted");
}

function rowTitle(row = {}) {
  return [row.ozon_name, row.online_product_name, row.product_name]
    .map((item) => String(item || "").trim())
    .find(Boolean) || "";
}

function skuKey(row = {}) {
  return String(row.ozon_sku || row.offer_id || row.online_offer_id || row.sku_mapping_id || row.order_item_id || "").trim();
}

function addMetric(target, row) {
  const orderKey = String(row.order_id || row.posting_number || row.order_item_id || "");
  const sku = skuKey(row);
  if (orderKey) target.orderIds.add(orderKey);
  if (sku) target.skus.add(sku);
  if (sku && orderKey) {
    if (!target.skuOrderIds.has(sku)) target.skuOrderIds.set(sku, new Set());
    target.skuOrderIds.get(sku).add(orderKey);
  }
  const productKey = row.parsed?.product_key || "";
  if (productKey && productKey !== UNKNOWN_PRODUCT_KEY) target.productKeys.add(productKey);
  target.item_quantity += Number(row.quantity || 0);
  target.revenue += Number(row.sale_price || 0) * Number(row.quantity || 0);
  target.estimated_profit += Number(row.estimated_profit || 0);
  target.actual_profit += Number(row.actual_profit || 0);
  target.shops.add(String(row.shop_id || ""));
  const orderedAt = String(row.ordered_at || "");
  if (orderedAt && (!target.latest_ordered_at || orderedAt > target.latest_ordered_at)) {
    target.latest_ordered_at = orderedAt;
  }
  if (!target.sample_title && rowTitle(row)) target.sample_title = rowTitle(row);
  if (!target.image_url && row.image_url) target.image_url = row.image_url;
}

function finalizeMetric(metric) {
  const orderCount = metric.orderIds.size;
  const skuCount = metric.skus.size;
  const topSkuOrderCount = Math.max(0, ...[...metric.skuOrderIds.values()].map((orderIds) => orderIds.size));
  const topSkuOrderShare = orderCount ? Number((topSkuOrderCount / orderCount).toFixed(4)) : 0;
  return {
    sku_count: skuCount,
    order_count: orderCount,
    product_count: metric.productKeys.size,
    orders_per_sku: skuCount ? Number((orderCount / skuCount).toFixed(2)) : 0,
    top_sku_order_share: topSkuOrderShare,
    item_quantity: metric.item_quantity,
    revenue: Number(metric.revenue.toFixed(2)),
    estimated_profit: Number(metric.estimated_profit.toFixed(2)),
    actual_profit: Number(metric.actual_profit.toFixed(2)),
    avg_order_value: orderCount ? Number((metric.revenue / orderCount).toFixed(2)) : 0,
    shop_count: [...metric.shops].filter(Boolean).length,
    latest_ordered_at: metric.latest_ordered_at || null,
    sample_title: metric.sample_title || "",
    image_url: metric.image_url || ""
  };
}

function createMetric(extra = {}) {
  return {
    orderIds: new Set(),
    skus: new Set(),
    skuOrderIds: new Map(),
    productKeys: new Set(),
    shops: new Set(),
    item_quantity: 0,
    revenue: 0,
    estimated_profit: 0,
    actual_profit: 0,
    latest_ordered_at: "",
    sample_title: "",
    image_url: "",
    ...extra
  };
}

function matchesSelection(parsed, query = {}) {
  const brand = String(query.brand || "").trim();
  const model = String(query.model || "").trim();
  const productKey = String(query.productKey || query.product_key || "").trim();
  if (brand && parsed.brand !== brand) return false;
  if (model && parsed.model !== model) return false;
  if (productKey && parsed.product_key !== productKey) return false;
  return true;
}

const CORE_PRODUCT_KEYS = ["floor_mat", "trunk_mat", "seat_cover", "door_sill", "mud_flap", "sunshade", "organizer", "key_case"];

function productSuggestionText(productKeys = []) {
  const existing = new Set(productKeys);
  const missing = CORE_PRODUCT_KEYS
    .filter((key) => !existing.has(key))
    .slice(0, 3)
    .map(productLabelByKey)
    .filter(Boolean);
  return missing.length ? `补 ${missing.join(" / ")}` : "扩颜色、年份和套装组合";
}

function opportunityGrade(score, matched) {
  if (!matched) return "待识别";
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  return "观察";
}

function decorateModelOpportunity(row = {}, productKeys = []) {
  const matched = row.matched && row.brand !== UNKNOWN_BRAND && row.model !== UNKNOWN_MODEL;
  const skuBreadth = Math.min(Number(row.sku_count || 0), 20) * 2;
  const density = Math.min(Number(row.orders_per_sku || 0), 12) * 4;
  const productCoverage = Math.min(Number(row.product_count || 0), 8) * 5;
  const orderBase = Math.min(Number(row.order_count || 0), 80) * 0.35;
  const recency = row.latest_ordered_at ? 8 : 0;
  const concentration = Number(row.top_sku_order_share || 0);
  const riskPenalty = concentration > 0.75 ? 14 : concentration > 0.55 ? 8 : 0;
  const unknownPenalty = matched ? 0 : 35;
  const score = Math.max(0, Math.min(100, Math.round(skuBreadth + density + productCoverage + orderBase + recency - riskPenalty - unknownPenalty)));
  const cappedScore = matched ? score : Math.min(score, 45);
  let recommendation = productSuggestionText(productKeys);
  const reasons = [];

  if (!matched) {
    recommendation = "先确认车型，再判断是否值得补款";
    reasons.push("车型识别不足");
  } else if (row.sku_count >= 8 && row.orders_per_sku < 1.5) {
    recommendation = "先优化低效 SKU，保留有单款";
    reasons.push("SKU 多但单 SKU 订单偏低");
  } else if (row.orders_per_sku >= 3 && row.sku_count <= 5) {
    recommendation = "扩同款 SKU 和关联产品线";
    reasons.push("单 SKU 出单密度高");
  } else if (row.product_count <= 1 && row.order_count >= 3) {
    recommendation = productSuggestionText(productKeys);
    reasons.push("产品覆盖窄");
  } else if (concentration > 0.65) {
    recommendation = "复制头部 SKU 卖点，降低单款依赖";
    reasons.push("订单集中在少数 SKU");
  } else {
    reasons.push("SKU、订单和产品覆盖较均衡");
  }

  if (row.order_count >= 10) reasons.push("订单基础较好");
  if (row.sku_count >= 5) reasons.push("已有多 SKU 验证");
  if (row.product_count >= 3) reasons.push("已有多产品关键词");

  return {
    ...row,
    opportunity_score: cappedScore,
    opportunity_grade: opportunityGrade(cappedScore, matched),
    recommendation,
    recommendation_reasons: [...new Set(reasons)].slice(0, 3)
  };
}

export function aggregateOrderCarHeatmapRows(rows = [], query = {}, options = {}) {
  const includeCancelled = String(query.includeCancelled || query.include_cancelled || "0") === "1";
  const cache = options.cache || new Map();
  const modelMap = new Map();
  const productMap = new Map();
  const skuMap = new Map();
  const unmatchedSamples = [];
  const totals = createMetric();

  for (const row of rows) {
    if (!includeCancelled && isCancelledRow(row)) continue;
    const parsed = parsedForRow(row, cache);
    const enriched = { ...row, parsed };
    addMetric(totals, enriched);
    if (!parsed.matched && unmatchedSamples.length < 12) {
      unmatchedSamples.push({
        title: rowTitle(row),
        title_hash: parsed.title_hash || titleHash(rowTitle(row)),
        confidence: parsed.confidence,
        source: parsed.source,
        status: parsed.status,
        sku: row.ozon_sku || "",
        ordered_at: row.ordered_at || null,
        shop_name: row.shop_name || ""
      });
    }

    const modelKey = `${parsed.brand}||${parsed.model}`;
    if (!modelMap.has(modelKey)) {
      modelMap.set(modelKey, createMetric({
        brand: parsed.brand,
        model: parsed.model,
        matched: parsed.matched,
        confidence_total: 0,
        parsed_count: 0
      }));
    }
    const modelMetric = modelMap.get(modelKey);
    modelMetric.confidence_total += parsed.confidence;
    modelMetric.parsed_count += 1;
    addMetric(modelMetric, enriched);

    if (!matchesSelection(parsed, query)) continue;

    const productKey = `${parsed.product_key}`;
    if (!productMap.has(productKey)) {
      productMap.set(productKey, createMetric({
        product_key: parsed.product_key,
        product_label: parsed.product_label,
        product_matched: parsed.product_matched
      }));
    }
    addMetric(productMap.get(productKey), enriched);

    const sku = skuKey(row) || `item:${row.order_item_id}`;
    if (!skuMap.has(sku)) {
      skuMap.set(sku, createMetric({
        sku,
        ozon_sku: row.ozon_sku || "",
        offer_id: row.offer_id || row.online_offer_id || "",
        product_code: row.product_code || "",
        product_name: row.product_name || "",
        title: rowTitle(row),
        shop_names: new Set()
      }));
    }
    const skuMetric = skuMap.get(sku);
    skuMetric.shop_names.add(row.shop_name || "");
    addMetric(skuMetric, enriched);
  }

  const models = [...modelMap.values()].map((metric) => decorateModelOpportunity({
    brand: metric.brand,
    model: metric.model,
    matched: metric.matched,
    confidence: metric.parsed_count ? Number((metric.confidence_total / metric.parsed_count).toFixed(2)) : 0,
    ...finalizeMetric(metric)
  }, [...metric.productKeys])).sort((a, b) => (
    b.opportunity_score - a.opportunity_score
    || b.sku_count - a.sku_count
    || b.order_count - a.order_count
  ));

  const products = [...productMap.values()].map((metric) => ({
    product_key: metric.product_key,
    product_label: metric.product_label,
    product_matched: metric.product_matched,
    ...finalizeMetric(metric)
  })).sort((a, b) => b.order_count - a.order_count || b.sku_count - a.sku_count);

  const skus = [...skuMap.values()].map((metric) => ({
    sku: metric.sku,
    ozon_sku: metric.ozon_sku,
    offer_id: metric.offer_id,
    product_code: metric.product_code,
    product_name: metric.product_name,
    title: metric.title,
    shop_names: [...metric.shop_names].filter(Boolean).join(", "),
    ...finalizeMetric(metric)
  })).sort((a, b) => b.order_count - a.order_count || b.item_quantity - a.item_quantity);

  return {
    models,
    products,
    skus,
    totals: finalizeMetric(totals),
    unmatched_samples: unmatchedSamples
  };
}

function uniqueUnmatchedRows(rows = [], cache = new Map(), limit = 30, query = {}) {
  const includeCancelled = String(query.includeCancelled || query.include_cancelled || "0") === "1";
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (!includeCancelled && isCancelledRow(row)) continue;
    const title = rowTitle(row);
    const hash = titleHash(title);
    if (!title || seen.has(hash)) continue;
    seen.add(hash);
    const parsed = parsedForRow(row, cache);
    const needsAi = parsed.status === "unmatched"
      || parsed.status === "review"
      || parsed.brand === UNKNOWN_BRAND
      || parsed.model === UNKNOWN_MODEL
      || Number(parsed.confidence || 0) < 0.85;
    if (!needsAi) continue;
    result.push({
      title_hash: hash,
      title,
      ozon_sku: row.ozon_sku || "",
      offer_id: row.offer_id || row.online_offer_id || "",
      shop_name: row.shop_name || "",
      ordered_at: row.ordered_at || null,
      rule_brand: parsed.brand,
      rule_model: parsed.model,
      rule_product_key: parsed.product_key,
      rule_product_label: parsed.product_label,
      confidence: parsed.confidence,
      source: parsed.source || "rule",
      status: parsed.status || "rule"
    });
    if (result.length >= limit) break;
  }
  return result;
}

function extractJsonFromAi(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(raw.slice(objectStart, objectEnd + 1));
    } catch {}
  }
  return null;
}

function normalizeAiItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function buildAiPrompt(items = []) {
  return [
    "识别 Ozon 汽车用品标题中的品牌、车型、产品类型、年份。只输出 JSON 数组。",
    "字段：title_hash, brand, model, product_key, product_label, years, confidence, needs_review。",
    "产品 key 只能用：floor_mat,trunk_mat,seat_cover,wiper,mud_flap,door_sill,sunshade,organizer,armrest,steering_cover,mirror_cover,bumper_guard,phone_holder,air_filter,deflector,screen_protector,key_case,unknown_product。",
    "无法判断品牌/车型时用：未识别品牌/未识别车型。不要编造。",
    JSON.stringify(items.map((item) => ({
      title_hash: item.title_hash,
      title: item.title
    })))
  ].join("\n");
}

async function classifyTitlesWithAi(items = []) {
  if (!items.length) return [];
  const result = await chatWithAiProvider({
    messages: [
      {
        role: "system",
        content: "你只做结构化 JSON 抽取。输出必须是合法 JSON，不能包含解释。"
      },
      {
        role: "user",
        content: buildAiPrompt(items)
      }
    ],
    temperature: 0,
    maxTokens: 1200,
    timeoutMs: 30_000
  });
  const parsed = extractJsonFromAi(result.content);
  const aiRows = normalizeAiItems(parsed);
  const byHash = new Map(items.map((item) => [item.title_hash, item]));
  const saved = [];
  for (const aiRow of aiRows) {
    const hash = String(aiRow.title_hash || aiRow.titleHash || "").trim();
    const source = byHash.get(hash);
    if (!source) continue;
    const normalized = normalizeTagRecord({
      brand: aiRow.brand,
      model: aiRow.model,
      product_key: aiRow.product_key || aiRow.productKeyword,
      product_label: aiRow.product_label || aiRow.productLabel,
      years: aiRow.years,
      confidence: aiRow.confidence,
      source: "ai",
      status: aiRow.needs_review ? "review" : tagStatus(Number(aiRow.confidence || 0), aiRow.brand, aiRow.model)
    });
    const savedRow = await saveTitleTag({
      title_hash: hash,
      title: source.title,
      sample_ozon_sku: source.ozon_sku,
      sample_offer_id: source.offer_id,
      ...normalized,
      raw_response_json: aiRow
    });
    saved.push({ ...savedRow, title: source.title });
  }
  return saved;
}

function buildOrderItemWhere(query = {}) {
  const where = ["1 = 1"];
  const params = [];
  const from = normalizeDateKey(query.from || query.dateFrom || query.date_from);
  const to = normalizeDateKey(query.to || query.dateTo || query.date_to);
  const shopId = String(query.shopId || query.shop_id || "all");
  if (from) {
    where.push(`${chinaDateSql("o.ordered_at")} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${chinaDateSql("o.ordered_at")} <= ?`);
    params.push(to);
  }
  if (shopId && shopId !== "all") {
    where.push("o.shop_id = ?");
    params.push(Number(shopId));
  }
  return { where: where.join(" AND "), params, from, to, shopId };
}

async function orderCarHeatmapSourceRows(query = {}) {
  const base = buildOrderItemWhere(query);
  const limit = Math.min(Math.max(Number(query.sourceLimit || query.source_limit || query.rowLimit || query.row_limit || 60000), 1), 200000);
  const rows = await mysqlQuery(`
    SELECT
      oi.id AS order_item_id,
      o.id AS order_id,
      o.shop_id,
      s.name AS shop_name,
      o.posting_number,
      o.order_number,
      o.status,
      o.tracking_stage,
      o.logistics_status,
      o.ordered_at,
      oi.ozon_sku,
      oi.ozon_name,
      COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), NULLIF(p.image_url, '')) AS image_url,
      oi.quantity,
      oi.sale_price,
      oi.estimated_profit,
      oi.actual_profit,
      oi.sku_mapping_id,
      sm.offer_id,
      sm.product_id,
      p.code AS product_code,
      p.name AS product_name,
      op.id AS online_product_id,
      op.name AS online_product_name,
      op.offer_id AS online_offer_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN shops s ON s.id = o.shop_id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    WHERE ${base.where}
    ORDER BY o.ordered_at DESC, oi.id DESC
    LIMIT ?
  `, [...base.params, limit]);
  return { rows, filters: base, limit };
}

function responseFilters(source, query = {}) {
  return {
    from: source.filters.from,
    to: source.filters.to,
    shopId: source.filters.shopId,
    includeCancelled: String(query.includeCancelled || query.include_cancelled || "0") === "1",
    limit: source.limit
  };
}

export async function orderCarHeatmapModelsMysql(query = {}) {
  const source = await orderCarHeatmapSourceRows(query);
  const cache = await loadTagCacheForRows(source.rows);
  const result = aggregateOrderCarHeatmapRows(source.rows, query, { cache });
  return {
    rows: result.models,
    totals: result.totals,
    unmatched_samples: result.unmatched_samples,
    filters: responseFilters(source, query),
    source_rows: source.rows.length
  };
}

export async function orderCarHeatmapProductsMysql(query = {}) {
  const source = await orderCarHeatmapSourceRows(query);
  const cache = await loadTagCacheForRows(source.rows);
  const result = aggregateOrderCarHeatmapRows(source.rows, query, { cache });
  return {
    rows: result.products,
    selected: {
      brand: String(query.brand || ""),
      model: String(query.model || "")
    },
    totals: result.products.reduce((acc, row) => {
      acc.order_count += Number(row.order_count || 0);
      acc.sku_count += Number(row.sku_count || 0);
      acc.item_quantity += Number(row.item_quantity || 0);
      acc.revenue += Number(row.revenue || 0);
      return acc;
    }, { order_count: 0, sku_count: 0, item_quantity: 0, revenue: 0 }),
    filters: responseFilters(source, query),
    source_rows: source.rows.length
  };
}

export async function orderCarHeatmapSkusMysql(query = {}) {
  const source = await orderCarHeatmapSourceRows(query);
  const cache = await loadTagCacheForRows(source.rows);
  const result = aggregateOrderCarHeatmapRows(source.rows, query, { cache });
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 20), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const start = (page - 1) * pageSize;
  const rows = result.skus.slice(start, start + pageSize);
  return {
    rows,
    total: result.skus.length,
    page,
    pageSize,
    total_pages: Math.max(1, Math.ceil(result.skus.length / pageSize)),
    selected: {
      brand: String(query.brand || ""),
      model: String(query.model || ""),
      product_key: String(query.productKey || query.product_key || "")
    },
    totals: result.skus.reduce((acc, row) => {
      acc.order_count += Number(row.order_count || 0);
      acc.item_quantity += Number(row.item_quantity || 0);
      acc.revenue += Number(row.revenue || 0);
      acc.estimated_profit += Number(row.estimated_profit || 0);
      acc.actual_profit += Number(row.actual_profit || 0);
      return acc;
    }, { order_count: 0, item_quantity: 0, revenue: 0, estimated_profit: 0, actual_profit: 0 }),
    filters: responseFilters(source, query),
    source_rows: source.rows.length
  };
}

export async function orderCarHeatmapUnmatchedMysql(query = {}) {
  const source = await orderCarHeatmapSourceRows(query);
  const cache = await loadTagCacheForRows(source.rows);
  const limit = Math.min(Math.max(Number(query.limit || 30), 1), 100);
  const rows = uniqueUnmatchedRows(source.rows, cache, limit, query);
  return {
    rows,
    total: rows.length,
    filters: responseFilters(source, query),
    source_rows: source.rows.length
  };
}

export async function orderCarHeatmapAiClassifyMysql(body = {}) {
  const source = await orderCarHeatmapSourceRows(body);
  const cache = await loadTagCacheForRows(source.rows);
  const limit = Math.min(Math.max(Number(body.aiLimit || body.ai_limit || body.classifyLimit || body.classify_limit || body.limit || 5), 1), 10);
  const candidates = uniqueUnmatchedRows(source.rows, cache, limit, body);
  const saved = await classifyTitlesWithAi(candidates);
  return {
    ok: true,
    requested: candidates.length,
    saved_count: saved.length,
    rows: saved,
    filters: responseFilters(source, body),
    source_rows: source.rows.length
  };
}

export async function orderCarHeatmapConfirmTagMysql(body = {}, personId = null) {
  const result = await saveTitleTag({
    title: body.title || body.title_text,
    title_hash: body.title_hash,
    brand: body.brand,
    model: body.model,
    product_key: body.product_key || body.productKey,
    product_label: body.product_label || body.productLabel,
    years: body.years,
    confidence: Number(body.confidence || 1),
    source: "manual",
    status: "accepted",
    sample_ozon_sku: body.ozon_sku || body.sample_ozon_sku,
    sample_offer_id: body.offer_id || body.sample_offer_id,
    raw_response_json: { manual: true, at: new Date().toISOString() }
  }, { personId });
  return result;
}

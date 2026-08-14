import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

const TAGS = [
  { key: "hot_all", label: "热门车（新车 + 二手车）" },
  { key: "hot_new", label: "热门新车" },
  { key: "hot_new_energy", label: "新能源热门车型" },
  { key: "hot_used", label: "热门二手车" },
  { key: "priority_brand", label: "优先品牌" },
  { key: "top_priority_model", label: "最优先车型" }
];

const VEHICLE_BRAND_ZH = {
  LADA: "拉达", HAVAL: "哈弗", TENET: "特耐", GEELY: "吉利", BELGEE: "贝尔吉",
  CHANGAN: "长安", CHERY: "奇瑞", OMODA: "欧萌达", JETOUR: "捷途", JAECOO: "杰酷",
  EXEED: "星途", TANK: "坦克", GAC: "广汽", MOSKVICH: "莫斯科人", SOLARIS: "索拉里斯",
  UAZ: "瓦滋", VOYAH: "岚图", HONGQI: "红旗", "LI AUTO / LIXIANG": "理想",
  EVOLUTE: "埃沃拉特", "LYNK & CO": "领克", BMW: "宝马", TOYOTA: "丰田", KIA: "起亚",
  HYUNDAI: "现代", NISSAN: "日产", VOLKSWAGEN: "大众", RENAULT: "雷诺", FORD: "福特",
  SKODA: "斯柯达", CHEVROLET: "雪佛兰", MITSUBISHI: "三菱", MAZDA: "马自达",
  HONDA: "本田", SUBARU: "斯巴鲁", LEXUS: "雷克萨斯", "MERCEDES-BENZ": "奔驰"
};

const NEW_VEHICLES = [
  ["LADA", ["Granta", "Vesta", "Niva Travel", "Niva Legend", "Iskra", "Largus"]],
  ["HAVAL", ["Jolion", "M6", "F7", "F7x", "Dargo", "H3", "H9"]],
  ["TENET", ["T7", "T4L", "T4", "T8"]],
  ["GEELY", ["Monjaro", "Atlas", "Coolray", "Cityray", "EX5 EM-i"]],
  ["BELGEE", ["X50", "X50+", "X70", "S50"]],
  ["CHANGAN", ["UNI-S / CS55 Plus", "CS35 Plus", "UNI-K", "UNI-T", "CS75 Plus"]],
  ["CHERY", ["Tiggo 4 Pro", "Tiggo 7 Pro Max", "Tiggo 8 Pro Max", "Arrizo 8"]],
  ["OMODA", ["C5", "C7", "S5"]],
  ["JETOUR", ["Dashing", "X70 Plus", "T2", "T1"]],
  ["JAECOO", ["J7", "J8", "J6"]],
  ["EXEED", ["LX", "TXL", "RX", "VX", "EXLANTIX ET"]],
  ["TANK", ["TANK 300", "TANK 500", "TANK 400", "TANK 700"]],
  ["GAC", ["GS3", "GS8", "Empow", "M8", "S7"]],
  ["MOSKVICH", ["Москвич 3", "Москвич 3е", "Москвич 6", "Москвич 8"]],
  ["SOLARIS", ["HC", "HS", "KRS", "KRX"]],
  ["UAZ", ["Patriot", "Pickup", "Hunter", "Profi"]],
  ["VOYAH", ["Free", "Free+", "Dream", "Passion"]],
  ["HONGQI", ["HS5", "H5", "HS3", "H9"]],
  ["LI AUTO / LIXIANG", ["L6", "L7", "L8", "L9"]],
  ["EVOLUTE", ["i-SPACE"]],
  ["LYNK & CO", ["900"]],
  ["BMW", ["X3", "X5", "X6", "3 Series", "5 Series"]]
];

const USED_VEHICLES = [
  ["TOYOTA", ["Corolla", "Camry", "RAV4", "Land Cruiser Prado", "Land Cruiser 200/300"]],
  ["KIA", ["Rio", "Sportage", "Ceed", "Cerato", "Sorento"]],
  ["HYUNDAI", ["Solaris", "Creta", "Tucson", "Santa Fe", "Elantra"]],
  ["NISSAN", ["Qashqai", "X-Trail", "Almera", "Terrano", "Teana"]],
  ["VOLKSWAGEN", ["Polo", "Tiguan", "Passat", "Touareg", "Jetta"]],
  ["RENAULT", ["Duster", "Logan", "Sandero", "Kaptur", "Arkana"]],
  ["FORD", ["Focus", "Kuga", "Mondeo", "EcoSport", "Transit"]],
  ["SKODA", ["Rapid", "Octavia", "Kodiaq", "Karoq", "Superb"]],
  ["CHEVROLET", ["Niva", "Lacetti", "Cruze", "Aveo", "Cobalt"]],
  ["MITSUBISHI", ["Outlander", "Pajero Sport", "ASX", "Lancer"]],
  ["MAZDA", ["CX-5", "CX-50", "Mazda 6", "CX-9"]],
  ["HONDA", ["CR-V", "Civic", "Accord", "Fit"]],
  ["SUBARU", ["Forester", "Outback", "XV"]],
  ["LEXUS", ["RX", "NX", "LX", "ES"]],
  ["MERCEDES-BENZ", ["E-Class", "C-Class", "GLC", "GLE", "GLS"]]
];

const RUSSIA_CHINA_VEHICLE_ANCHORS = [
  ["JELAND", "J7", ["JAECOO J7", "探索06"], "JAECOO J7；中国对应探索06体系", ["探索06配件", "JAECOO J7配件", "探索06门槛条", "杰酷J7钥匙套"], ["4+4门槛", "钥匙壳", "防踢垫", "杯垫", "后备箱保护", "保护膜"], "极低", "S+ / #1"],
  ["JELAND", "J6", ["JAECOO J5", "杰酷J5", "T13J", "T1X"], "俄罗斯 J6 对应 JAECOO J5/5 体系，T1X平台", ["JAECOO J5配件", "杰酷J5配件", "T13J配件"], ["钥匙壳", "门槛条", "后备箱保护", "防踢垫", "门角保护"], "低，已有早期卖家", "S / #2"],
  ["JELAND", "C5", ["OMODA C5", "欧萌达C5"], "OMODA C5 本地化版本", ["OMODA C5配件", "欧萌达C5配件"], ["钥匙壳", "4+4门槛", "杯垫", "储物垫", "防踢垫"], "极低", "S / 提前布局"],
  ["JELAND", "J8", ["JAECOO J8", "杰酷J8", "瑞虎9"], "JAECOO J8 本地化版本；瑞虎9只用于交叉核对", ["JAECOO J8配件", "杰酷J8配件", "瑞虎9配件"], ["高端钥匙壳", "钥匙礼盒", "304门槛", "防踢垫", "后备箱保护"], "极低", "A+"],
  ["JELAND", "C7", ["OMODA C7", "欧萌达C7"], "OMODA C7体系", ["OMODA C7配件", "欧萌达C7配件"], ["门槛", "保护膜", "钥匙类", "内饰防护", "后备箱保护"], "极低", "A"],
  ["VOLGA", "K40", ["GEELY ATLAS", "博越L", "BOYUE L"], "Geely Atlas；国内对应博越L/Boyue L", ["博越L配件", "博越L门槛条", "博越L钥匙套"], ["4+4门槛", "钥匙壳", "防踢垫", "后备箱垫", "杯垫", "保护膜"], "极低", "S / #3"],
  ["VOLGA", "K50", ["GEELY MONJARO", "星越L", "XINGYUE L"], "Geely Monjaro；国内对应星越L/Xingyue L", ["星越L配件", "星越L钥匙套", "星越L门槛条"], ["高端钥匙壳", "304门槛", "防踢垫", "后备箱保护", "收纳"], "极低", "S- / #4"],
  ["VOLGA", "C50", ["GEELY PREFACE", "星瑞", "XINGRUI"], "Geely Preface；国内对应星瑞/Xingrui", ["吉利星瑞配件", "星瑞门槛条", "星瑞钥匙套"], ["钥匙", "门槛", "内饰保护膜", "杯垫"], "极低", "B+"],
  ["ESTEO", "MX", ["EXEED TX", "EXEED TXL", "星途凌云"], "Exeed TX/TXL/凌云系演进的 MX 版本；不能默认老 TXL 专车件全部通用", ["星途凌云配件", "EXEED TXL配件", "EXEED MX配件"], ["高端钥匙壳", "门槛", "后备箱保护", "防踢垫", "保护膜"], "极低", "A"],
  ["ESTEO", "V27", ["ICAR V27", "ICAUR V27", "奇瑞ICAR V27"], "iCAR / iCAUR V27", ["iCAR V27配件", "奇瑞iCAR V27配件"], ["充电线收纳包", "后备箱收纳", "高端钥匙壳", "门槛", "防踢垫"], "极低", "A+ 精品线"],
  ["ESTEO", "EXLANTIX ET8", ["奇瑞风云T11", "风云T11", "EXLANTIX ET8"], "中国原型奇瑞风云 T11", ["风云T11配件", "EXLANTIX ET8配件"], ["充电收纳", "高端钥匙礼盒", "座椅保护", "后备箱收纳", "门槛"], "极低", "A- 精品线"],
  ["EXLANTIX", "ET", ["星纪元ET", "EXEED EXLANTIX ET"], "国内星纪元 ET 体系", ["星纪元ET配件"], ["新能源充电收纳", "高端内饰", "钥匙", "后备箱用品"], "低", "B"],
  ["EXLANTIX", "ES", ["星纪元ES", "EXEED EXLANTIX ES"], "国内星纪元 ES 体系", ["星纪元ES配件"], ["新能源充电收纳", "高端内饰", "钥匙", "后备箱用品"], "低", "B"]
];

const PRIORITY_BRANDS = new Set(["HAVAL", "TENET", "LADA", "CHERY", "GEELY", "BELGEE", "CHANGAN", "OMODA", "JETOUR", "JAECOO", "TOYOTA", "KIA", "HYUNDAI", "VOLKSWAGEN", "NISSAN"]);
const TOP_MODELS = new Set(["HAVAL JOLION", "TENET T7", "TENET T4L", "LADA GRANTA", "CHERY TIGGO 7 PRO MAX", "GEELY MONJARO", "BELGEE X50", "CHANGAN UNI-S / CS55 PLUS"]);
const HOT_NEW_ENERGY_MODELS = new Set([
  "VOYAH FREE",
  "VOYAH DREAM",
  "GEELY EX5 EM-I",
  "LI AUTO / LIXIANG L6",
  "LI AUTO / LIXIANG L7",
  "LI AUTO / LIXIANG L9",
  "GAC S7",
  "EXEED EXLANTIX ET",
  "EVOLUTE I-SPACE",
  "LYNK & CO 900"
]);
let schemaReady = false;

export async function aiVehicleCatalog() {
  await ensureVehicleCatalogSchema();
  const rows = await mysqlQuery(`
    SELECT id, brand_name, model_name, tags_json, aliases_json, supply_anchor, search_keywords_json,
      recommended_products_json, ozon_competition, user_priority, source
    FROM ai_vehicle_catalog
    WHERE enabled = 1
    ORDER BY brand_name, CASE WHEN model_name = '' THEN 0 ELSE 1 END, model_name
  `);
  const brands = new Map();
  for (const row of rows) {
    const brandZh = VEHICLE_BRAND_ZH[row.brand_name] || "";
    const brand = brands.get(row.brand_name) || {
      name: row.brand_name,
      nameZh: brandZh,
      label: [brandZh, row.brand_name].filter(Boolean).join(" "),
      tags: [],
      models: [],
      source: row.source
    };
    const tags = parseTags(row.tags_json);
    brand.tags = unique([...brand.tags, ...tags]);
    if (row.model_name) {
      const aliases = parseJsonArray(row.aliases_json);
      brand.models.push({
        id: row.id,
        name: row.model_name,
        fullName: `${row.brand_name} ${row.model_name}`.trim(),
        label: aliases.length ? `${row.model_name}（${aliases.join(" / ")}）` : row.model_name,
        aliases,
        supplyAnchor: row.supply_anchor || "",
        searchKeywords: parseJsonArray(row.search_keywords_json),
        recommendedProducts: parseJsonArray(row.recommended_products_json),
        ozonCompetition: row.ozon_competition || "",
        priority: row.user_priority || "",
        tags,
        source: row.source
      });
    }
    brands.set(row.brand_name, brand);
  }
  return { tags: TAGS, brands: [...brands.values()] };
}

export async function addAiVehicleCatalogEntry(body = {}, session = {}) {
  await ensureVehicleCatalogSchema();
  const brand = cleanName(body.brand || body.brandName).toUpperCase();
  const model = cleanName(body.model || body.modelName);
  const tags = unique((Array.isArray(body.tags) ? body.tags : []).map(String).filter((tag) => TAGS.some((item) => item.key === tag)));
  if (!brand) throw statusError("汽车品牌不能为空", 400);
  if (!isLatinVehicleBrand(brand)) throw statusError("汽车品牌必须使用俄罗斯市场可识别的英文名称，不能填写中文或俄文字母", 400);
  const result = await mysqlExecute(`
    INSERT INTO ai_vehicle_catalog
      (brand_key, brand_name, model_key, model_name, tags_json, source, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, 'user', ?)
    ON DUPLICATE KEY UPDATE
      brand_name = VALUES(brand_name),
      model_name = VALUES(model_name),
      tags_json = VALUES(tags_json),
      enabled = 1,
      updated_at = CURRENT_TIMESTAMP
  `, [keyOf(brand), brand, model ? keyOf(model) : "__brand__", model, JSON.stringify(tags), personId(session)]);
  return { ok: true, id: Number(result.insertId || 0), brand, model, tags };
}

async function ensureVehicleCatalogSchema() {
  if (schemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ai_vehicle_catalog (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      brand_key VARCHAR(128) NOT NULL,
      brand_name VARCHAR(128) NOT NULL,
      model_key VARCHAR(191) NOT NULL,
      model_name VARCHAR(191) NOT NULL DEFAULT '',
      tags_json JSON NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'builtin',
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_by_person_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ai_vehicle_catalog_brand_model (brand_key, model_key),
      KEY idx_ai_vehicle_catalog_brand (brand_name),
      KEY idx_ai_vehicle_catalog_source (source, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureCatalogMetadataColumns();
  for (const [baseTag, groups] of [["hot_new", NEW_VEHICLES], ["hot_used", USED_VEHICLES]]) {
    for (const [brand, models] of groups) {
      const brandTags = unique(["hot_all", baseTag, PRIORITY_BRANDS.has(brand) ? "priority_brand" : ""].filter(Boolean));
      await seedRow(brand, "", brandTags);
      for (const model of models) {
        const fullName = `${brand} ${model}`.toUpperCase();
        const modelTags = unique([
          ...brandTags,
          TOP_MODELS.has(fullName) ? "top_priority_model" : "",
          HOT_NEW_ENERGY_MODELS.has(fullName) ? "hot_new_energy" : ""
        ].filter(Boolean));
        await seedRow(brand, model, modelTags);
      }
    }
  }
  for (const [brand, model, aliases, supplyAnchor, searchKeywords, recommendedProducts, competition, priority] of RUSSIA_CHINA_VEHICLE_ANCHORS) {
    const priorityTags = /^S/i.test(priority) ? ["top_priority_model"] : [];
    await seedRow(brand, "", ["hot_all", "hot_new", "priority_brand"]);
    await seedAnchoredRow(brand, model, ["hot_all", "hot_new", "priority_brand", ...priorityTags], {
      aliases, supplyAnchor, searchKeywords, recommendedProducts, competition, priority
    });
  }
  schemaReady = true;
}

async function ensureCatalogMetadataColumns() {
  const columns = [
    ["aliases_json", "JSON NULL"],
    ["supply_anchor", "VARCHAR(500) NOT NULL DEFAULT ''"],
    ["search_keywords_json", "JSON NULL"],
    ["recommended_products_json", "JSON NULL"],
    ["ozon_competition", "VARCHAR(128) NOT NULL DEFAULT ''"],
    ["user_priority", "VARCHAR(128) NOT NULL DEFAULT ''"]
  ];
  for (const [column, definition] of columns) {
    const rows = await mysqlQuery(`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_vehicle_catalog' AND COLUMN_NAME = ? LIMIT 1`, [column]);
    if (!rows.length) await mysqlExecute(`ALTER TABLE ai_vehicle_catalog ADD COLUMN ${column} ${definition}`);
  }
}

async function seedAnchoredRow(brand, model, tags, metadata) {
  await mysqlExecute(`
    INSERT INTO ai_vehicle_catalog
      (brand_key, brand_name, model_key, model_name, tags_json, aliases_json, supply_anchor,
       search_keywords_json, recommended_products_json, ozon_competition, user_priority, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'builtin')
    ON DUPLICATE KEY UPDATE
      tags_json = IF(source = 'builtin', VALUES(tags_json), tags_json),
      aliases_json = VALUES(aliases_json), supply_anchor = VALUES(supply_anchor),
      search_keywords_json = VALUES(search_keywords_json), recommended_products_json = VALUES(recommended_products_json),
      ozon_competition = VALUES(ozon_competition), user_priority = VALUES(user_priority), updated_at = CURRENT_TIMESTAMP
  `, [keyOf(brand), brand, keyOf(model), model, JSON.stringify(tags), JSON.stringify(metadata.aliases), metadata.supplyAnchor,
    JSON.stringify(metadata.searchKeywords), JSON.stringify(metadata.recommendedProducts), metadata.competition, metadata.priority]);
}

async function seedRow(brand, model, tags) {
  await mysqlExecute(`
    INSERT INTO ai_vehicle_catalog
      (brand_key, brand_name, model_key, model_name, tags_json, source)
    VALUES (?, ?, ?, ?, ?, 'builtin')
    ON DUPLICATE KEY UPDATE
      tags_json = IF(source = 'builtin', VALUES(tags_json), tags_json),
      updated_at = CURRENT_TIMESTAMP
  `, [keyOf(brand), brand, model ? keyOf(model) : "__brand__", model, JSON.stringify(tags)]);
}

function parseTags(value) {
  try { return unique(Array.isArray(value) ? value : JSON.parse(value || "[]")); } catch { return []; }
}

function parseJsonArray(value) {
  try { return unique(Array.isArray(value) ? value : JSON.parse(value || "[]")); } catch { return []; }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 191);
}

function isLatinVehicleBrand(value) {
  return /[A-Z]/.test(value) && /^[A-Z0-9][A-Z0-9 &/().+'-]*$/.test(value);
}

function keyOf(value) {
  return cleanName(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

function personId(session) {
  const id = Number(session?.personId || session?.person_id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

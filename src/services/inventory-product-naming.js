import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";

let schemaReady = false;
let productCoreNameSchemaReady = false;
let schemaReadyPromise = null;
let productCoreNameSchemaReadyPromise = null;
const CORE_PRODUCT_NAME_MAX_LENGTH = 7;

function isNamingMaintainer(session = {}) {
  return String(session?.name || "").trim() === "核动力牛马";
}

function validateCoreProductName(value) {
  const text = clean(value, 255);
  if (!text) throw new Error("核心品名不能为空");
  if (Array.from(text).length > CORE_PRODUCT_NAME_MAX_LENGTH) {
    throw new Error(`核心品名最多 ${CORE_PRODUCT_NAME_MAX_LENGTH} 个字，请缩短后再保存`);
  }
  return text;
}

export async function inventoryProductNamingOptions(query = {}) {
  await ensureSchema();
  await ensureProductCoreNameSchema();
  const type = String(query.type || "").trim();
  const search = String(query.q || query.query || "").trim().toLowerCase();
  const category = clean(query.category, 255);
  const brand = clean(query.brand, 255).replace("|", " ").trim();
  const fitmentType = query.fitment_type === "specific" ? "specific" : (query.fitment_type === "universal" ? "universal" : "");
  const vehicleModel = clean(query.vehicle_model, 255);

  const fieldByType = {
    category: "inventory_category",
    brand: "vehicle_brand",
    vehicle_model: "vehicle_model",
    accessory: "accessory_name",
    color: "color",
    material: "material",
    process: "surface_process",
    quantity: "product_quantity"
  };
  const productField = fieldByType[type];
  if (productField) {
    if (type === "vehicle_model" && !brand) return { rows: [] };
    if (type === "accessory" && !category) {
      return { rows: [] };
    }
    const where = ["active = 1", `${productField} IS NOT NULL`, `TRIM(CAST(${productField} AS CHAR)) <> ''`];
    const params = [];
    if (category && type !== "category") {
      where.push("inventory_category = ?");
      params.push(category);
    }
    if (brand && !["category", "brand", "accessory"].includes(type)) {
      where.push("vehicle_brand = ?");
      params.push(brand);
    }
    if (fitmentType && ["vehicle_model", "color", "material", "process", "quantity"].includes(type)) {
      where.push("fitment_type = ?");
      params.push(fitmentType);
    }
    if (vehicleModel && ["color", "quantity"].includes(type)) {
      where.push("vehicle_model = ?");
      params.push(vehicleModel);
    }
    if (type === "accessory" && search) {
      where.push("LOWER(accessory_name) LIKE ?");
      params.push(`%${search}%`);
    }
    const actualRows = await mysqlQuery(`
      SELECT CAST(${productField} AS CHAR) AS raw_value, COUNT(*) AS usage_count, MAX(updated_at) AS last_used_at
      FROM products
      WHERE ${where.join(" AND ")}
      GROUP BY ${productField}
      ORDER BY usage_count DESC, last_used_at DESC, raw_value ASC
      LIMIT 120
    `, params);
    const rows = actualRows.flatMap((row, index) => {
      const rawText = String(row.raw_value || "");
      const rawValues = type === "color"
        ? rawText.split(/[，,/]+/u)
        : type === "material"
          ? rawText.split(/[，,/、]+/u)
          : [rawText];
      return rawValues.map((rawValue, colorIndex) => {
        const text = rawValue.trim();
        if (!text) return null;
        let value = text;
        let label = text;
        if (type === "brand") {
          const parts = text.split(/\s+/).filter(Boolean);
          const en = parts.filter((part) => /^[\x20-\x7E]+$/.test(part)).join(" ");
          const zh = parts.filter((part) => !/^[\x20-\x7E]+$/.test(part)).join(" ");
          value = `${zh}|${en}`;
          label = [zh, en].filter(Boolean).join(" ") || "无品牌";
        }
        return {
          id: `actual-${type}-${index}-${colorIndex}`,
          option_type: type,
          value,
          label,
          status: "active",
          usage_count: Number(row.usage_count || 0),
          linked_product_count: Number(row.usage_count || 0),
          last_used_at: row.last_used_at
        };
      }).filter(Boolean);
    });
    const dictionaryRows = await mysqlQuery(`
      SELECT o.id, o.option_type, o.value, o.label, o.status, o.usage_count, o.updated_at AS last_used_at
      FROM inventory_product_naming_options o
      WHERE o.option_type = ? AND o.status = 'active'
        AND (? <> 'accessory' OR NOT EXISTS (
          SELECT 1 FROM inventory_product_naming_option_scopes scope_any WHERE scope_any.option_id = o.id
        ) OR EXISTS (
          SELECT 1 FROM inventory_product_naming_option_scopes scope_match
          WHERE scope_match.option_id = o.id AND scope_match.scope_type = 'category' AND scope_match.scope_value = ?
        ))
      ORDER BY o.usage_count DESC, o.label ASC
      LIMIT 120
    `, [type, type, category]);
    const merged = new Map();
    for (const row of [...rows, ...dictionaryRows]) {
      const existing = merged.get(row.value);
      if (existing) {
        existing.usage_count = Math.max(Number(existing.usage_count || 0), Number(row.usage_count || 0));
        existing.linked_product_count = Math.max(Number(existing.linked_product_count || 0), Number(row.linked_product_count || 0));
        if (!existing.id || String(existing.id).startsWith("actual-")) existing.id = row.id || existing.id;
      } else {
        merged.set(row.value, { ...row, usage_count: Number(row.usage_count || 0) });
      }
    }
    return {
      rows: [...merged.values()]
        .filter((row) => !search || `${row.value} ${row.label}`.toLowerCase().includes(search))
        .sort((left, right) => right.usage_count - left.usage_count || String(left.label).localeCompare(String(right.label), "zh-CN"))
    };
  }
  const rows = await mysqlQuery(`
    SELECT o.id, o.option_type, o.value, o.label, o.status, o.usage_count,
      CASE WHEN o.option_type = 'category'
        THEN (SELECT COUNT(*) FROM products p WHERE p.active = 1 AND p.inventory_category = o.value)
        ELSE o.usage_count END AS linked_product_count
    FROM inventory_product_naming_options o
    WHERE (? = '' OR o.option_type = ?)
      AND (? = '' OR LOWER(CONCAT(o.value, ' ', o.label)) LIKE ?)
      AND o.status <> 'archived'
    ORDER BY linked_product_count DESC, o.status = 'active' DESC, o.label ASC
    LIMIT 120
  `, [type, type, search, `%${search}%`]);
  return { rows };
}

export async function createInventoryProductNamingOption(body = {}, session = {}) {
  await ensureSchema();
  const optionType = String(body.option_type || "").trim();
  const value = optionType === "category" ? validateCoreProductName(body.value) : clean(body.value, 255);
  const label = clean(body.label || value, 255);
  if (!['category', 'accessory', 'color', 'material', 'process', 'quantity'].includes(optionType)) throw new Error('该选项不允许快速新增');
  if (optionType !== 'category' && !isNamingMaintainer(session)) throw new Error('仅核动力牛马可以维护款式、材质、工艺和颜色选项');
  if (!value) throw new Error('选项内容不能为空');
  if (optionType === 'quantity' && !/^\d+$/.test(value)) throw new Error('数量只能使用阿拉伯数字');
  const status = isNamingMaintainer(session) ? 'active' : 'pending';
  await mysqlExecute(`
    INSERT INTO inventory_product_naming_options
      (option_type, value, label, status, created_by_person_id)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE label = VALUES(label), updated_at = CURRENT_TIMESTAMP
  `, [optionType, value, label, status, Number(session?.personId || 0) || null]);
  return { ok: true, option_type: optionType, value, label, status };
}

export async function updateInventoryProductNamingOption(id, body = {}, session = {}) {
  await ensureSchema();
  await ensureProductCoreNameSchema();
  if (!isNamingMaintainer(session)) throw new Error("仅核动力牛马可以审核或修改核心品名");
  const optionId = Number(id);
  const nextValue = validateCoreProductName(body.value || body.label);
  if (!optionId) throw new Error("核心品名不存在");

  return withMysqlTransaction(async (connection) => {
    const [options] = await connection.query(`
      SELECT id, option_type, value, label
      FROM inventory_product_naming_options
      WHERE id = ? AND status <> 'archived'
      FOR UPDATE
    `, [optionId]);
    const option = options[0];
    if (!option) throw new Error("核心品名不存在或已删除");
    if (option.option_type !== "category") throw new Error("当前只支持维护核心品名");

    const [duplicates] = await connection.query(`
      SELECT id
      FROM inventory_product_naming_options
      WHERE option_type = 'category' AND value = ? AND id <> ? AND status <> 'archived'
      LIMIT 1
    `, [nextValue, optionId]);
    if (duplicates.length) throw new Error(`核心品名“${nextValue}”已存在`);

    const [products] = await connection.query(`
      SELECT id, vehicle_brand, vehicle_model, fitment_type, accessory_name, color,
        product_quantity, stock_unit, package_mode, package_contents, included_accessories, gift_contents
      FROM products
      WHERE active = 1 AND inventory_category = ?
      FOR UPDATE
    `, [option.value]);

    await connection.execute(`
      UPDATE inventory_product_naming_options
      SET value = ?, label = ?, status = 'active', reviewed_by_person_id = ?, reviewed_at = CURRENT_TIMESTAMP,
        review_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [nextValue, nextValue, Number(session?.personId || 0) || null, clean(body.review_note || body.reviewNote, 500), optionId]);

    for (const product of products) {
      await connection.execute(`
        UPDATE products
        SET inventory_category = ?, name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [nextValue, buildProductName(product, nextValue), product.id]);
    }

    return { ok: true, id: optionId, value: nextValue, label: nextValue, affected_products: products.length };
  });
}

export async function deleteInventoryProductNamingOption(id, session = {}) {
  await ensureSchema();
  await ensureProductCoreNameSchema();
  if (!isNamingMaintainer(session)) throw new Error("仅核动力牛马可以停用核心品名");
  const optionId = Number(id);
  if (!optionId) throw new Error("核心品名不存在");
  const rows = await mysqlQuery(`
    SELECT o.id, o.option_type, o.value,
      (SELECT COUNT(*) FROM products p WHERE p.active = 1 AND p.inventory_category = o.value) AS linked_product_count
    FROM inventory_product_naming_options o
    WHERE o.id = ? AND o.status <> 'archived'
    LIMIT 1
  `, [optionId]);
  const option = rows[0];
  if (!option) throw new Error("核心品名不存在或已删除");
  if (option.option_type !== "category") throw new Error("当前只支持维护核心品名");
  if (Number(option.linked_product_count || 0) > 0) {
    throw new Error(`核心品名“${option.value}”已绑定 ${option.linked_product_count} 个商品，请先编辑合并，不能直接删除`);
  }
  await mysqlExecute(`
    UPDATE inventory_product_naming_options
    SET status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [optionId]);
  return { ok: true, id: optionId, value: option.value };
}

export async function recordInventoryProductNamingUsage(entries = []) {
  await ensureSchema();
  for (const entry of entries) {
    const optionType = clean(entry?.option_type, 32);
    const value = clean(entry?.value, 255);
    const label = clean(entry?.label || value, 255);
    if (!optionType || !value) continue;
    await mysqlExecute(`
      INSERT INTO inventory_product_naming_options (option_type, value, label, status, usage_count)
      VALUES (?, ?, ?, 'active', 1)
      ON DUPLICATE KEY UPDATE usage_count = usage_count + 1, updated_at = CURRENT_TIMESTAMP
    `, [optionType, value, label]);
  }
}

async function initializeSchema() {
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS inventory_product_naming_options (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      option_type VARCHAR(32) NOT NULL,
      value VARCHAR(255) NOT NULL,
      label VARCHAR(255) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      usage_count INT NOT NULL DEFAULT 0,
      created_by_person_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_inventory_product_naming_option (option_type, value),
      KEY idx_inventory_product_naming_option_search (option_type, status, label)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  try { await mysqlExecute("ALTER TABLE inventory_product_naming_options ADD COLUMN usage_count INT NOT NULL DEFAULT 0"); } catch (error) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
  for (const sql of [
    "ALTER TABLE inventory_product_naming_options ADD COLUMN reviewed_by_person_id BIGINT UNSIGNED NULL",
    "ALTER TABLE inventory_product_naming_options ADD COLUMN reviewed_at DATETIME NULL",
    "ALTER TABLE inventory_product_naming_options ADD COLUMN review_note VARCHAR(500) NOT NULL DEFAULT ''"
  ]) {
    try { await mysqlExecute(sql); } catch (error) { if (error?.code !== 'ER_DUP_FIELDNAME') throw error; }
  }
  await mysqlExecute(`CREATE TABLE IF NOT EXISTS inventory_product_naming_option_scopes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    option_id BIGINT UNSIGNED NOT NULL,
    scope_type VARCHAR(32) NOT NULL DEFAULT 'category',
    scope_value VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_inventory_naming_scope (option_id, scope_type, scope_value),
    KEY idx_inventory_naming_scope_lookup (scope_type, scope_value, option_id),
    CONSTRAINT fk_inventory_naming_scope_option FOREIGN KEY (option_id) REFERENCES inventory_product_naming_options(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  for (const [optionType, value, label] of [
    ['category', '汽车内饰', '汽车内饰'], ['category', '汽车外饰', '汽车外饰'],
    ['category', '电子电器', '电子电器'], ['category', '养护工具', '养护工具'], ['category', '车载收纳', '车载收纳'],
    ['category', '车灯配件', '车灯配件'], ['category', '清洁用品', '清洁用品'], ['category', '安全应急', '安全应急'],
    ['color', '黑色', '黑色'], ['color', '白色', '白色'], ['color', '红色', '红色'],
    ['color', '灰色', '灰色'], ['color', '银色', '银色'], ['color', '透明', '透明'], ['color', '蓝色', '蓝色'],
    ['color', '绿色', '绿色'], ['color', '黄色', '黄色'], ['color', '橙色', '橙色'], ['color', '棕色', '棕色'],
    ['color', '米色', '米色'], ['color', '金色', '金色'], ['color', '玫瑰金', '玫瑰金'], ['color', '碳纤纹', '碳纤纹'],
    ['accessory', '普通款', '普通款'], ['accessory', 'LOGO定制款', 'LOGO定制款'], ['accessory', '无LOGO款', '无LOGO款'],
    ['accessory', '升级款', '升级款'], ['accessory', '加厚款', '加厚款'], ['accessory', '经典款', '经典款'],
    ['material', '不锈钢', '不锈钢'], ['material', 'ABS塑料', 'ABS塑料'], ['material', 'PET塑料', 'PET塑料'],
    ['material', 'TPU', 'TPU'], ['material', 'TPE', 'TPE'], ['material', 'PVC', 'PVC'], ['material', '硅胶', '硅胶'],
    ['material', '铝合金', '铝合金'], ['material', '锌合金', '锌合金'], ['material', '碳钢', '碳钢'],
    ['material', '真皮', '真皮'], ['material', 'PU皮革', 'PU皮革'], ['material', '超纤皮', '超纤皮'],
    ['material', '橡胶', '橡胶'], ['material', '亚克力', '亚克力'], ['material', '玻璃', '玻璃'],
    ['material', '木质', '木质'], ['material', '无纺布', '无纺布'], ['material', '涤纶', '涤纶'],
    ['process', '亮面', '亮面'], ['process', '磨砂', '磨砂'], ['process', '拉丝', '拉丝'], ['process', '激光', '激光'],
    ['process', '电镀', '电镀'], ['process', '喷砂', '喷砂'], ['process', '喷涂', '喷涂'], ['process', '烤漆', '烤漆'],
    ['process', '丝印', '丝印'], ['process', '移印', '移印'], ['process', '热转印', '热转印'], ['process', '水转印', '水转印'],
    ['process', '压纹', '压纹'], ['process', '冲压', '冲压'], ['process', '注塑', '注塑'], ['process', 'CNC加工', 'CNC加工'],
    ['brand', '无品牌|', '无品牌'], ['brand', '丰田|Toyota', '丰田 Toyota'], ['brand', '宝马|BMW', '宝马 BMW'],
    ['brand', '奔驰|Mercedes-Benz', '奔驰 Mercedes-Benz'], ['brand', '特耐|TENET', '特耐 TENET'], ['brand', '哈弗|HAVAL', '哈弗 HAVAL'],
    ['brand', '拉达|LADA', '拉达 LADA'], ['brand', '奇瑞|CHERY', '奇瑞 CHERY'], ['brand', '大众|Volkswagen', '大众 Volkswagen'],
    ['brand', '起亚|KIA', '起亚 KIA'], ['brand', '现代|Hyundai', '现代 Hyundai'], ['brand', '日产|Nissan', '日产 Nissan'],
    ['brand', '本田|Honda', '本田 Honda'], ['brand', '马自达|Mazda', '马自达 Mazda'], ['brand', '奥迪|Audi', '奥迪 Audi'],
    ['brand', '福特|Ford', '福特 Ford'], ['brand', '吉利|Geely', '吉利 Geely'], ['brand', '长安|Changan', '长安 Changan'],
    ['quantity', '1', '1'], ['quantity', '2', '2'], ['quantity', '3', '3'], ['quantity', '4', '4'], ['quantity', '5', '5'], ['quantity', '6', '6'], ['quantity', '8', '8'], ['quantity', '10', '10']
  ]) {
    await mysqlExecute(`
      INSERT INTO inventory_product_naming_options (option_type, value, label, status)
      VALUES (?, ?, ?, 'active') ON DUPLICATE KEY UPDATE label = VALUES(label)
    `, [optionType, value, label]);
  }
  schemaReady = true;
}

async function ensureSchema() {
  if (schemaReady) return;
  if (!schemaReadyPromise) {
    schemaReadyPromise = initializeSchema().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  await schemaReadyPromise;
}

async function initializeProductCoreNameSchema() {
  for (const sql of [
    "ALTER TABLE products ADD COLUMN inventory_category VARCHAR(255) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN fitment_type VARCHAR(16) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN accessory_name VARCHAR(255) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN package_mode VARCHAR(16) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN package_contents VARCHAR(500) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN included_accessories VARCHAR(500) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN gift_contents VARCHAR(500) NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN product_quantity INT NOT NULL DEFAULT 0"
    ,"ALTER TABLE products ADD COLUMN surface_process VARCHAR(255) NOT NULL DEFAULT ''"
    ,"ALTER TABLE products ADD COLUMN vehicle_models_json JSON NULL"
  ]) {
    try {
      await mysqlExecute(sql);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    }
  }
  productCoreNameSchemaReady = true;
}

async function ensureProductCoreNameSchema() {
  if (productCoreNameSchemaReady) return;
  if (!productCoreNameSchemaReadyPromise) {
    productCoreNameSchemaReadyPromise = initializeProductCoreNameSchema().catch((error) => {
      productCoreNameSchemaReadyPromise = null;
      throw error;
    });
  }
  await productCoreNameSchemaReadyPromise;
}

function buildProductName(product, coreName) {
  const vehicleBrand = clean(product.vehicle_brand, 255).replace(/^无品牌$/u, "");
  const fitment = vehicleBrand
    ? [vehicleBrand, clean(product.vehicle_model, 255)].filter(Boolean).join(" ")
    : "通用";
  const quantity = Math.max(1, Number(product.product_quantity || 1));
  const stockUnit = clean(product.stock_unit || "个", 32);
  const included = clean(product.included_accessories, 500);
  const gift = clean(product.gift_contents, 500);
  const setSuffix = product.package_mode === "set"
    ? (/礼盒/u.test(`${product.package_contents || ""} ${included} ${gift}`) ? "礼盒套装" : "套装")
    : "";
  return [
    coreName,
    fitment,
    clean(product.color, 255).replace(/,/g, "/"),
    clean(product.accessory_name || "普通款", 255),
    clean(product.material, 255),
    clean(product.surface_process, 255),
    `${quantity}${stockUnit}`,
    setSuffix
  ].filter(Boolean).join(" ");
}

function clean(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

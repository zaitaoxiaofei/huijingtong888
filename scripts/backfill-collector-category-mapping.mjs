import { createMysqlConnection, closeMysqlConnection } from "./mysql-runtime.mjs";
import { closeMysqlPool } from "../src/mysql-pool.js";
import { repairListingTemplateMapping } from "../src/services/listing-automation.js";

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== "");
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function productTypeDictionaryValueId(raw = {}) {
  const attrs = normalizeArray(raw.attributes || raw.attribute_values || raw.characteristics || []);
  const attr = attrs.find((item) => Number(item?.attribute_id || item?.id || 0) === 8229);
  const value = normalizeArray(attr?.values || attr?.value || attr?.attribute_values)[0] || {};
  return Number(value.dictionary_value_id || value.id || value.value_id || 0);
}

async function findCategory(conn, raw = {}, currentCategoryName = "") {
  const typeId = productTypeDictionaryValueId(raw);
  if (typeId) {
    const [rows] = await conn.execute(`
      SELECT *
      FROM ozon_category_mappings
      WHERE type_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `, [typeId]);
    if (rows[0]) return { ...rows[0], source: "attribute_8229_dictionary_value" };
  }

  const text = String(currentCategoryName || raw.category || raw.category_name || raw.categoryName || raw.category3 || "").trim();
  const leaf = text.split("/").map((item) => item.trim()).filter(Boolean).at(-1) || "";
  if (leaf || text) {
    const like = `%${leaf || text}%`;
    const [rows] = await conn.execute(`
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
    `, [leaf, text, leaf, text, like, like, leaf, text, like]);
    if (rows[0]) return { ...rows[0], source: "category_name" };
  }

  return null;
}

function categoryName(row = {}) {
  return String(row.path_zh || row.name_zh || row.path_ru || row.name_ru || "").trim();
}

const apply = process.env.COLLECTOR_CATEGORY_BACKFILL_APPLY === "1";
const conn = await createMysqlConnection();
const repairedTemplates = [];
const results = [];

try {
  const [rows] = await conn.execute(`
    SELECT *
    FROM ozon_plugin_collected_products
    WHERE status <> 'deleted'
    ORDER BY updated_at DESC
  `);

  for (const item of rows) {
    const raw = parseJson(item.payload_json, {});
    const edit = parseJson(item.edit_payload_json, {});
    const category = await findCategory(conn, raw, item.category_name || edit.category_name);
    if (!category) {
      results.push({ sku: item.sku, action: "skip", reason: "category_not_resolved", template: item.listing_template_id || "" });
      continue;
    }

    const nextCategoryName = categoryName(category);
    const nextDesc = String(category.description_category_id || "");
    const nextType = String(category.type_id || "");
    const currentDesc = String(edit.description_category_id || raw.description_category_id || "");
    const currentType = String(edit.type_id || raw.type_id || "");
    const needsUpdate = String(item.category_name || "") !== nextCategoryName
      || String(edit.category_name || "") !== nextCategoryName
      || currentDesc !== nextDesc
      || currentType !== nextType;

    if (!needsUpdate) {
      results.push({ sku: item.sku, action: "ok", category: nextCategoryName, template: item.listing_template_id || "" });
      continue;
    }

    const nextEdit = {
      ...edit,
      category_name: nextCategoryName,
      category_id: `${nextDesc}:${nextType}`,
      ozon_category_id: `${nextDesc}:${nextType}`,
      description_category_id: nextDesc,
      type_id: nextType,
      category_resolved_from: category.source
    };

    if (apply) {
      await conn.execute(`
        UPDATE ozon_plugin_collected_products
        SET category_name = ?,
            edit_payload_json = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND sku = ?
      `, [nextCategoryName, JSON.stringify(nextEdit), item.tenant_id || "admin", item.sku]);
      if (item.listing_template_id) {
        const repaired = await repairListingTemplateMapping(Number(item.listing_template_id), { auto_sync: false, apply: true }).catch((error) => ({ error: error.message }));
        repairedTemplates.push({ template: item.listing_template_id, sku: item.sku, applied: Boolean(repaired.applied), error: repaired.error || "" });
      }
    }
    results.push({ sku: item.sku, action: apply ? "updated" : "preview", category: nextCategoryName, from: `${currentDesc}:${currentType}`, to: `${nextDesc}:${nextType}`, template: item.listing_template_id || "" });
  }

  console.table(results);
  if (repairedTemplates.length) {
    console.log("\nRepaired linked templates");
    console.table(repairedTemplates);
  }
} finally {
  await closeMysqlConnection(conn);
  await closeMysqlPool();
}

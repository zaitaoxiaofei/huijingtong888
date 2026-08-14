import fs from "node:fs/promises";
import path from "node:path";
import { mysqlQuery, closeMysqlPool } from "../src/mysql-pool.js";

const outputDir = path.resolve(process.argv[2] || ".deploy-artifacts/inventory-standardization-sync");

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? String(parsed) : "0";
}

function jsonSql(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return sql(typeof value === "string" ? value : JSON.stringify(value));
}

const products = await mysqlQuery(`
  SELECT p.code, p.name, p.inventory_category, p.vehicle_brand, p.fitment_type,
    p.vehicle_model, p.vehicle_models_json, p.accessory_name, p.color, p.material,
    p.surface_process, p.product_quantity, p.stock_unit, p.package_mode,
    p.package_contents, p.is_accessory
  FROM products p
  LEFT JOIN (SELECT product_id, COUNT(*) sku_count FROM sku_mappings WHERE active = 1 GROUP BY product_id) sm ON sm.product_id = p.id
  LEFT JOIN (SELECT product_id, COUNT(*) component_count FROM product_components GROUP BY product_id) pc ON pc.product_id = p.id
  LEFT JOIN (SELECT component_product_id, COUNT(*) parent_count FROM product_components GROUP BY component_product_id) used_as ON used_as.component_product_id = p.id
  LEFT JOIN (
    SELECT product_id, SUM(quantity_delta) local_stock
    FROM inventory_movements
    WHERE status = 'posted' AND COALESCE(NULLIF(stock_location, ''), 'LOCAL') <> 'FBP'
    GROUP BY product_id
  ) stock ON stock.product_id = p.id
  WHERE p.active = 1 AND COALESCE(NULLIF(TRIM(p.code), ''), '') <> ''
    AND (p.product_type IN ('main', 'inventory') OR COALESCE(sm.sku_count, 0) > 0
      OR COALESCE(pc.component_count, 0) > 0 OR COALESCE(used_as.parent_count, 0) > 0
      OR COALESCE(stock.local_stock, 0) <> 0)
  ORDER BY p.code
`);

const duplicateCodes = products.filter((row, index) => index > 0 && row.code === products[index - 1].code).map((row) => row.code);
if (duplicateCodes.length) throw new Error(`本地库存编码重复，停止生成迁移：${duplicateCodes.join(", ")}`);

const aliases = await mysqlQuery(`
  SELECT p.code, a.alias_name, a.alias_type, a.active
  FROM product_name_aliases a
  JOIN products p ON p.id = a.product_id
  WHERE p.active = 1 AND a.active = 1
  ORDER BY p.code, a.alias_name
`);
const options = await mysqlQuery(`
  SELECT option_type, value, label, status, usage_count
  FROM inventory_product_naming_options
  WHERE status <> 'archived'
  ORDER BY option_type, value
`);
const scopes = await mysqlQuery(`
  SELECT o.option_type, o.value, s.scope_type, s.scope_value
  FROM inventory_product_naming_option_scopes s
  JOIN inventory_product_naming_options o ON o.id = s.option_id
  WHERE o.status <> 'archived'
  ORDER BY o.option_type, o.value, s.scope_type, s.scope_value
`);

const lines = [
  "SET NAMES utf8mb4;",
  "SET SESSION sql_safe_updates = 0;",
  "CREATE TABLE IF NOT EXISTS product_name_aliases (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, product_id BIGINT UNSIGNED NOT NULL, alias_name VARCHAR(500) NOT NULL, alias_type VARCHAR(32) NOT NULL DEFAULT 'previous_name', active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uk_product_name_alias (product_id, alias_name), KEY idx_product_name_alias_search (product_id, active, alias_name(191)), CONSTRAINT fk_product_name_alias_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  "CREATE TABLE IF NOT EXISTS inventory_product_naming_options (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, option_type VARCHAR(32) NOT NULL, value VARCHAR(255) NOT NULL, label VARCHAR(255) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'active', usage_count INT NOT NULL DEFAULT 0, created_by_person_id BIGINT UNSIGNED NULL, reviewed_by_person_id BIGINT UNSIGNED NULL, reviewed_at DATETIME NULL, review_note VARCHAR(500) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uk_inventory_naming_type_value (option_type, value), KEY idx_inventory_naming_type_status_usage (option_type, status, usage_count)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  "CREATE TABLE IF NOT EXISTS inventory_product_naming_option_scopes (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, option_id BIGINT UNSIGNED NOT NULL, scope_type VARCHAR(32) NOT NULL, scope_value VARCHAR(255) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uk_inventory_naming_scope (option_id, scope_type, scope_value), KEY idx_inventory_naming_scope_lookup (scope_type, scope_value, option_id), CONSTRAINT fk_inventory_naming_scope_option FOREIGN KEY (option_id) REFERENCES inventory_product_naming_options(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  "DROP TEMPORARY TABLE IF EXISTS inventory_standardization_stage;",
  "CREATE TEMPORARY TABLE inventory_standardization_stage (code VARCHAR(128) NOT NULL PRIMARY KEY, name VARCHAR(500) NOT NULL, inventory_category VARCHAR(255) NOT NULL, vehicle_brand VARCHAR(255) NOT NULL, fitment_type VARCHAR(16) NOT NULL, vehicle_model VARCHAR(255) NOT NULL, vehicle_models_json JSON NULL, accessory_name VARCHAR(255) NOT NULL, color VARCHAR(255) NULL, material VARCHAR(255) NULL, surface_process VARCHAR(255) NOT NULL, product_quantity INT NOT NULL, stock_unit VARCHAR(32) NOT NULL, package_mode VARCHAR(16) NOT NULL, package_contents VARCHAR(500) NOT NULL, is_accessory TINYINT(1) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
  "DROP TEMPORARY TABLE IF EXISTS inventory_alias_stage;",
  "CREATE TEMPORARY TABLE inventory_alias_stage (code VARCHAR(128) NOT NULL, alias_name VARCHAR(500) NOT NULL, alias_type VARCHAR(32) NOT NULL, active TINYINT(1) NOT NULL, PRIMARY KEY (code, alias_name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;"
];

for (let offset = 0; offset < products.length; offset += 100) {
  const values = products.slice(offset, offset + 100).map((row) => `(${[
    sql(row.code), sql(row.name), sql(row.inventory_category || ""), sql(row.vehicle_brand || ""), sql(row.fitment_type || ""),
    sql(row.vehicle_model || ""), jsonSql(row.vehicle_models_json), sql(row.accessory_name || ""), sql(row.color), sql(row.material),
    sql(row.surface_process || ""), number(row.product_quantity), sql(row.stock_unit || "个"), sql(row.package_mode || ""),
    sql(row.package_contents || ""), number(row.is_accessory)
  ].join(",")})`);
  lines.push(`INSERT INTO inventory_standardization_stage VALUES\n${values.join(",\n")};`);
}

lines.push(
  `SELECT 'stage_products' AS metric, COUNT(*) AS value FROM inventory_standardization_stage;`,
  `SELECT 'matched_products' AS metric, COUNT(*) AS value FROM inventory_standardization_stage s JOIN products p ON p.code=s.code AND p.active=1;`,
  `SELECT 'missing_products' AS metric, COUNT(*) AS value FROM inventory_standardization_stage s LEFT JOIN products p ON p.code=s.code AND p.active=1 WHERE p.id IS NULL;`,
  "START TRANSACTION;",
  `UPDATE products p JOIN inventory_standardization_stage s ON s.code=p.code AND p.active=1 SET p.name=s.name, p.inventory_category=s.inventory_category, p.vehicle_brand=s.vehicle_brand, p.fitment_type=s.fitment_type, p.vehicle_model=s.vehicle_model, p.vehicle_models_json=s.vehicle_models_json, p.accessory_name=s.accessory_name, p.color=s.color, p.material=s.material, p.surface_process=s.surface_process, p.product_quantity=s.product_quantity, p.stock_unit=s.stock_unit, p.package_mode=s.package_mode, p.package_contents=s.package_contents, p.is_accessory=s.is_accessory;`,
  "SELECT 'updated_products' AS metric, ROW_COUNT() AS value;"
);

for (let offset = 0; offset < aliases.length; offset += 100) {
  const values = aliases.slice(offset, offset + 100).map((row) => `(${sql(row.code)},${sql(row.alias_name)},${sql(row.alias_type || "previous_name")},${number(row.active)})`);
  lines.push(`INSERT INTO inventory_alias_stage VALUES\n${values.join(",\n")};`);
}
lines.push("INSERT INTO product_name_aliases (product_id, alias_name, alias_type, active) SELECT p.id, a.alias_name, a.alias_type, a.active FROM inventory_alias_stage a JOIN products p ON p.code=a.code AND p.active=1 ON DUPLICATE KEY UPDATE alias_type=VALUES(alias_type), active=VALUES(active);");

for (const row of options) {
  lines.push(`INSERT INTO inventory_product_naming_options (option_type,value,label,status,usage_count) VALUES (${sql(row.option_type)},${sql(row.value)},${sql(row.label)},${sql(row.status)},${number(row.usage_count)}) ON DUPLICATE KEY UPDATE label=VALUES(label), status=VALUES(status), usage_count=GREATEST(usage_count,VALUES(usage_count));`);
}
for (const row of scopes) {
  lines.push(`INSERT IGNORE INTO inventory_product_naming_option_scopes (option_id,scope_type,scope_value) SELECT id,${sql(row.scope_type)},${sql(row.scope_value)} FROM inventory_product_naming_options WHERE option_type=${sql(row.option_type)} AND value=${sql(row.value)} LIMIT 1;`);
}
lines.push(
  "COMMIT;",
  "SELECT 'aliases' AS metric, COUNT(*) AS value FROM product_name_aliases;",
  "SELECT 'naming_options' AS metric, COUNT(*) AS value FROM inventory_product_naming_options WHERE status <> 'archived';",
  "SELECT 'naming_scopes' AS metric, COUNT(*) AS value FROM inventory_product_naming_option_scopes;"
);

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "inventory-standardization.sql"), `${lines.join("\n")}\n`, "utf8");
const auditValues = products.map((row) => `(${sql(row.code)},${sql(row.name)})`);
const auditLines = [
  "SET NAMES utf8mb4;",
  "DROP TEMPORARY TABLE IF EXISTS inventory_sync_audit;",
  "CREATE TEMPORARY TABLE inventory_sync_audit (code VARCHAR(128) NOT NULL PRIMARY KEY, expected_name VARCHAR(500) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;"
];
for (let offset = 0; offset < auditValues.length; offset += 100) {
  auditLines.push(`INSERT INTO inventory_sync_audit VALUES\n${auditValues.slice(offset, offset + 100).join(",\n")};`);
}
auditLines.push(
  "SELECT 'local_stage', COUNT(*) FROM inventory_sync_audit;",
  "SELECT 'ecs_matched', COUNT(*) FROM inventory_sync_audit s JOIN products p ON p.code=s.code AND p.active=1;",
  "SELECT 'name_already_equal', COUNT(*) FROM inventory_sync_audit s JOIN products p ON p.code=s.code AND p.active=1 WHERE p.name=s.expected_name;",
  "SELECT 'missing_code', s.code FROM inventory_sync_audit s LEFT JOIN products p ON p.code=s.code AND p.active=1 WHERE p.id IS NULL ORDER BY s.code;"
);
await fs.writeFile(path.join(outputDir, "audit.sql"), `${auditLines.join("\n")}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({ generated_at: new Date().toISOString(), products: products.length, aliases: aliases.length, options: options.length, scopes: scopes.length }, null, 2), "utf8");
await closeMysqlPool();
console.log(JSON.stringify({ outputDir, products: products.length, aliases: aliases.length, options: options.length, scopes: scopes.length }));

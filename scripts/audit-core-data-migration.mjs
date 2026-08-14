import { pathToFileURL } from "node:url";
import path from "node:path";
import { createMysqlConnection, closeMysqlConnection } from "./mysql-runtime.mjs";

export const CORE_MIGRATION_GROUPS = Object.freeze({
  identity: ["people", "shops", "settings", "system_settings", "shop_variant_rules"],
  products: [
    "products", "sku_mappings", "online_products", "product_components",
    "sku_inventory_recipes", "sku_inventory_recipe_items"
  ],
  orders: [
    "orders", "order_items", "ozon_orders_raw", "order_status_history", "order_marks",
    "order_label_prints", "order_item_procurement_marks", "outbound_records", "order_profit_items"
  ],
  inventory: ["inventory_movements", "inventory_current", "stock_warehouse_rules"],
  procurement: [
    "suppliers", "procurement_requests", "purchase_orders", "purchase_order_items", "inbound_records"
  ],
  listing: [
    "listing_drafts", "listing_media_assets", "listing_ai_variant_assets",
    "listing_variant_workbench_drafts", "listing_category_templates", "listing_shop_copies",
    "asset_variants", "asset_variant_jobs", "asset_tail_templates", "material_assets",
    "asset_vehicle_models", "media_migration_map"
  ]
});

export const CORE_MIGRATION_TABLES = Object.freeze(
  [...new Set(Object.values(CORE_MIGRATION_GROUPS).flat())]
);

async function tableMetadata(connection) {
  const [rows] = await connection.query(`
    SELECT table_name, column_name, column_type, is_nullable, column_key, extra, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
    ORDER BY table_name, ordinal_position
  `);
  const byTable = new Map();
  for (const row of rows) {
    const name = String(row.table_name || row.TABLE_NAME || "");
    if (!byTable.has(name)) byTable.set(name, []);
    byTable.get(name).push(row);
  }
  return byTable;
}

function schemaSignature(columns = []) {
  return columns.map((column) => [
    column.column_name || column.COLUMN_NAME,
    column.column_type || column.COLUMN_TYPE,
    column.is_nullable || column.IS_NULLABLE,
    column.column_key || column.COLUMN_KEY,
    column.extra || column.EXTRA
  ].join(":"));
}

export async function auditCoreDataMigration() {
  const connection = await createMysqlConnection({ multipleStatements: false });
  try {
    const metadata = await tableMetadata(connection);
    const groups = {};
    let totalRows = 0;
    for (const [groupName, tableNames] of Object.entries(CORE_MIGRATION_GROUPS)) {
      groups[groupName] = [];
      for (const tableName of tableNames) {
        const columns = metadata.get(tableName) || [];
        let rows = 0;
        if (columns.length) {
          const [countRows] = await connection.query(`SELECT COUNT(1) AS total FROM \`${tableName}\``);
          rows = Number(countRows[0]?.total || 0);
          totalRows += rows;
        }
        groups[groupName].push({
          table: tableName,
          exists: columns.length > 0,
          rows,
          columns: columns.length,
          schemaSignature: schemaSignature(columns)
        });
      }
    }
    const result = { totalTables: CORE_MIGRATION_TABLES.length, totalRows, groups };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeMysqlConnection(connection);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  auditCoreDataMigration().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

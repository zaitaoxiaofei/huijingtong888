import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const INDEXES = [
  ["orders", "idx_orders_shop_ordered_id", "(shop_id, ordered_at, id)"],
  ["order_items", "idx_order_items_order_mapping_sku", "(order_id, sku_mapping_id, ozon_sku)"]
];
const REQUIRED_UNIQUE_INDEX = ["orders", "uk_orders_shop_posting_number", "(shop_id, posting_number)"];
const LEGACY_GLOBAL_UNIQUE_INDEX = ["orders", "uk_orders_posting_number"];

async function inspect(query = mysqlQuery) {
  const orderTables = await query("SHOW TABLES LIKE 'orders'");
  if (!orderTables.length) return { exists: false, indexes: [], audit: null };
  const [shops, orders, items, profitItems, financeItems] = await Promise.all([
    query("SHOW COLUMNS FROM shops"), query("SHOW COLUMNS FROM orders"), query("SHOW COLUMNS FROM order_items"),
    query("SHOW COLUMNS FROM order_profit_items"), query("SHOW COLUMNS FROM ozon_finance_items")
  ]);
  const required = [["shops", shops, ["id", "tenant_id"]], ["orders", orders, ["id", "shop_id", "posting_number"]],
    ["order_items", items, ["id", "order_id", "sku_mapping_id"]], ["order_profit_items", profitItems, ["order_item_id"]],
    ["ozon_finance_items", financeItems, ["shop_id", "posting_number"]]];
  const missing = required.flatMap(([table, columns, names]) => {
    const found = new Set(columns.map((column) => column.Field));
    return names.filter((name) => !found.has(name)).map((name) => `${table}.${name}`);
  });
  if (missing.length) throw new Error(`Order tenant audit requires fields: ${missing.join(", ")}`);
  const [[audit]] = await query(`
    SELECT
      (SELECT COUNT(*) FROM orders o LEFT JOIN shops s ON s.id=o.shop_id WHERE s.id IS NULL) AS orders_without_shop,
      (SELECT COUNT(*) FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL) AS items_without_order,
      (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN sku_mappings sm ON sm.id=oi.sku_mapping_id WHERE sm.shop_id != o.shop_id) AS mapping_shop_mismatches,
      (SELECT COUNT(*) FROM order_profit_items opi LEFT JOIN order_items oi ON oi.id=opi.order_item_id WHERE oi.id IS NULL) AS profit_rows_without_item,
      (SELECT COUNT(*) FROM ozon_finance_items fi LEFT JOIN shops s ON s.id=fi.shop_id WHERE s.id IS NULL) AS finance_rows_without_shop,
      (SELECT COUNT(*) FROM ozon_finance_items fi
       WHERE EXISTS (SELECT 1 FROM orders other_shop_order WHERE other_shop_order.posting_number=fi.posting_number AND other_shop_order.shop_id != fi.shop_id)
         AND NOT EXISTS (SELECT 1 FROM orders own_shop_order WHERE own_shop_order.posting_number=fi.posting_number AND own_shop_order.shop_id=fi.shop_id)) AS finance_posting_shop_mismatches,
      (SELECT COUNT(*) FROM (SELECT shop_id, posting_number FROM orders GROUP BY shop_id, posting_number HAVING COUNT(*) > 1) duplicate_orders) AS duplicate_shop_posting_groups
  `);
  const indexes = [];
  for (const table of new Set([...INDEXES.map(([name]) => name), REQUIRED_UNIQUE_INDEX[0]])) {
    const rows = await query(`SHOW INDEX FROM ${table}`);
    indexes.push(...rows.map((row) => ({ table, name: row.Key_name, column: row.Column_name, sequence: Number(row.Seq_in_index || 0), nonUnique: row.Non_unique == null ? 1 : Number(row.Non_unique) })));
  }
  return { exists: true, audit: Object.fromEntries(Object.entries(audit).map(([key, value]) => [key, Number(value || 0)])), indexes };
}

function assertClean(result) {
  const issues = Object.entries(result.audit || {}).filter(([, count]) => count > 0);
  if (issues.length) throw new Error(`Order ownership audit failed: ${issues.map(([key, count]) => `${key}=${count}`).join(", ")}; no index changes applied`);
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket");
  if (!APPLY) {
    const before = await inspect();
    if (before.exists) assertClean(before);
    console.log(JSON.stringify({ ok: true, mode: "dry-run", changes_database: false,
      ownership_model: "orders inherit ownership through orders.shop_id -> shops.tenant_id; no redundant tenant column or data backfill", before }));
    return;
  }
  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_orders_indexes_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Tenant orders migration lock unavailable");
    const query = async (sql) => (await admin.query(sql))[0];
    const before = await inspect(query);
    if (before.exists) {
      assertClean(before);
      for (const [table, name, definition] of INDEXES) {
        if (!before.indexes.some((item) => item.table === table && item.name === name)) await admin.query(`ALTER TABLE ${table} ADD KEY ${name} ${definition}`);
      }
      const [uniqueTable, uniqueName, uniqueDefinition] = REQUIRED_UNIQUE_INDEX;
      if (!before.indexes.some((item) => item.table === uniqueTable && item.name === uniqueName)) {
        await admin.query(`ALTER TABLE ${uniqueTable} ADD UNIQUE KEY ${uniqueName} ${uniqueDefinition}`);
      }
      const uniqueIndex = await inspect(query);
      const uniqueColumns = uniqueIndex.indexes.filter((item) => item.table === uniqueTable && item.name === uniqueName)
        .sort((a, b) => a.sequence - b.sequence).map((item) => item.column);
      if (uniqueColumns.join(",") !== "shop_id,posting_number"
        || uniqueIndex.indexes.find((item) => item.table === uniqueTable && item.name === uniqueName)?.nonUnique !== 0) {
        throw new Error("Shop-scoped order uniqueness verification failed; legacy global key remains in place");
      }
      if (uniqueIndex.indexes.some((item) => item.table === LEGACY_GLOBAL_UNIQUE_INDEX[0] && item.name === LEGACY_GLOBAL_UNIQUE_INDEX[1])) {
        await admin.query(`ALTER TABLE ${LEGACY_GLOBAL_UNIQUE_INDEX[0]} DROP INDEX ${LEGACY_GLOBAL_UNIQUE_INDEX[1]}`);
      }
      const after = await inspect(query);
      assertClean(after);
      if (INDEXES.some(([table, name]) => !after.indexes.some((item) => item.table === table && item.name === name))) throw new Error("Order query index verification failed");
      const finalUniqueColumns = after.indexes.filter((item) => item.table === uniqueTable && item.name === uniqueName)
        .sort((a, b) => a.sequence - b.sequence).map((item) => item.column);
      if (finalUniqueColumns.join(",") !== "shop_id,posting_number"
        || after.indexes.some((item) => item.table === LEGACY_GLOBAL_UNIQUE_INDEX[0] && item.name === LEGACY_GLOBAL_UNIQUE_INDEX[1])) {
        throw new Error("Shop-scoped order uniqueness migration verification failed");
      }
      await admin.query("SELECT RELEASE_LOCK('tenant_orders_indexes_v1')");
      console.log(JSON.stringify({ ok: true, mode: "apply", ownership_backfill: false, legacy_global_order_key_removed: true, audit: after.audit, indexes: [...INDEXES.map(([table, name]) => ({ table, name })), { table: uniqueTable, name: uniqueName }] }));
    } else {
      await admin.query("SELECT RELEASE_LOCK('tenant_orders_indexes_v1')");
      console.log(JSON.stringify({ ok: true, mode: "apply", message: "Orders schema absent; no changes made." }));
    }
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_orders_indexes_v1')"); } catch {}
    throw error;
  } finally { await admin.end(); }
}

try { await run(); } finally { await closeMysqlPool(); }

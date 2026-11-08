// Keep the legacy-source overlap check inside every finance transaction. This
// expression indexes only its lookup key; it does not cache an authorization or
// change the definition of legacy records, including NULL operation dates.
export const LEGACY_FINANCE_DAY_SQL = "CASE WHEN LEFT(operation_id,15)<>'accrual_by_day:' THEN CAST(operation_date AS DATE) ELSE NULL END";
export const OPERATIONAL_QUERY_INDEXES = [
  { table: "ozon_finance_items", name: "idx_finance_shop_legacy_day", parts: ["shop_id", "legacy_operation_date"] },
  { table: "online_products", name: "idx_online_products_shop_ozon_product", parts: ["shop_id", "ozon_product_id"] }
];
const normalize = value => String(value || "").toLowerCase().replace(/_utf8mb4/g, "").replace(/[\\\s`()]/g, "");

export async function inspectOperationalQueryIndexes(connection) {
  const indexes = [];
  for (const definition of OPERATIONAL_QUERY_INDEXES) {
    const [tables] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [definition.table]);
    const [rows] = tables.length ? await connection.query(`SHOW INDEX FROM ${definition.table} WHERE Key_name=?`, [definition.name]) : [[]];
    rows.sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
    const valid = rows.length === definition.parts.length && rows.every((row, i) =>
      normalize(row.Expression || row.Column_name) === normalize(definition.parts[i])
      && Number(row.Non_unique) === 1 && row.Sub_part == null && row.Visible !== "NO" && row.Index_type === "BTREE");
    indexes.push({ table: definition.table, name: definition.name, exists: !!tables.length, present: !!rows.length, valid });
  }
  const [columns] = await connection.query("SELECT DATA_TYPE,EXTRA,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ozon_finance_items' AND COLUMN_NAME='legacy_operation_date'");
  const column = columns[0];
  const finance_column = { exists: indexes[0].exists, present: !!column, valid: !!column && column.DATA_TYPE === "date"
    && column.EXTRA === "VIRTUAL GENERATED" && normalize(column.GENERATION_EXPRESSION) === normalize(LEGACY_FINANCE_DAY_SQL) };
  return { ready: indexes.every(index => !index.exists || index.valid) && (!finance_column.exists || finance_column.valid), indexes, finance_column };
}

export async function ensureOperationalQueryIndexes(connection) {
  const before = await inspectOperationalQueryIndexes(connection);
  if (before.indexes.some(index => index.present && !index.valid) || (before.finance_column.present && !before.finance_column.valid)) throw Error("Existing operational query index has an incompatible definition");
  // Separate online DDL is required: MySQL cannot add a virtual column and its
  // index in the same LOCK=NONE ALTER. Neither statement changes ledger values.
  if (before.finance_column.exists && !before.finance_column.present) await connection.query(`ALTER TABLE ozon_finance_items
    ADD COLUMN legacy_operation_date DATE GENERATED ALWAYS AS (${LEGACY_FINANCE_DAY_SQL}) VIRTUAL, ALGORITHM=INPLACE, LOCK=NONE`);
  for (const index of before.indexes.filter(index => index.exists && !index.present)) {
    const definition = OPERATIONAL_QUERY_INDEXES.find(item => item.name === index.name);
    await connection.query(`ALTER TABLE ${definition.table} ADD INDEX ${definition.name} (${definition.parts.join(", ")}), ALGORITHM=INPLACE, LOCK=NONE`);
  }
  const after = await inspectOperationalQueryIndexes(connection);
  if (!after.ready) throw Error("Operational query indexes did not become ready");
  return { before, after };
}

export const ORDER_SEARCH_INDEX = {
  table: "orders", name: "idx_orders_shop_order_number_id", columns: ["shop_id", "order_number", "id"]
};

export async function inspectOrderSearchIndex(connection) {
  const [tables] = await connection.query("SHOW TABLES LIKE 'orders'");
  if (!tables.length) return { exists: false, present: false, valid: false };
  const [rows] = await connection.query("SHOW INDEX FROM orders WHERE Key_name = ?", [ORDER_SEARCH_INDEX.name]);
  const ordered = rows.sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
  const valid = ordered.length === ORDER_SEARCH_INDEX.columns.length
    && ordered.every((row, index) => row.Column_name === ORDER_SEARCH_INDEX.columns[index]
      && Number(row.Non_unique) === 1 && row.Sub_part == null
      && String(row.Index_type).toUpperCase() === "BTREE" && row.Visible !== "NO");
  return { exists: true, present: !!ordered.length, valid, columns: ordered.map(row => row.Column_name) };
}

export async function ensureOrderSearchIndex(connection) {
  const before = await inspectOrderSearchIndex(connection);
  if (!before.exists) return { changed: false, before, after: before };
  if (before.present && !before.valid) throw new Error("Existing order search index has an unexpected definition; no changes applied");
  if (!before.present) await connection.query(`ALTER TABLE orders ADD INDEX ${ORDER_SEARCH_INDEX.name}
    (${ORDER_SEARCH_INDEX.columns.join(", ")}), ALGORITHM=INPLACE, LOCK=NONE`);
  const after = await inspectOrderSearchIndex(connection);
  if (!after.valid) throw new Error("Order search index verification failed");
  return { changed: !before.present, before, after };
}

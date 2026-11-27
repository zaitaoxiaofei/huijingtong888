const ONLINE_COLUMNS = [
  'shop_id', 'ozon_sku', 'offer_id', 'ozon_product_id', 'name', 'image_url', 'primary_image', 'sale_price',
  'currency_code', 'marketing_price', 'old_price', 'status', 'visibility', 'archived', 'is_discounted',
  'images_json', 'barcodes_json', 'stocks_json', 'commissions_json', 'attributes_json', 'raw_json',
  'published_at', 'ozon_updated_at'
];
const ONLINE_TEXT_COLUMNS = new Set(['image_url', 'primary_image', 'images_json', 'barcodes_json', 'stocks_json',
  'commissions_json', 'attributes_json', 'raw_json']);
const STOCK_COLUMNS = ['shop_id', 'online_product_id', 'product_id', 'ozon_product_id', 'ozon_sku', 'offer_id',
  'warehouse_id', 'warehouse_name', 'stock_type', 'present', 'reserved', 'available', 'free_stock_count',
  'paid_stock_count', 'expiring_stock_count', 'waitingdocs_stock_count', 'paid_storage_start_at', 'stock_days',
  'average_daily_sales', 'stock_level', 'raw_json'];

// Omitting unchanged TEXT assignments lets NOBLOB row images omit their bodies.
// An IF(...) assignment of the old value still marks the TEXT column as written.
async function writeObservedSyncRow({ transaction, payload, beforeWrite }, { table, columns, keys, textColumns, timestamps }) {
  if (!Array.isArray(payload) || payload.length !== columns.length) throw new Error(`Invalid ${table} sync payload`);
  // Check before borrowing a connection. The check after the row lock uses the
  // transaction's first consistent read, so RR cannot reuse pre-wait authority.
  await beforeWrite?.();
  return transaction(async connection => {
    // This no-op duplicate clause takes the unique row's exclusive lock, also
    // covering concurrent first inserts without a pre-read/gap-lock race.
    await connection.execute(`INSERT INTO ${table} (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE id = id`, payload);
    const keyWhere = keys.map(index => `${columns[index]} = ?`).join(' AND ');
    const keyValues = keys.map(index => payload[index]);
    const [rows] = await connection.execute(`SELECT id, ${[...textColumns].join(', ')} FROM ${table}
      WHERE ${keyWhere} FOR UPDATE`, keyValues);
    const current = rows[0];
    if (!current) throw new Error(`${table} sync row disappeared while locked`);
    await beforeWrite?.(connection);
    const changed = columns.map((column, index) => ({ column, value: payload[index] }))
      .filter(({ column, value }, index) => !keys.includes(index) && (!textColumns.has(column) || current[column] !== value));
    await connection.execute(`UPDATE ${table} SET ${[
      ...changed.map(({ column }) => `${column} = ?`), ...timestamps.map(column => `${column} = CURRENT_TIMESTAMP`)
    ].join(', ')} WHERE id = ? AND ${keyWhere}`,
    [...changed.map(({ value }) => value), current.id, ...keyValues]);
  });
}

export function writeOnlineProductSync(options) {
  return writeObservedSyncRow(options, { table: 'online_products', columns: ONLINE_COLUMNS, keys: [0, 1],
    textColumns: ONLINE_TEXT_COLUMNS, timestamps: ['synced_at', 'updated_at'] });
}

export function writeStockSnapshotSync(options) {
  return writeObservedSyncRow(options, { table: 'ozon_stock_snapshots', columns: STOCK_COLUMNS, keys: [0, 4, 6, 8],
    textColumns: new Set(['raw_json']), timestamps: ['synced_at'] });
}

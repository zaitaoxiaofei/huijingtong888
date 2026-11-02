// Mirrors the existing procurement reader, including explicit schema fallback.
// An indexed virtual value is maintained by MySQL in the source write transaction.
export const PROCUREMENT_LOCATION_COLUMN = 'query_procurement_location';
export const PROCUREMENT_LOCATION_INDEX = 'idx_order_procurement_location';
export function procurementLocationSql(raw = 'raw_json', warehouse = 'query_stock_location') {
  return `CASE WHEN UPPER(COALESCE(${warehouse},'')) IN ('FBP','FBO','OGR') THEN 'FBP'
    WHEN (CASE WHEN JSON_VALID(${raw}) THEN UPPER(COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${raw},'$.fulfillment_schema')),
      JSON_UNQUOTE(JSON_EXTRACT(${raw},'$.raw.fulfillment_schema')),'')) ELSE '' END) IN ('FBP','FBO','OGR') THEN 'FBP'
    ELSE 'LOCAL' END`;
}
const normalizedExpression = value => String(value || '').toLowerCase()
  .replace(/\\+'/g, "'").replace(/_utf8mb4|_utf8mb3|_utf8|_ascii|_binary/g, '').replace(/[`()\s]/g, '');
export async function inspectProcurementQueryFacts(connection) {
  const [tables] = await connection.query("SHOW TABLES LIKE 'ozon_orders_raw'");
  if (!tables.length) return { exists: false, ready: false, compatible: true, column_present: false, index_present: false };
  const [columns] = await connection.query(`SELECT COLUMN_TYPE, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ozon_orders_raw' AND COLUMN_NAME=?`, [PROCUREMENT_LOCATION_COLUMN]);
  const column = columns[0];
  const columnValid = !column || (String(column.COLUMN_TYPE).toLowerCase() === 'varchar(8)'
    && String(column.EXTRA).toUpperCase().includes('VIRTUAL GENERATED')
    && normalizedExpression(column.GENERATION_EXPRESSION) === normalizedExpression(procurementLocationSql()));
  const [indexes] = await connection.query('SHOW INDEX FROM ozon_orders_raw WHERE Key_name=?', [PROCUREMENT_LOCATION_INDEX]);
  const expected = ['store_id','posting_number',PROCUREMENT_LOCATION_COLUMN];
  const sorted = indexes.sort((a,b) => Number(a.Seq_in_index)-Number(b.Seq_in_index));
  const indexValid = !sorted.length || (sorted.length === expected.length && sorted.every((row,index) =>
    row.Column_name === expected[index] && Number(row.Non_unique) === 1 && row.Sub_part == null
    && String(row.Index_type).toUpperCase() === 'BTREE' && row.Visible !== 'NO'));
  return { exists: true, ready: Boolean(column && sorted.length && columnValid && indexValid),
    compatible: columnValid && indexValid, column_present: Boolean(column), index_present: Boolean(sorted.length) };
}
export async function ensureProcurementQueryFacts(connection) {
  const before = await inspectProcurementQueryFacts(connection);
  if (!before.exists) return { changed: false, before, after: before };
  if (!before.compatible) throw Error('Existing procurement query facts have an incompatible definition');
  if (!before.column_present) await connection.query(`ALTER TABLE ozon_orders_raw ADD COLUMN ${PROCUREMENT_LOCATION_COLUMN}
    VARCHAR(8) GENERATED ALWAYS AS (${procurementLocationSql()}) VIRTUAL, ALGORITHM=INPLACE, LOCK=NONE`);
  if (!before.index_present) await connection.query(`ALTER TABLE ozon_orders_raw ADD INDEX ${PROCUREMENT_LOCATION_INDEX}
    (store_id,posting_number,${PROCUREMENT_LOCATION_COLUMN}), ALGORITHM=INPLACE, LOCK=NONE`);
  const after = await inspectProcurementQueryFacts(connection);
  if (!after.ready) throw Error('Procurement query facts verification failed');
  return { changed: !before.ready, before, after };
}

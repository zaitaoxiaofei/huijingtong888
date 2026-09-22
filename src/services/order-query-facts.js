// Persist warehouse classification in the source row's write transaction.
// History remains live and is aggregated once, without cross-row write locks.
export const transportStatusesSql = "('delivering','delivered','posting_delivered','posting_in_transit')";

export function stockLocationSql(raw = 'NEW.raw_json') {
  const value = path => `JSON_UNQUOTE(JSON_EXTRACT(${raw}, '${path}'))`;
  const pairs = ['delivery_method.name', 'delivery_method.warehouse', 'analytics_data.warehouse', 'analytics_data.tpl_provider'];
  return `CASE WHEN JSON_VALID(${raw}) THEN CASE WHEN LOWER(CONCAT_WS(' ', ${pairs.map(path =>
    `COALESCE(${value(`$.raw.${path}`)}, ${value(`$.${path}`)})`).join(', ')}))
    REGEXP 'fbp|fbo|hunchun|hun chun|hch-pd|hch-cr|珲春|混春|混川' THEN 'FBP' ELSE 'LOCAL' END ELSE 'LOCAL' END`;
}

export function orderQueryFactTriggers() {
  return [
    ['order_query_raw_insert', `BEFORE INSERT ON ozon_orders_raw FOR EACH ROW
      SET NEW.query_stock_location = ${stockLocationSql()}`],
    ['order_query_raw_update', `BEFORE UPDATE ON ozon_orders_raw FOR EACH ROW
      BEGIN
        IF NOT (OLD.raw_json <=> NEW.raw_json) OR NEW.query_stock_location IS NULL THEN
          SET NEW.query_stock_location = ${stockLocationSql()};
        END IF;
      END`]
  ];
}

export async function initializeOrderQueryFacts(connection, { triggerDefiner = '' } = {}) {
  const [columns] = await connection.query("SHOW COLUMNS FROM ozon_orders_raw LIKE 'query_stock_location'");
  if (!columns.length) await connection.query('ALTER TABLE ozon_orders_raw ADD COLUMN query_stock_location VARCHAR(8) NULL');
  for (const [name, body] of orderQueryFactTriggers()) {
    const [existing] = await connection.query(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?`, [name]);
    if (!existing.length) await connection.query(`CREATE ${triggerDefiner ? `DEFINER = ${triggerDefiner} ` : ''}TRIGGER ${name} ${body}`);
  }
  await connection.query(`UPDATE ozon_orders_raw SET query_stock_location = ${stockLocationSql('raw_json')}
    WHERE query_stock_location IS NULL`);
  const [indexes] = await connection.query("SHOW INDEX FROM ozon_orders_raw WHERE Key_name = 'idx_order_query_stock_location'");
  if (!indexes.length) await connection.query(`ALTER TABLE ozon_orders_raw
    ADD INDEX idx_order_query_stock_location (store_id, posting_number, query_stock_location), ALGORITHM=INPLACE, LOCK=NONE`);
}

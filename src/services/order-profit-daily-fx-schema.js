// Explicit companion schema only. Importing this module never executes DDL.
export const ORDER_PROFIT_DAILY_FX_TABLE = "order_profit_daily_fx_rates";
export const ORDER_PROFIT_DAILY_FX_SCHEMA = `CREATE TABLE IF NOT EXISTS order_profit_daily_fx_rates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  business_date DATE NOT NULL,
  currency_from CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currency_to CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rate DECIMAL(24,12) NOT NULL,
  source VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_date DATE NOT NULL,
  source_nominal VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_value VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_url VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_profit_daily_fx (business_date,currency_from,currency_to,source),
  CONSTRAINT chk_order_profit_daily_fx_positive CHECK (rate > 0),
  CONSTRAINT chk_order_profit_daily_fx_date CHECK (source_date <= business_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export async function dailyFxQuery(db, statement, parameters = []) {
  const result = await db.query(statement, parameters);
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

export async function inspectOrderProfitDailyFxSchema(db) {
  const [table] = await dailyFxQuery(db, "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [ORDER_PROFIT_DAILY_FX_TABLE]);
  if (!table) return { available: false, compatible: false };
  const columns = await dailyFxQuery(db, "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [ORDER_PROFIT_DAILY_FX_TABLE]);
  const expected = [
    ["id", "bigint unsigned"], ["business_date", "date"], ["currency_from", "char(3)"],
    ["currency_to", "char(3)"], ["rate", "decimal(24,12)"], ["source", "varchar(32)"],
    ["source_date", "date"], ["source_nominal", "varchar(64)"], ["source_value", "varchar(64)"],
    ["source_url", "varchar(512)"], ["source_sha256", "char(64)"], ["fetched_at", "datetime(3)"], ["created_at", "datetime(3)"]
  ];
  const indexes = await dailyFxQuery(db, "SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX,SUB_PART,EXPRESSION,IS_VISIBLE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX", [ORDER_PROFIT_DAILY_FX_TABLE]);
  const unique = indexes.filter(row => row.INDEX_NAME === "uq_order_profit_daily_fx");
  const primary = indexes.filter(row => row.INDEX_NAME === "PRIMARY");
  const triggers = await dailyFxQuery(db, "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?", [ORDER_PROFIT_DAILY_FX_TABLE]);
  const checks = await dailyFxQuery(db, `SELECT c.CONSTRAINT_NAME,c.ENFORCED,k.CHECK_CLAUSE
    FROM information_schema.TABLE_CONSTRAINTS c JOIN information_schema.CHECK_CONSTRAINTS k
      ON k.CONSTRAINT_SCHEMA=c.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME=c.CONSTRAINT_NAME
    WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME=? AND c.CONSTRAINT_TYPE='CHECK'`, [ORDER_PROFIT_DAILY_FX_TABLE]);
  const clauses = checks.map(row => String(row.CHECK_CLAUSE).replace(/[\s\x60()]/g, "").toLowerCase()).sort();
  const compatible = table.ENGINE === "InnoDB" && columns.length === expected.length
    && columns.every((row, index) => row.COLUMN_NAME === expected[index][0] && row.COLUMN_TYPE.toLowerCase() === expected[index][1]
      && row.IS_NULLABLE === "NO" && !/(?:VIRTUAL|STORED) GENERATED|INVISIBLE|on update/i.test(row.EXTRA))
    && /auto_increment/i.test(columns[0].EXTRA) && primary.length === 1 && primary[0].COLUMN_NAME === "id"
    && String(columns.at(-1).COLUMN_DEFAULT).toLowerCase() === "current_timestamp(3)"
    && unique.length === 4 && unique.map(row => row.COLUMN_NAME).join(",") === "business_date,currency_from,currency_to,source"
    && unique.every(row => Number(row.NON_UNIQUE) === 0 && row.SUB_PART == null && row.EXPRESSION == null && row.IS_VISIBLE === "YES")
    && indexes.filter(row => Number(row.NON_UNIQUE) === 0).length === 5
    && checks.length === 2 && checks.every(row => row.ENFORCED === "YES")
    && clauses.join(",") === "rate>0,source_date<=business_date" && triggers.length === 0;
  return { available: true, compatible };
}

export async function assertOrderProfitDailyFxSchema(db) {
  const schema = await inspectOrderProfitDailyFxSchema(db);
  if (!schema.available || !schema.compatible) throw Object.assign(new Error("每日汇率档案结构尚未就绪，请先运行专用迁移；不能使用固定汇率代替"), { code: "ORDER_PROFIT_DAILY_FX_SCHEMA_PENDING", statusCode: 503 });
  return schema;
}

export async function createOrderProfitDailyFxSchema(db) {
  await db.query(ORDER_PROFIT_DAILY_FX_SCHEMA);
  return assertOrderProfitDailyFxSchema(db);
}

import { pathToFileURL } from "node:url";
import { ORDER_PROFIT_FX_POLICY_KEY, ORDER_PROFIT_FX_STATE_SCHEMA, getOrderProfitFxPolicy } from "../src/services/order-profit-fx-policy.js";
import { dailyFxQuery, inspectOrderProfitDailyFxSchema, assertOrderProfitDailyFxSchema } from "../src/services/order-profit-daily-fx-schema.js";

const refused = message => Object.assign(new Error(message), { code: "ORDER_PROFIT_FX_POLICY_MIGRATION_REFUSED", safe: true });

async function inspectState(db) {
  const [table] = await dailyFxQuery(db, "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_profit_fx_state'");
  if (!table) return { available: false, compatible: false };
  const columns = await dailyFxQuery(db, "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_profit_fx_state' ORDER BY ORDINAL_POSITION");
  const expected = [
    ["tenant_key", "varchar(128)", "NO"], ["order_id", "bigint unsigned", "NO"],
    ["ordered_business_date", "date", "NO"], ["signed_business_date", "date", "YES"],
    ["order_fx_id", "bigint unsigned", "YES"], ["signed_fx_id", "bigint unsigned", "YES"],
    ["signed_at", "datetime", "YES"], ["prices_json", "longtext", "NO"],
    ["state", "varchar(64)", "NO"], ["last_error_code", "varchar(128)", "YES"],
    ["created_at", "datetime", "NO"], ["updated_at", "datetime", "NO"]
  ];
  const indexes = await dailyFxQuery(db, "SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SUB_PART,EXPRESSION,IS_VISIBLE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_profit_fx_state' ORDER BY INDEX_NAME,SEQ_IN_INDEX");
  const primary = indexes.filter(row => row.INDEX_NAME === "PRIMARY"), order = indexes.filter(row => row.INDEX_NAME === "uk_order_profit_fx_order");
  const triggers = await dailyFxQuery(db, "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='order_profit_fx_state'");
  return { available: true, compatible: table.ENGINE === "InnoDB" && columns.length === expected.length
    && columns.every((row, index) => row.COLUMN_NAME === expected[index][0] && row.COLUMN_TYPE.toLowerCase() === expected[index][1]
      && row.IS_NULLABLE === expected[index][2] && !/(?:VIRTUAL|STORED) GENERATED|INVISIBLE/i.test(row.EXTRA))
    && primary.length === 2 && primary.map(row => row.COLUMN_NAME).join(",") === "tenant_key,order_id"
    && order.length === 1 && order[0].COLUMN_NAME === "order_id"
    && [...primary, ...order].every(row => Number(row.NON_UNIQUE) === 0 && row.SUB_PART == null && row.EXPRESSION == null && row.IS_VISIBLE === "YES")
    && indexes.filter(row => Number(row.NON_UNIQUE) === 0).length === 3 && !triggers.length };
}

async function activatePolicy(db) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await db.beginTransaction();
    try {
      const [existing] = await dailyFxQuery(db, "SELECT value_json FROM system_settings WHERE `key`=? FOR UPDATE", [ORDER_PROFIT_FX_POLICY_KEY]);
      if (!existing) {
        const [cutoff] = await dailyFxQuery(db, "SELECT COALESCE(MAX(id),0) legacy_max_order_id,DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') enabled_at FROM orders");
        const legacyMax = Number(cutoff.legacy_max_order_id);
        if (!Number.isSafeInteger(legacyMax) || legacyMax < 0) throw refused("订单编号边界超出支持范围，未启用每日汇率");
        const policy = { version: "V2", enabled_at: cutoff.enabled_at, legacy_max_order_id: legacyMax };
        await db.query("INSERT INTO system_settings (`key`,value_json,updated_at) VALUES(?,?,UTC_TIMESTAMP())", [ORDER_PROFIT_FX_POLICY_KEY, JSON.stringify(policy)]);
      }
      const policy = await getOrderProfitFxPolicy(db);
      if (!policy || Number(policy.legacy_max_order_id) < 0) throw refused("已有每日汇率启用记录无效，未覆盖原记录");
      await db.commit();
      return { policy, activated_now: !existing };
    } catch (error) {
      await db.rollback();
      if (attempt < 2 && ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_DUP_ENTRY"].includes(error.code)) continue;
      throw error;
    }
  }
}

// Schema and activation are separate explicit operations. This never selects
// an arbitrary old order for recalculation or changes an existing cutoff.
export async function migrateOrderProfitFxPolicy(db, { apply = false, activate = false } = {}) {
  if (activate && !apply) throw refused("--activate 必须与 --apply 一起显式指定");
  if (apply) await db.query(ORDER_PROFIT_FX_STATE_SCHEMA);
  const schema = await inspectState(db), dailyFxSchema = await inspectOrderProfitDailyFxSchema(db);
  if (schema.available && !schema.compatible) throw refused("订单冻结汇率伴表不兼容，未修改旧订单或旧利润");
  let policy = await getOrderProfitFxPolicy(db), activatedNow = false;
  if (activate) {
    if (!schema.compatible) throw refused("订单冻结汇率伴表尚未就绪");
    await assertOrderProfitDailyFxSchema(db);
    ({ policy, activated_now: activatedNow } = await activatePolicy(db));
  }
  return { mode: activate ? "activation_requested" : apply ? "schema_applied" : "read_only", schema, daily_fx_schema: dailyFxSchema,
    policy, activated_now: activatedNow, eligibility: "Only orders above the stored ID boundary and placed at/after enabled_at use V2",
    existing_order_profits_unchanged: true, old_exchange_rates_unchanged: true };
}

export async function runOrderProfitFxPolicyMigrationCli(args) {
  const options = new Map();
  for (const value of args) {
    const match = /^--(database|mysql-admin-socket|apply|activate)(?:=(.*))?$/.exec(value);
    if (!match || options.has(match[1]) || (["apply", "activate"].includes(match[1]) ? match[2] !== undefined : !match[2])) throw refused("Explicit --database= and --mysql-admin-socket= required; --apply/--activate must be bare");
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get("database"), socketPath = options.get("mysql-admin-socket");
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(database || "") || typeof socketPath !== "string"
    || !(socketPath.startsWith("/") || socketPath.startsWith("\\\\.\\pipe\\")) || (options.has("activate") && !options.has("apply"))) {
    throw refused("Explicit database/local administrator socket required; activation requires --apply");
  }
  const { default: mysql } = await import("mysql2/promise");
  const db = await mysql.createConnection({ socketPath, user: "root", database, timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  try {
    await db.query("SET SESSION time_zone='+00:00'");
    await db.query("SET SESSION max_execution_time=10000");
    await db.query("SET SESSION innodb_lock_wait_timeout=5");
    if (!options.has("apply")) await db.query("START TRANSACTION READ ONLY");
    const report = await migrateOrderProfitFxPolicy(db, { apply: options.has("apply"), activate: options.has("activate") });
    if (!options.has("apply")) await db.rollback();
    return report;
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOrderProfitFxPolicyMigrationCli(process.argv.slice(2)).then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || "ORDER_PROFIT_FX_POLICY_MIGRATION_REFUSED", error: error.safe ? error.message : "Daily FX policy migration refused; raw SQL and configuration intentionally omitted" }));
    process.exitCode = 1;
  });
}

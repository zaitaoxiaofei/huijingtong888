import { pathToFileURL } from "node:url";
import { createOrderProfitDailyFxSchema, inspectOrderProfitDailyFxSchema, dailyFxQuery } from "../src/services/order-profit-daily-fx-schema.js";

// Explicit administrator connection only. No app configuration or implicit
// activation, historical calculation, fetching, or writes to exchange_rates.
export async function migrateOrderProfitDailyFx(db, { apply = false } = {}) {
  if (apply) await createOrderProfitDailyFxSchema(db);
  const schema = await inspectOrderProfitDailyFxSchema(db);
  if (!schema.available) return { mode: "read_only", schema, archive_rows: 0 };
  if (!schema.compatible) throw Object.assign(new Error("每日汇率档案已有结构不兼容，停止迁移；未修改旧汇率和订单"), { safe: true });
  const [counts] = await dailyFxQuery(db, "SELECT COUNT(*) archive_rows,DATE_FORMAT(MIN(business_date),'%Y-%m-%d') first_business_date,DATE_FORMAT(MAX(business_date),'%Y-%m-%d') last_business_date FROM order_profit_daily_fx_rates");
  return { mode: apply ? "schema_applied" : "read_only", schema, ...counts, archive_rows: Number(counts.archive_rows), old_rates_unchanged: true, order_profits_unchanged: true };
}

export async function runOrderProfitDailyFxMigrationCli(args) {
  const options = new Map();
  for (const value of args) {
    const match = /^--(database|mysql-admin-socket|apply)(?:=(.*))?$/.exec(value);
    if (!match || options.has(match[1]) || (match[1] === "apply" ? match[2] !== undefined : !match[2])) throw Error("Explicit --database= and --mysql-admin-socket= required; --apply must be bare");
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get("database"), socketPath = options.get("mysql-admin-socket");
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(database || "") || typeof socketPath !== "string"
    || !(socketPath.startsWith("/") || socketPath.startsWith("\\\\.\\pipe\\"))) throw Error("Explicit database and local administrator socket required");
  const { default: mysql } = await import("mysql2/promise");
  const db = await mysql.createConnection({ socketPath, user: "root", database, timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  try {
    await db.query("SET SESSION time_zone='+00:00'");
    await db.query("SET SESSION max_execution_time=10000");
    if (!options.has("apply")) await db.query("START TRANSACTION READ ONLY");
    const report = await migrateOrderProfitDailyFx(db, { apply: options.has("apply") });
    if (!options.has("apply")) await db.rollback();
    return report;
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOrderProfitDailyFxMigrationCli(process.argv.slice(2)).then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || "ORDER_PROFIT_DAILY_FX_MIGRATION_REFUSED", error: error.safe ? error.message : "Daily FX migration refused; raw SQL and configuration intentionally omitted" }));
    process.exitCode = 1;
  });
}

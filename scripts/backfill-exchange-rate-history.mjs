import { pathToFileURL } from "node:url";
import { ensureExchangeRateHistory, readExchangeRateHistory } from "../src/services/exchange-rate-history.js";

export async function runExchangeRateHistoryCli(args) {
  const options = new Map();
  for (const value of args) {
    const match = /^--(database|mysql-admin-socket|from|to|apply)(?:=(.*))?$/.exec(value);
    if (!match || options.has(match[1]) || (match[1] === "apply" ? match[2] !== undefined : !match[2])) throw Error("Explicit database/socket/from/to required; --apply must be bare");
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get("database"), socketPath = options.get("mysql-admin-socket");
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(database || "") || typeof socketPath !== "string" || !(socketPath.startsWith("/") || socketPath.startsWith("\\\\.\\pipe\\"))
    || !/^\d{4}-\d{2}-\d{2}$/.test(options.get("from") || "") || !/^\d{4}-\d{2}-\d{2}$/.test(options.get("to") || "")) {
    throw Error("Explicit database/local administrator socket and Beijing date range required");
  }
  const { default: mysql } = await import("mysql2/promise");
  const db = await mysql.createConnection({ socketPath, user: "root", database, timezone: "Z", dateStrings: true });
  try {
    await db.query("SET SESSION time_zone='+00:00'");await db.query("SET SESSION max_execution_time=10000");
    const requested = { from: options.get("from"), to: options.get("to") };
    if (options.has("apply")) return { mode: "history_prepared", ...await ensureExchangeRateHistory(db, requested), existing_archives_unchanged: true, order_profits_unchanged: true };
    await db.query("START TRANSACTION READ ONLY");
    const result = await readExchangeRateHistory(db, requested);await db.rollback();
    return { mode: "read_only", from: result.from, to: result.to, days: result.days, available: result.rows.length,
      complete: result.complete, missing_dates: result.missing_dates, external_requests: 0, order_profits_unchanged: true };
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExchangeRateHistoryCli(process.argv.slice(2)).then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2))).catch(error => {
    console.error(JSON.stringify({ ok: false, code: error.code || "EXCHANGE_RATE_HISTORY_PREPARATION_REFUSED", error: error.code?.startsWith("EXCHANGE_RATE_HISTORY_") ? error.message : "History preparation refused; raw SQL and configuration intentionally omitted" }));
    process.exitCode = 1;
  });
}

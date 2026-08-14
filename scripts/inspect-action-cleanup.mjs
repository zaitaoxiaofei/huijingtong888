import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const rows = await mysqlQuery(
  "SELECT `key`, value_json, updated_at FROM system_settings WHERE `key` LIKE ? ORDER BY updated_at DESC",
  ["ozon.actions.cleanup:%"]
);
const result = rows.map((row) => {
  let value = {};
  try { value = JSON.parse(row.value_json || "{}"); } catch {}
  return {
    key: row.key,
    updatedAt: row.updated_at,
    enabled: value.enabled,
    lastRunAt: value.lastRunAt,
    lastError: value.lastError,
    actionIds: value.actionIds,
    knownActionIds: (value.knownActions || []).map((item) => item.actionId),
    lastResult: value.lastResult
  };
});
console.log(JSON.stringify(result, null, 2));
await closeMysqlPool();

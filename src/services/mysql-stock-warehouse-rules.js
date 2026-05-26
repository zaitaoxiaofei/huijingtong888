import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery } from "../mysql-pool.js";

function ensureMysqlStockWarehouseRulesEnabled() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL cutover routes are not enabled");
  }
}

function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new Error(message);
  return text;
}

async function mysqlQueryOne(sql, params = []) {
  const rows = await mysqlQuery(sql, params);
  return rows[0] || null;
}

export async function stockWarehouseRulesMysql() {
  ensureMysqlStockWarehouseRulesEnabled();
  return await mysqlQuery(`
    SELECT *
    FROM stock_warehouse_rules
    ORDER BY enabled DESC, priority ASC, id ASC
  `);
}

export async function createStockWarehouseRuleMysql(body = {}) {
  ensureMysqlStockWarehouseRulesEnabled();
  const pattern = requiredText(body.pattern, "Pattern is required");
  const stockType = String(body.stock_type || "unknown").trim() || "unknown";
  const priority = Number(body.priority || 100);
  const enabled = body.enabled === undefined ? 1 : Number(body.enabled ? 1 : 0);
  const note = String(body.note || "");

  await mysqlExecute(`
    INSERT INTO stock_warehouse_rules (pattern, stock_type, priority, enabled, note)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      stock_type = VALUES(stock_type),
      priority = VALUES(priority),
      enabled = VALUES(enabled),
      note = VALUES(note),
      updated_at = CURRENT_TIMESTAMP
  `, [pattern, stockType, priority, enabled, note]);

  const mysqlRow = await mysqlQueryOne("SELECT id FROM stock_warehouse_rules WHERE pattern = ?", [pattern]);
  return { ok: true, id: Number(mysqlRow.id), rules: await stockWarehouseRulesMysql() };
}

export async function updateStockWarehouseRuleMysql(id, body = {}) {
  ensureMysqlStockWarehouseRulesEnabled();
  const existing = await mysqlQueryOne("SELECT * FROM stock_warehouse_rules WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("Stock warehouse rule not found");

  const payload = [
    requiredText(body.pattern ?? existing.pattern, "Pattern is required"),
    String(body.stock_type ?? existing.stock_type ?? "unknown").trim() || "unknown",
    Number(body.priority ?? existing.priority),
    body.enabled === undefined ? Number(existing.enabled) : Number(body.enabled ? 1 : 0),
    body.note ?? existing.note,
    Number(id)
  ];

  await mysqlExecute(`
    UPDATE stock_warehouse_rules
    SET pattern = ?, stock_type = ?, priority = ?, enabled = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, payload);

  return { ok: true, rules: await stockWarehouseRulesMysql() };
}

export async function deleteStockWarehouseRuleMysql(id) {
  ensureMysqlStockWarehouseRulesEnabled();
  await mysqlExecute("UPDATE stock_warehouse_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(id)]);
  return { ok: true, rules: await stockWarehouseRulesMysql() };
}

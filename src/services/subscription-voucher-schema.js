// Additive sale-voucher storage. No existing tenant, person or entitlement is
// modified by this schema or by its explicit administrator migration.
export const SUBSCRIPTION_VOUCHER_SCHEMA = `CREATE TABLE IF NOT EXISTS tenant_subscription_vouchers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code_hash CHAR(64) NOT NULL,
  code_hint VARCHAR(12) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  plan_snapshot_json JSON NOT NULL,
  redeemable_until DATETIME NOT NULL,
  issued_by_person_id BIGINT UNSIGNED NOT NULL,
  used_by_person_id BIGINT UNSIGNED NULL,
  used_by_tenant_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  UNIQUE KEY uk_subscription_voucher_hash (code_hash),
  KEY idx_subscription_voucher_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export async function inspectSubscriptionVoucherSchema(query) {
  const exists = (await query("SHOW TABLES LIKE 'tenant_subscription_vouchers'")).length > 0;
  if (!exists) return { exists: false, ready: false, problems: ["table:tenant_subscription_vouchers"] };
  const columns = new Map((await query("SHOW FULL COLUMNS FROM tenant_subscription_vouchers")).map(row => [row.Field, row]));
  const indexes = await query("SHOW INDEX FROM tenant_subscription_vouchers");
  const [table] = await query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscription_vouchers'");
  const problems = [];
  if (table?.ENGINE !== "InnoDB") problems.push("engine:InnoDB");
  const types = { id: "bigint unsigned", code_hash: "char(64)", code_hint: "varchar(12)", status: "varchar(16)",
    plan_snapshot_json: "json", redeemable_until: "datetime", issued_by_person_id: "bigint unsigned",
    used_by_person_id: "bigint unsigned", used_by_tenant_id: "bigint unsigned", created_at: "datetime", used_at: "datetime", revoked_at: "datetime" };
  for (const [name, type] of Object.entries(types)) {
    const column = columns.get(name);
    const nullable = ["used_by_person_id", "used_by_tenant_id", "used_at", "revoked_at"].includes(name);
    if (!column || column.Type.toLowerCase().replace(/bigint\(\d+\)/, "bigint") !== type || column.Null !== (nullable ? "YES" : "NO")) problems.push(`column:${name}`);
  }
  if (!String(columns.get("id")?.Extra || "").includes("auto_increment")) problems.push("id:auto_increment");
  const expected = { PRIMARY: [true, "id"], uk_subscription_voucher_hash: [true, "code_hash"], idx_subscription_voucher_status: [false, "status,id"] };
  for (const [name, [unique, fields]] of Object.entries(expected)) {
    const rows = indexes.filter(row => row.Key_name === name).sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
    if (rows.map(row => row.Column_name).join(",") !== fields || rows.some(row => Number(row.Non_unique) !== Number(!unique) || row.Sub_part != null || row.Index_type !== "BTREE")) problems.push(`index:${name}`);
  }
  return { exists: true, ready: problems.length === 0, problems };
}

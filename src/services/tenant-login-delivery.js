import crypto from "node:crypto";
import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { getPlatformGrantMysql } from "./platform-grants.js";
import { verifyPassword } from "../auth-password.js";

export const TENANT_LOGIN_DELIVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS tenant_login_deliveries (
  tenant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  person_id BIGINT UNSIGNED NOT NULL,
  password_ciphertext TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tenant_login_person (person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

let schemaReady;
export async function ensureTenantLoginDeliverySchemaMysql() {
  if (!schemaReady) schemaReady = mysqlExecute(TENANT_LOGIN_DELIVERY_SCHEMA).catch(error => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
}

function encryptionKeys() {
  const seeds = [process.env.TENANT_LOGIN_ENCRYPTION_KEY, process.env.TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY,
    process.env.SELLER_ANALYTICS_AUTH_ENCRYPTION_KEY].map(value => String(value || "").trim()).filter(value => value.length >= 32);
  if (!seeds.length) throw Object.assign(new Error("服务器尚未配置稳定的企业登录信息加密密钥，请由平台维护人员配置 TENANT_LOGIN_ENCRYPTION_KEY 后再创建企业；也可沿用已配置的企业插件加密密钥"), { statusCode: 503 });
  return [...new Set(seeds)].map(seed => crypto.createHash("sha256").update(`tenant-login-delivery:${seed}`).digest());
}

export function encryptTenantLoginPassword(password, tenantId, personId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKeys()[0], iv);
  cipher.setAAD(Buffer.from(`${tenantId}:${personId}`));
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptTenantLoginPassword(payload, tenantId, personId) {
  const [version, iv, tag, encrypted] = String(payload || "").split(":");
  if (version === "v1" && iv && tag && encrypted) {
    for (const key of encryptionKeys()) {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
        decipher.setAAD(Buffer.from(`${tenantId}:${personId}`));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
      } catch { /* Try the configured fallback key. */ }
    }
  }
  throw Object.assign(new Error("企业登录信息无法解密，请确认服务器保留了保存时使用的加密密钥"), { statusCode: 503 });
}

export async function saveTenantLoginDelivery(connection, tenantId, personId, password) {
  await connection.execute(`INSERT INTO tenant_login_deliveries (tenant_id, person_id, password_ciphertext)
    VALUES (?, ?, ?)`, [tenantId, personId, encryptTenantLoginPassword(password, tenantId, personId)]);
}

// Only existing platform-delivered accounts participate; ordinary user accounts
// must not acquire a recoverable password as a side effect of changing it.
export async function refreshTenantLoginDeliveries(connection, personId, password) {
  const [rows] = await connection.execute("SELECT tenant_id FROM tenant_login_deliveries WHERE person_id = ? FOR UPDATE", [Number(personId)]);
  for (const row of rows) {
    await connection.execute("UPDATE tenant_login_deliveries SET password_ciphertext = ? WHERE tenant_id = ? AND person_id = ?",
      [encryptTenantLoginPassword(password, row.tenant_id, personId), Number(row.tenant_id), Number(personId)]);
  }
}

export async function readTenantLoginDeliveryMysql(tenantId, session) {
  if (session?.platform_role !== "super_admin" || !(await getPlatformGrantMysql(session.personId))) {
    throw Object.assign(new Error("仅平台超级管理员可以复制客户企业的登录信息"), { statusCode: 403 });
  }
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error("请选择有效企业"), { statusCode: 400 });
  await ensureTenantLoginDeliverySchemaMysql();
  const rows = await mysqlQuery(`SELECT d.person_id, d.password_ciphertext, p.username, p.password_hash, t.name AS enterprise
    FROM tenant_login_deliveries d
    JOIN tenants t ON t.id = d.tenant_id AND t.status = 'active'
    JOIN tenant_members tm ON tm.tenant_id = d.tenant_id AND tm.person_id = d.person_id AND tm.active = 1 AND tm.role = 'owner'
    JOIN people p ON p.id = d.person_id AND p.active = 1
    WHERE d.tenant_id = ?`, [id]);
  const row = rows[0];
  if (!row) throw Object.assign(new Error("该企业没有已保存的主账号登录信息，或主账号已停用、移出企业；此前仅保存密码哈希的账号无法恢复原密码"), { statusCode: 404 });
  const password = decryptTenantLoginPassword(row.password_ciphertext, id, row.person_id);
  if (!verifyPassword(password, row.password_hash)) {
    throw Object.assign(new Error("主账号密码已通过其他入口修改，保存的交付信息已失效；请让主账号在个人资料中重新设置密码后再复制"), { statusCode: 409 });
  }
  return { enterprise: row.enterprise, username: row.username, password };
}

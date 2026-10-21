import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";

export const PLATFORM_GRANTS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS platform_grants (
  person_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  role VARCHAR(32) NOT NULL DEFAULT 'super_admin',
  active TINYINT(1) NOT NULL DEFAULT 1,
  granted_by_person_id BIGINT UNSIGNED NULL,
  reason VARCHAR(500) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

let schemaReady;
export async function ensurePlatformGrantSchemaMysql() {
  if (!schemaReady) schemaReady = mysqlExecute(PLATFORM_GRANTS_SCHEMA_SQL).catch(error => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
}

export async function getPlatformGrantMysql(personId) {
  const id = Number(personId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  await ensurePlatformGrantSchemaMysql();
  const rows = await mysqlQuery(`SELECT pg.person_id, pg.role, pg.active
    FROM platform_grants pg JOIN people p ON p.id = pg.person_id AND p.active = 1
    WHERE pg.person_id = ? AND pg.role = 'super_admin' AND pg.active = 1 LIMIT 1`, [id]);
  return rows[0] || null;
}

export async function listPlatformAccountsMysql(session) {
  if (session?.platform_role !== "super_admin" || !(await getPlatformGrantMysql(session.personId))) {
    const error = new Error("仅平台超级管理员可以查看平台账号");
    error.statusCode = 403;
    throw error;
  }
  return mysqlQuery(`SELECT p.id, p.id AS person_id, p.name, p.username, p.avatar_url,
      p.active AS account_active, pg.role AS platform_role, pg.active, pg.granted_by_person_id,
      pg.reason, pg.created_at, pg.updated_at
    FROM platform_grants pg JOIN people p ON p.id = pg.person_id
    WHERE pg.role = 'super_admin' ORDER BY pg.active DESC, p.id`);
}

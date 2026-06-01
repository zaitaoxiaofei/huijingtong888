import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery } from "../mysql-pool.js";

function ensureMysqlAuthSessionEnabled() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL cutover routes are not enabled");
  }
}

function normalizeMysqlDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function mysqlQueryOne(sql, params = []) {
  const rows = await mysqlQuery(sql, params);
  return rows[0] || null;
}

function ignoreDuplicateSchemaError(error) {
  if (["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error?.code)) return;
  if (/Duplicate column name|Duplicate key name/i.test(error?.message || "")) return;
  throw error;
}

let wechatColumnsReady = false;

async function ensureWechatAuthColumnsMysql() {
  ensureMysqlAuthSessionEnabled();
  if (wechatColumnsReady) return;
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_openid VARCHAR(128) NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_unionid VARCHAR(128) NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_nickname VARCHAR(255) NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_bound_at DATETIME NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("CREATE INDEX idx_people_wechat_openid ON people (wechat_openid)").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("CREATE INDEX idx_people_wechat_unionid ON people (wechat_unionid)").catch(ignoreDuplicateSchemaError);
  wechatColumnsReady = true;
}

export async function createSessionMysql(session) {
  ensureMysqlAuthSessionEnabled();
  const expiresAt = normalizeMysqlDateTime(session.expiresAt);

  await mysqlExecute(`
    INSERT INTO sessions (token, person_id, name, role, username, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [session.token, session.personId, session.name, session.role, session.username || null, expiresAt]);

  return session.token;
}

export async function getSessionMysql(token) {
  ensureMysqlAuthSessionEnabled();
  const row = await mysqlQueryOne("SELECT * FROM sessions WHERE token = ?", [token]);
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await destroySessionMysql(token);
    return null;
  }

  return {
    personId: row.person_id,
    name: row.name,
    role: row.role,
    username: row.username,
    createdAt: new Date(row.created_at).getTime()
  };
}

export async function destroySessionMysql(token) {
  ensureMysqlAuthSessionEnabled();
  await mysqlExecute("DELETE FROM sessions WHERE token = ?", [token]);
}

export async function destroySessionsByPersonIdMysql(personId, exceptToken = "") {
  ensureMysqlAuthSessionEnabled();
  const params = [personId];
  let sql = "DELETE FROM sessions WHERE person_id = ?";
  if (exceptToken) {
    sql += " AND token <> ?";
    params.push(exceptToken);
  }
  await mysqlExecute(sql, params);
}

export async function cleanExpiredSessionsMysql() {
  ensureMysqlAuthSessionEnabled();
  await mysqlExecute("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP");
}

export async function findPersonForLoginMysql(username) {
  ensureMysqlAuthSessionEnabled();
  return await mysqlQueryOne(
    "SELECT id, name, username, role, password_hash, active FROM people WHERE username = ?",
    [username]
  );
}

export async function findPersonByIdMysql(personId) {
  ensureMysqlAuthSessionEnabled();
  return await mysqlQueryOne(
    "SELECT id, name, username, role, active, password_hash FROM people WHERE id = ?",
    [personId]
  );
}

export async function updatePersonPasswordMysql(personId, passwordHash) {
  ensureMysqlAuthSessionEnabled();
  await mysqlExecute("UPDATE people SET password_hash = ? WHERE id = ?", [passwordHash, personId]);
}

export async function findPersonByWechatIdentityMysql(identity = {}) {
  await ensureWechatAuthColumnsMysql();
  const unionid = String(identity.unionid || "").trim();
  const openid = String(identity.openid || "").trim();
  if (unionid) {
    const row = await mysqlQueryOne(
      "SELECT id, name, username, role, active FROM people WHERE wechat_unionid = ? LIMIT 1",
      [unionid]
    );
    if (row) return row;
  }
  if (!openid) return null;
  return await mysqlQueryOne(
    "SELECT id, name, username, role, active FROM people WHERE wechat_openid = ? LIMIT 1",
    [openid]
  );
}

export async function updatePersonWechatIdentityMysql(personId, identity = {}) {
  await ensureWechatAuthColumnsMysql();
  const openid = String(identity.openid || "").trim();
  const unionid = String(identity.unionid || "").trim() || null;
  const nickname = String(identity.nickname || "").trim() || null;
  if (!openid) throw new Error("微信身份缺少 openid");
  await mysqlExecute(`
    UPDATE people
    SET wechat_openid = ?, wechat_unionid = ?, wechat_nickname = ?, wechat_bound_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [openid, unionid, nickname, personId]);
}

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

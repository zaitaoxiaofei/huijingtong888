import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { db, hashPassword, verifyPassword, isLegacyHash } from "../db.js";
import { clearRateLimit, consumeRateLimit, getClientIp } from "./access.js";

const SESSION_TTL_HOURS = Math.max(1, Number(config.appSessionTtlHours || 72));
const AUTH_RATE_LIMIT_WINDOW_MS = Math.max(1, Number(config.authRateLimitWindowMinutes || 15)) * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = Math.max(1, Number(config.authRateLimitMaxAttempts || 8));

/**
 * Create a new in-database session and return the bearer token that the client
 * must send through the Authorization header.
 */
export function createSession(personId, name, role, username) {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, person_id, name, role, username, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, personId, name, role, username || null, expiresAt);
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
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

export function destroySession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function cleanExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP").run();
}

export function extractToken(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/, "") || "";
}

/**
 * Build the auth route handler factory so auth endpoints stay grouped in one
 * module instead of being embedded in the top-level server router.
 */
export function createAuthHandler(readJson) {
  return function handleAuth(req, url) {
    const key = `${req.method} ${url.pathname}`;

    if (key === "POST /api/auth/login") {
      return async () => {
        const loginKey = `auth:${getClientIp(req)}`;
        const rate = consumeRateLimit(loginKey, AUTH_RATE_LIMIT_MAX_ATTEMPTS, AUTH_RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) return { error: "登录尝试过多，请稍后再试", __status: 429 };

        const body = await readJson(req);
        const row = db
          .prepare("SELECT id, name, username, role, password_hash, active FROM people WHERE username = ?")
          .get(body.username);
        if (!row || !row.active) return { error: "用户名或密码错误" };
        if (!verifyPassword(body.password || "", row.password_hash)) return { error: "用户名或密码错误" };

        if (isLegacyHash(row.password_hash)) {
          db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(hashPassword(body.password), row.id);
        }

        clearRateLimit(loginKey);
        const token = createSession(row.id, row.name, row.role, row.username);
        return { ok: true, token, user: { id: row.id, name: row.name, role: row.role, username: row.username } };
      };
    }

    if (key === "GET /api/auth/me") {
      return async () => {
        const session = getSession(extractToken(req));
        if (!session) return null;
        const row = db.prepare("SELECT id, name, username, role, active FROM people WHERE id = ?").get(session.personId);
        if (!row || !row.active) return null;
        return { id: row.id, name: row.name, role: row.role, username: row.username };
      };
    }

    if (key === "POST /api/auth/logout") {
      return async () => {
        destroySession(extractToken(req));
        return { ok: true };
      };
    }

    if (key === "POST /api/auth/change-password") {
      return async () => {
        const session = getSession(extractToken(req));
        if (!session) return { error: "未登录" };
        const body = await readJson(req);
        const row = db.prepare("SELECT password_hash FROM people WHERE id = ?").get(session.personId);
        if (!verifyPassword(body.old_password || "", row.password_hash)) return { error: "原密码错误" };
        db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(hashPassword(body.new_password), session.personId);
        return { ok: true };
      };
    }

    return null;
  };
}

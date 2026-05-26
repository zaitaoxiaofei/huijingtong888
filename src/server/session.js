import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { hashPassword, verifyPassword, isLegacyHash } from "../auth-password.js";
import {
  cleanExpiredSessionsMysql,
  createSessionMysql,
  destroySessionMysql,
  findPersonByIdMysql,
  findPersonForLoginMysql,
  getSessionMysql,
  updatePersonPasswordMysql
} from "../services/mysql-auth-session.js";
import { clearRateLimit, consumeRateLimit, getClientIp } from "./access.js";

const SESSION_TTL_HOURS = Math.max(1, Number(config.appSessionTtlHours || 72));
const AUTH_RATE_LIMIT_WINDOW_MS = Math.max(1, Number(config.authRateLimitWindowMinutes || 15)) * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = Math.max(1, Number(config.authRateLimitMaxAttempts || 8));

export function createSession(personId, name, role, username) {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  return createSessionMysql({ token, personId, name, role, username, expiresAt });
}

export async function getSession(token) {
  if (!token) return null;
  return getSessionMysql(token);
}

export async function destroySession(token) {
  return destroySessionMysql(token);
}

export async function cleanExpiredSessions() {
  return cleanExpiredSessionsMysql();
}

export function extractToken(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/, "") || "";
}

export function createAuthHandler(readJson) {
  return function handleAuth(req, url) {
    const key = `${req.method} ${url.pathname}`;

    if (key === "POST /api/auth/login") {
      return async () => {
        const loginKey = `auth:${getClientIp(req)}`;
        const rate = consumeRateLimit(loginKey, AUTH_RATE_LIMIT_MAX_ATTEMPTS, AUTH_RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) return { error: "登录尝试过多，请稍后再试", __status: 429 };

        const body = await readJson(req);
        const row = await findPersonForLoginMysql(body.username);
        if (!row || !row.active) return { error: "用户名或密码错误" };
        if (!verifyPassword(body.password || "", row.password_hash)) return { error: "用户名或密码错误" };

        if (isLegacyHash(row.password_hash)) {
          await updatePersonPasswordMysql(row.id, hashPassword(body.password));
        }

        clearRateLimit(loginKey);
        const token = await createSession(row.id, row.name, row.role, row.username);
        return { ok: true, token, user: { id: row.id, name: row.name, role: row.role, username: row.username } };
      };
    }

    if (key === "GET /api/auth/me") {
      return async () => {
        const session = await getSession(extractToken(req));
        if (!session) return null;
        const row = await findPersonByIdMysql(session.personId);
        if (!row || !row.active) return null;
        return { id: row.id, name: row.name, role: row.role, username: row.username };
      };
    }

    if (key === "POST /api/auth/logout") {
      return async () => {
        await destroySession(extractToken(req));
        return { ok: true };
      };
    }

    if (key === "POST /api/auth/change-password") {
      return async () => {
        const session = await getSession(extractToken(req));
        if (!session) return { error: "未登录" };
        const body = await readJson(req);
        const row = await findPersonByIdMysql(session.personId);
        if (!verifyPassword(body.old_password || "", row.password_hash)) return { error: "原密码错误" };
        await updatePersonPasswordMysql(session.personId, hashPassword(body.new_password));
        return { ok: true };
      };
    }

    return null;
  };
}

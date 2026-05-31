import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { hashPassword, verifyPassword, isLegacyHash, validatePasswordStrength } from "../auth-password.js";
import {
  cleanExpiredSessionsMysql,
  createSessionMysql,
  destroySessionsByPersonIdMysql,
  destroySessionMysql,
  findPersonByIdMysql,
  findPersonByWechatIdentityMysql,
  findPersonForLoginMysql,
  getSessionMysql,
  updatePersonWechatIdentityMysql,
  updatePersonPasswordMysql
} from "../services/mysql-auth-session.js";
import { clearRateLimit, consumeRateLimit, getClientIp } from "./access.js";
import {
  confirmQrLoginSession,
  createQrMobileSession,
  consumeConfirmedQrSession,
  createQrLoginSession,
  getQrMobileSession,
  QR_MOBILE_COOKIE_MAX_AGE_SECONDS,
  QR_MOBILE_COOKIE_NAME,
  renderQrCodePng,
  renderQrConfirmPage
} from "./internal-qr-login.js";
import {
  consumeWechatTicket,
  createWechatBindTicket,
  createWechatLoginTicket,
  createWechatLoginUrl,
  createWechatRedirectUrl,
  isWechatLoginEnabled,
  resolveWechatIdentityFromCallback
} from "./wechat-login.js";

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

export async function destroySessionsByPersonId(personId, exceptToken = "") {
  return destroySessionsByPersonIdMysql(personId, exceptToken);
}

export async function cleanExpiredSessions() {
  return cleanExpiredSessionsMysql();
}

export function extractToken(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/, "") || "";
}

function authUser(row) {
  return { id: row.id, name: row.name, role: row.role, username: row.username };
}

export function createAuthHandler(readJson, overrides = {}) {
  const deps = {
    createSession,
    getSession,
    destroySession,
    findPersonById: findPersonByIdMysql,
    findPersonForLogin: findPersonForLoginMysql,
    findPersonByWechatIdentity: findPersonByWechatIdentityMysql,
    updatePersonPassword: updatePersonPasswordMysql,
    updatePersonWechatIdentity: updatePersonWechatIdentityMysql,
    hashPassword,
    verifyPassword,
    isLegacyHash,
    validatePasswordStrength,
    destroySessionsByPersonId,
    createQrLoginSession,
    createQrMobileSession,
    getQrMobileSession,
    renderQrCodePng,
    renderQrConfirmPage,
    consumeConfirmedQrSession,
    confirmQrLoginSession,
    createWechatLoginUrl,
    resolveWechatIdentityFromCallback,
    createWechatLoginTicket,
    createWechatBindTicket,
    consumeWechatTicket,
    createWechatRedirectUrl,
    isWechatLoginEnabled,
    clearRateLimit,
    consumeRateLimit,
    getClientIp,
    ...overrides
  };

  return function handleAuth(req, url) {
    const key = `${req.method} ${url.pathname}`;

    if (key === "POST /api/auth/login") {
      return async () => {
        const loginKey = `auth:${deps.getClientIp(req)}`;
        const rate = deps.consumeRateLimit(loginKey, AUTH_RATE_LIMIT_MAX_ATTEMPTS, AUTH_RATE_LIMIT_WINDOW_MS);
        if (!rate.allowed) return { error: "登录尝试过多，请稍后再试", __status: 429 };

        const body = await readJson(req);
        const row = await deps.findPersonForLogin(body.username);
        if (!row || !row.active) return { error: "用户名或密码错误" };
        if (!deps.verifyPassword(body.password || "", row.password_hash)) return { error: "用户名或密码错误" };

        if (deps.isLegacyHash(row.password_hash)) {
          await deps.updatePersonPassword(row.id, deps.hashPassword(body.password));
        }

        deps.clearRateLimit(loginKey);
        const token = await deps.createSession(row.id, row.name, row.role, row.username);
        return { ok: true, token, user: authUser(row) };
      };
    }

    if (key === "GET /api/auth/wechat/status") {
      return async () => ({
        enabled: deps.isWechatLoginEnabled(),
        authUrl: deps.createWechatLoginUrl(url)
      });
    }

    if (key === "GET /api/auth/wechat/callback") {
      return async () => {
        try {
          const { identity, redirect } = await deps.resolveWechatIdentityFromCallback(url);
          const row = await deps.findPersonByWechatIdentity(identity);
          if (row?.active) {
            const token = await deps.createSession(row.id, row.name, row.role, row.username);
            const ticket = deps.createWechatLoginTicket({ token, redirect, user: authUser(row) });
            return { __redirect: deps.createWechatRedirectUrl({ wechatTicket: ticket, redirect }) };
          }
          const bindTicket = deps.createWechatBindTicket({ identity, redirect });
          return { __redirect: deps.createWechatRedirectUrl({ wechatBindTicket: bindTicket, redirect }) };
        } catch (error) {
          return { __redirect: deps.createWechatRedirectUrl({ wechatError: error.message || "微信登录失败" }) };
        }
      };
    }

    if (key === "POST /api/auth/wechat/complete") {
      return async () => {
        const body = await readJson(req);
        const ticket = deps.consumeWechatTicket(body.ticket, "login");
        if (!ticket) return { error: "微信登录已失效，请重新扫码", __status: 401 };
        return { ok: true, token: ticket.token, user: ticket.user, redirect: ticket.redirect || "/dashboard" };
      };
    }

    if (key === "POST /api/auth/wechat/bind") {
      return async () => {
        const session = await deps.getSession(extractToken(req));
        if (!session) return { error: "未登录", __status: 401 };
        const body = await readJson(req);
        const ticket = deps.consumeWechatTicket(body.ticket, "bind");
        if (!ticket?.identity) return { error: "微信绑定已失效，请重新扫码", __status: 400 };
        const existing = await deps.findPersonByWechatIdentity(ticket.identity);
        if (existing && Number(existing.id) !== Number(session.personId)) {
          return { error: "该微信已绑定其他 ERP 账号", __status: 409 };
        }
        await deps.updatePersonWechatIdentity(session.personId, ticket.identity);
        return { ok: true, redirect: ticket.redirect || "/dashboard" };
      };
    }

    if (key === "GET /api/auth/qr/start") {
      return async () => ({ ok: true, ...deps.createQrLoginSession(url) });
    }

    if (key === "GET /api/auth/qr/status") {
      return async () => deps.consumeConfirmedQrSession(url.searchParams.get("sid"));
    }

    if (key === "GET /api/auth/qr/image") {
      return async () => {
        const buffer = await deps.renderQrCodePng(url.searchParams.get("sid"));
        if (!buffer) return { error: "二维码已过期", __status: 404 };
        return { __body: buffer, __contentType: "image/png", __status: 200 };
      };
    }

    if (key === "GET /api/auth/qr/confirm-page") {
      return async () => ({
        __html: deps.renderQrConfirmPage({
          sid: url.searchParams.get("sid"),
          secret: url.searchParams.get("secret"),
          mobileUser: deps.getQrMobileSession(req)?.user || null
        }),
        __status: 200
      });
    }

    if (key === "POST /api/auth/qr/confirm") {
      return async () => {
        const body = await readJson(req);
        const mobileSession = deps.getQrMobileSession(req);
        let row = null;
        if (mobileSession?.user?.id) {
          row = await deps.findPersonById(mobileSession.user.id);
          if (!row?.active) return { error: "手机登录态已失效，请重新输入密码", __status: 401 };
        } else {
          row = await deps.findPersonForLogin(body.username);
          if (!row || !row.active || !deps.verifyPassword(body.password || "", row.password_hash)) {
            return { error: "用户名或密码错误", __status: 401 };
          }
        }
        const token = await deps.createSession(row.id, row.name, row.role, row.username);
        const result = deps.confirmQrLoginSession({
          sid: body.sid,
          secret: body.secret,
          token,
          user: authUser(row)
        });
        if (!result.ok) return { error: result.error, __status: result.status || 400 };
        const mobileToken = deps.createQrMobileSession(authUser(row));
        return {
          ...result,
          __cookies: [{
            name: QR_MOBILE_COOKIE_NAME,
            value: mobileToken,
            options: {
              path: "/api/auth/qr",
              httpOnly: true,
              sameSite: "Lax",
              secure: config.appBaseUrl.startsWith("https://"),
              maxAge: QR_MOBILE_COOKIE_MAX_AGE_SECONDS
            }
          }]
        };
      };
    }

    if (key === "GET /api/auth/me") {
      return async () => {
        const session = await deps.getSession(extractToken(req));
        if (!session) return { error: "未登录", __status: 401 };
        const row = await deps.findPersonById(session.personId);
        if (!row || !row.active) return { error: "未登录", __status: 401 };
        return authUser(row);
      };
    }

    if (key === "POST /api/auth/logout") {
      return async () => {
        await deps.destroySession(extractToken(req));
        return { ok: true };
      };
    }

    if (key === "POST /api/auth/change-password") {
      return async () => {
        const session = await deps.getSession(extractToken(req));
        if (!session) return { error: "未登录", __status: 401 };
        const body = await readJson(req);
        const row = await deps.findPersonById(session.personId);
        if (!deps.verifyPassword(body.old_password || "", row.password_hash)) return { error: "原密码错误" };
        deps.validatePasswordStrength(body.new_password, row);
        await deps.updatePersonPassword(session.personId, deps.hashPassword(body.new_password));
        await deps.destroySessionsByPersonId(session.personId, extractToken(req));
        return { ok: true };
      };
    }

    return null;
  };
}

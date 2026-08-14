import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const attempts = new Map();

export const SITE_ACCESS_LOGIN_PATH = "/__site-access/login";
export const SITE_ACCESS_LOGOUT_PATH = "/__site-access/logout";
export const SITE_ACCESS_SESSION_PATH = "/__site-access";
export const SITE_ACCESS_API_LOGIN_PATH = "/__site-access/api-login";

const ACCESS_GATE_ENABLED = Boolean(config.siteAccessPassword);
const ACCESS_COOKIE_NAME = config.siteAccessCookieName || "erp_site_access";
const ACCESS_SESSION_HOURS = Math.max(1, Number(config.siteAccessSessionHours || 720));
const AUTH_RATE_LIMIT_WINDOW_MS = Math.max(1, Number(config.authRateLimitWindowMinutes || 15)) * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_ATTEMPTS = Math.max(1, Number(config.authRateLimitMaxAttempts || 8));

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function getClientIp(req) {
  const forwarded = String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "";
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isDirectLocalRequest(req) {
  const remoteAddress = req.socket.remoteAddress || "";
  const proxied = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["cf-ray"]);
  return isLoopbackAddress(remoteAddress) && !proxied;
}

export function consumeRateLimit(key, limit = AUTH_RATE_LIMIT_MAX_ATTEMPTS, windowMs = AUTH_RATE_LIMIT_WINDOW_MS) {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || record.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, resetAt: now + windowMs };
  }
  record.count += 1;
  if (record.count > limit) return { allowed: false, resetAt: record.resetAt };
  return { allowed: true, resetAt: record.resetAt };
}

export function clearRateLimit(key) {
  attempts.delete(key);
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function getAccessCookieSecret() {
  return createHash("sha256").update(config.siteAccessPassword).digest("hex");
}

export function createSiteAccessCookieValue() {
  const expiresAt = Date.now() + ACCESS_SESSION_HOURS * 3600 * 1000;
  const payload = String(expiresAt);
  const signature = createHmac("sha256", getAccessCookieSecret()).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function verifySiteAccessCookie(value) {
  if (!value) return false;
  const [payload, signature] = String(value).split(".");
  if (!payload || !signature) return false;
  if (Number(payload) < Date.now()) return false;
  const expected = createHmac("sha256", getAccessCookieSecret()).update(payload).digest("hex");
  return safeEqualText(signature, expected);
}

export function isSiteAccessEnabled() {
  return ACCESS_GATE_ENABLED;
}

export function isSiteAccessAuthorized(req) {
  if (!ACCESS_GATE_ENABLED) return true;
  if (isDirectLocalRequest(req)) return true;
  const headerToken = String(req.headers["x-site-access-token"] || "").trim();
  if (verifySiteAccessCookie(headerToken)) return true;
  const cookies = parseCookies(req);
  return verifySiteAccessCookie(cookies[ACCESS_COOKIE_NAME]);
}

export function getSiteAccessCookieName() {
  return ACCESS_COOKIE_NAME;
}

export function getSiteAccessCookieMaxAgeSeconds() {
  return ACCESS_SESSION_HOURS * 3600;
}

export function siteAccessUsesSecureCookie(req = null) {
  if (req) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    if (forwardedProto) return forwardedProto === "https";
    const cfVisitor = String(req.headers["cf-visitor"] || "");
    if (/"scheme"\s*:\s*"https"/i.test(cfVisitor)) return true;
    if (req.socket?.encrypted) return true;
    return false;
  }
  return config.appBaseUrl.startsWith("https://");
}

export function getSiteAccessPassword() {
  return config.siteAccessPassword;
}

export function normalizeNextPath(input) {
  const next = String(input || "/").trim();
  if (!next) return "/";
  try {
    const url = new URL(next, "http://local.invalid");
    const path = url.pathname || "/";
    const hash = url.hash || "";
    const safePath = `${path}${hash}`.replace(/\/{2,}/g, "/");
    return safePath.startsWith("/") ? safePath : "/";
  } catch {
    return next.startsWith("/") ? next.split("?")[0] : "/";
  }
}

export function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSiteAccessPage(errorMessage = "", nextPath = "/") {
  const message = errorMessage
    ? `<div class="access-banner access-error">${escapeHtml(errorMessage)}</div>`
    : `<div class="access-banner access-hint">请输入内部访问口令后继续进入系统。</div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>内部访问验证</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background:
      radial-gradient(circle at top left, rgba(37,99,235,.18), transparent 30%),
      radial-gradient(circle at bottom right, rgba(15,23,42,.12), transparent 24%),
      linear-gradient(180deg, #f6f9fd 0%, #edf2f8 100%);
      color: #102038; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: min(480px, 100%); background: rgba(255,255,255,.96); border: 1px solid #d6dfeb; border-radius: 20px; box-shadow: 0 28px 70px rgba(16, 32, 56, 0.12); padding: 32px; backdrop-filter: blur(10px); }
    .brand { display:flex; align-items:center; gap:14px; margin-bottom: 18px; }
    .badge { width:52px; height:52px; border-radius:16px; display:grid; place-items:center; background:linear-gradient(135deg,#0f172a,#2563eb); color:#fff; font-weight:800; font-size:20px; }
    h1 { margin: 0; font-size: 26px; }
    p { margin: 0; line-height: 1.6; color: #4a5a72; }
    label { display: block; margin-bottom: 8px; font-weight: 600; color: #22324a; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #bfd0e2; border-radius: 12px; padding: 14px 16px; font-size: 16px; background:#fff; }
    input:focus { outline: none; border-color: #2877ff; box-shadow: 0 0 0 4px rgba(40,119,255,.12); }
    button { width: 100%; margin-top: 16px; border: 0; border-radius: 12px; background: linear-gradient(135deg, #0d6efd, #2563eb); color: #fff; font-size: 16px; font-weight: 700; padding: 14px 18px; cursor: pointer; }
    button:hover { filter: brightness(1.02); }
    .access-banner { margin: 0 0 16px; padding: 12px 14px; border-radius: 12px; line-height: 1.5; }
    .access-error { color: #b42318; background: #fff1f0; border: 1px solid #f5c2c0; }
    .access-hint { color: #48607d; background: #eef5ff; border: 1px solid #dbe8ff; }
    .access-meta { margin-top: 14px; font-size: 13px; color: #70819a; }
  </style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="post" action="${SITE_ACCESS_LOGIN_PATH}">
      <div class="brand"><div class="badge">OZ</div><div><h1>内部访问验证</h1><p>先完成访问门禁，再进入 ERP 系统。</p></div></div>
      ${message}
      <label for="password">访问口令</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}">
      <button type="submit">进入系统</button>
      <p class="access-meta">通过后仍需使用系统账号登录。</p>
    </form>
  </div>
</body>
</html>`;
}

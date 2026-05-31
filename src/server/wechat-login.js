import { randomUUID } from "node:crypto";
import { config } from "../config.js";

const WECHAT_QRCONNECT_URL = "https://open.weixin.qq.com/connect/qrconnect";
const WECHAT_ACCESS_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const WECHAT_USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";
const TICKET_TTL_MS = 5 * 60 * 1000;

const states = new Map();
const tickets = new Map();

function pruneExpired(map) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (value.expiresAt <= now) map.delete(key);
  }
}

export function isWechatLoginEnabled() {
  return Boolean(config.wechatLoginAppId && config.wechatLoginAppSecret);
}

export function getWechatRedirectUri() {
  return config.wechatLoginRedirectUri || new URL("/api/auth/wechat/callback", config.appBaseUrl).toString();
}

function getFrontendRedirectPath(url) {
  const redirect = String(url.searchParams.get("redirect") || "/dashboard").trim() || "/dashboard";
  return redirect.startsWith("/") ? redirect.split("?")[0] : "/dashboard";
}

function buildFrontendLoginUrl(params = {}) {
  const base = new URL(config.appBaseUrl);
  const query = new URLSearchParams(params);
  base.hash = `/login?${query.toString()}`;
  return base.toString();
}

function createTicket(payload) {
  pruneExpired(tickets);
  const ticket = randomUUID();
  tickets.set(ticket, {
    ...payload,
    expiresAt: Date.now() + TICKET_TTL_MS
  });
  return ticket;
}

export function consumeWechatTicket(ticket, expectedType = "") {
  pruneExpired(tickets);
  const value = tickets.get(ticket);
  if (!value) return null;
  if (expectedType && value.type !== expectedType) return null;
  tickets.delete(ticket);
  return value;
}

export function createWechatLoginUrl(url) {
  if (!isWechatLoginEnabled()) return null;
  pruneExpired(states);
  const state = randomUUID().replace(/-/g, "");
  states.set(state, {
    redirect: getFrontendRedirectPath(url),
    expiresAt: Date.now() + TICKET_TTL_MS
  });
  const params = new URLSearchParams({
    appid: config.wechatLoginAppId,
    redirect_uri: getWechatRedirectUri(),
    response_type: "code",
    scope: "snsapi_login",
    state
  });
  return `${WECHAT_QRCONNECT_URL}?${params.toString()}#wechat_redirect`;
}

async function fetchWechatJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errcode) {
    throw new Error(data.errmsg || `微信接口请求失败: ${response.status}`);
  }
  return data;
}

export async function resolveWechatIdentityFromCallback(url) {
  if (!isWechatLoginEnabled()) throw new Error("微信登录未配置");
  pruneExpired(states);
  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  const stateRecord = states.get(state);
  states.delete(state);
  if (!code || !stateRecord) throw new Error("微信登录状态已失效，请重新扫码");

  const tokenParams = new URLSearchParams({
    appid: config.wechatLoginAppId,
    secret: config.wechatLoginAppSecret,
    code,
    grant_type: "authorization_code"
  });
  const token = await fetchWechatJson(`${WECHAT_ACCESS_TOKEN_URL}?${tokenParams.toString()}`);
  const userParams = new URLSearchParams({
    access_token: token.access_token,
    openid: token.openid,
    lang: "zh_CN"
  });
  const profile = await fetchWechatJson(`${WECHAT_USERINFO_URL}?${userParams.toString()}`);
  return {
    redirect: stateRecord.redirect || "/dashboard",
    identity: {
      openid: profile.openid || token.openid,
      unionid: profile.unionid || token.unionid || "",
      nickname: profile.nickname || "",
      avatarUrl: profile.headimgurl || ""
    }
  };
}

export function createWechatLoginTicket({ token, user, redirect }) {
  return createTicket({ type: "login", token, user, redirect });
}

export function createWechatBindTicket({ identity, redirect }) {
  return createTicket({ type: "bind", identity, redirect });
}

export function createWechatRedirectUrl(params) {
  return buildFrontendLoginUrl(params);
}

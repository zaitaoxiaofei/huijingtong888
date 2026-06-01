import assert from "node:assert/strict";
import test from "node:test";

function createNoSessionOverrides() {
  return {
    getSession: async () => null,
    findPersonById: async () => null,
    findPersonForLogin: async () => null,
    findPersonByWechatIdentity: async () => null,
    updatePersonPassword: async () => {},
    updatePersonWechatIdentity: async () => {},
    createSession: async () => "stub-token",
    destroySession: async () => {},
    clearRateLimit: () => {},
    consumeRateLimit: () => ({ allowed: true }),
    getClientIp: () => "127.0.0.1",
    verifyPassword: () => false,
    isLegacyHash: () => false,
    validatePasswordStrength: () => true,
    destroySessionsByPersonId: async () => {},
    createQrLoginSession: () => ({ sid: "qr-1", qrImageUrl: "/api/auth/qr/image?sid=qr-1" }),
    createQrMobileSession: () => "mobile-token",
    getQrMobileSession: () => null,
    renderQrCodePng: async () => Buffer.from("png"),
    renderQrConfirmPage: () => "<!doctype html><title>扫码确认登录</title>",
    consumeConfirmedQrSession: () => ({ status: "pending" }),
    confirmQrLoginSession: () => ({ ok: true, redirect: "/dashboard" }),
    createWechatLoginUrl: () => null,
    resolveWechatIdentityFromCallback: async () => ({ identity: {}, redirect: "/dashboard" }),
    createWechatLoginTicket: () => "login-ticket",
    createWechatBindTicket: () => "bind-ticket",
    consumeWechatTicket: () => null,
    createWechatRedirectUrl: (params = {}) => `http://localhost/#/login?${new URLSearchParams(params)}`,
    isWechatLoginEnabled: () => false,
    hashPassword: (value) => value
  };
}

async function loadCreateAuthHandler() {
  process.env.DB_HOST = process.env.DB_HOST || "127.0.0.1";
  process.env.DB_NAME = process.env.DB_NAME || "test_db";
  process.env.DB_USER = process.env.DB_USER || "test_user";
  const mod = await import("../src/server/session.js");
  return mod.createAuthHandler;
}

test("auth me returns 401 when bearer token has no valid session", async () => {
  const createAuthHandler = await loadCreateAuthHandler();
  const handler = createAuthHandler(async () => ({}), createNoSessionOverrides());
  const req = {
    method: "GET",
    headers: {
      authorization: "Bearer invalid-token"
    }
  };
  const url = new URL("http://localhost/api/auth/me");

  const run = handler(req, url);
  const result = await run();

  assert.equal(result.error, "未登录");
  assert.equal(result.__status, 401);
});

test("change password returns 401 when bearer token has no valid session", async () => {
  const createAuthHandler = await loadCreateAuthHandler();
  const handler = createAuthHandler(async () => ({
    old_password: "old-pass",
    new_password: "new-pass"
  }), createNoSessionOverrides());
  const req = {
    method: "POST",
    headers: {
      authorization: "Bearer invalid-token"
    }
  };
  const url = new URL("http://localhost/api/auth/change-password");

  const run = handler(req, url);
  const result = await run();

  assert.equal(result.error, "未登录");
  assert.equal(result.__status, 401);
});

test("wechat status returns configured login URL", async () => {
  const createAuthHandler = await loadCreateAuthHandler();
  const handler = createAuthHandler(async () => ({}), {
    ...createNoSessionOverrides(),
    isWechatLoginEnabled: () => true,
    createWechatLoginUrl: () => "https://open.weixin.qq.com/connect/qrconnect?appid=wx-demo"
  });
  const req = { method: "GET", headers: {} };
  const url = new URL("http://localhost/api/auth/wechat/status?redirect=/dashboard");

  const result = await handler(req, url)();

  assert.equal(result.enabled, true);
  assert.match(result.authUrl, /qrconnect/);
});

test("wechat complete returns a session token from a one-time ticket", async () => {
  const createAuthHandler = await loadCreateAuthHandler();
  const user = { id: 7, name: "Alice", role: "operator", username: "alice" };
  const handler = createAuthHandler(async () => ({ ticket: "ticket-1" }), {
    ...createNoSessionOverrides(),
    consumeWechatTicket: (ticket, type) => ticket === "ticket-1" && type === "login"
      ? { token: "wechat-session-token", user, redirect: "/orders", type: "login" }
      : null
  });
  const req = { method: "POST", headers: {} };
  const url = new URL("http://localhost/api/auth/wechat/complete");

  const result = await handler(req, url)();

  assert.equal(result.token, "wechat-session-token");
  assert.deepEqual(result.user, user);
  assert.equal(result.redirect, "/orders");
});

test("qr start returns a login session descriptor", async () => {
  const createAuthHandler = await loadCreateAuthHandler();
  const handler = createAuthHandler(async () => ({}), createNoSessionOverrides());
  const req = { method: "GET", headers: {} };
  const url = new URL("http://localhost/api/auth/qr/start?redirect=/orders");

  const result = await handler(req, url)();

  assert.equal(result.ok, true);
  assert.equal(result.sid, "qr-1");
  assert.equal(result.qrImageUrl, "/api/auth/qr/image?sid=qr-1");
});

test("qr confirm authenticates credentials and confirms the desktop session", async () => {
  const createAuthHandler = await loadCreateAuthHandler();
  const user = {
    id: 9,
    name: "Bob",
    username: "bob",
    role: "operator",
    active: 1,
    password_hash: "hash"
  };
  let confirmedPayload = null;
  const handler = createAuthHandler(async () => ({
    sid: "qr-1",
    secret: "secret",
    username: "bob",
    password: "correct"
  }), {
    ...createNoSessionOverrides(),
    findPersonForLogin: async () => user,
    verifyPassword: () => true,
    createSession: async () => "desktop-token",
    confirmQrLoginSession: (payload) => {
      confirmedPayload = payload;
      return { ok: true, redirect: "/orders" };
    }
  });
  const req = { method: "POST", headers: {} };
  const url = new URL("http://localhost/api/auth/qr/confirm");

  const result = await handler(req, url)();

  assert.equal(result.ok, true);
  assert.equal(result.redirect, "/orders");
  assert.equal(confirmedPayload.token, "desktop-token");
  assert.equal(confirmedPayload.user.username, "bob");
  assert.equal(result.__cookies[0].name, "erp_qr_mobile");
});

test("qr confirm can use remembered mobile account without password", async () => {
  const createAuthHandler = await loadCreateAuthHandler();
  const user = {
    id: 10,
    name: "Carol",
    username: "carol",
    role: "manager",
    active: 1,
    password_hash: "hash"
  };
  const handler = createAuthHandler(async () => ({
    sid: "qr-2",
    secret: "secret"
  }), {
    ...createNoSessionOverrides(),
    getQrMobileSession: () => ({ user: { id: 10, username: "carol" } }),
    findPersonById: async () => user,
    createSession: async () => "remembered-token",
    confirmQrLoginSession: () => ({ ok: true, redirect: "/dashboard" })
  });
  const req = { method: "POST", headers: {} };
  const url = new URL("http://localhost/api/auth/qr/confirm");

  const result = await handler(req, url)();

  assert.equal(result.ok, true);
  assert.equal(result.__cookies[0].value, "mobile-token");
});

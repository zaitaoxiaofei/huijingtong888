import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_HOST = "127.0.0.1";
process.env.DB_NAME = "test_db";
process.env.DB_USER = "test_user";
process.env.DB_PORT = "1";
process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = "3";

const { createAuthHandler } = await import("../src/server/session.js");
const { createQrLoginSession, consumeConfirmedQrSession } = await import("../src/server/internal-qr-login.js");
const { consumeRateLimit, clearRateLimit } = await import("../src/server/access.js");

const user = { id: 9, name: "Bob", username: "bob", role: "operator", active: 1, password_hash: "hash" };
const confirmUrl = new URL("http://localhost/api/auth/qr/confirm");
const loginUrl = new URL("http://localhost/api/auth/login");
const request = { method: "POST", headers: {} };

function createQrBody() {
  const qr = createQrLoginSession(new URL("http://localhost/api/auth/qr/start?redirect=/orders"));
  return { sid: qr.sid, secret: new URL(qr.confirmUrl).searchParams.get("secret"), username: "bob", password: "correct" };
}

function fixture(body, overrides = {}) {
  const events = [];
  const tokens = new Set();
  let nextToken = 0;
  const handler = createAuthHandler(async () => body, {
    getSession: async () => null,
    getQrMobileSession: () => null,
    findPersonForLogin: async () => { events.push("find-login"); return user; },
    findPersonById: async () => { events.push("find-person"); return user; },
    verifyPassword: (password) => { events.push("verify"); return password === "correct"; },
    isLegacyHash: () => false,
    getClientIp: () => "qr-security-test",
    consumeRateLimit: (...args) => { events.push(["rate", ...args]); return { allowed: true }; },
    clearRateLimit: (key) => { events.push(["clear", key]); },
    createSession: async () => {
      const token = `desktop-${++nextToken}`;
      events.push(["create", token]);
      tokens.add(token);
      return token;
    },
    destroySession: async (token) => { events.push(["destroy", token]); tokens.delete(token); },
    createQrMobileSession: () => { events.push("mobile-cookie"); return "remembered-mobile-token"; },
    ...overrides
  });
  return { events, tokens, run: (url = confirmUrl) => handler(request, url)() };
}

test("QR invalid, missing and expired challenges cannot check credentials or create sessions", async (t) => {
  let currentTime = Date.now();
  t.mock.method(Date, "now", () => currentTime);
  for (const [name, change, status] of [
    ["missing sid", (body) => { delete body.sid; }, 410],
    ["unknown sid", (body) => { body.sid = "unknown"; }, 410],
    ["missing secret", (body) => { delete body.secret; }, 403],
    ["wrong secret", (body) => { body.secret = "wrong"; }, 403],
    ["expired", () => { currentTime += 5 * 60 * 1000; }, 410]
  ]) {
    await t.test(name, async () => {
      const body = createQrBody();
      change(body);
      const state = fixture(body);
      const result = await state.run();
      assert.equal(result.__status, status);
      assert.equal(result.__cookies, undefined);
      assert.deepEqual(state.events, []);
      assert.equal(state.tokens.size, 0);
    });
  }
});

test("QR password confirmation and ordinary login share the same rate-limit bucket", async (t) => {
  for (const firstUrl of [loginUrl, confirmUrl]) {
    await t.test(firstUrl.pathname, async () => {
      const body = { ...createQrBody(), password: "wrong" };
      const ip = `qr-rate-limit-${firstUrl.pathname}`;
      const state = fixture(body, { consumeRateLimit, clearRateLimit, getClientIp: () => ip });
      t.after(() => clearRateLimit(`auth:${ip}`));
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.match((await state.run(firstUrl)).error, /用户名或密码错误/);
      }
      const otherUrl = firstUrl === loginUrl ? confirmUrl : loginUrl;
      const result = await state.run(otherUrl);
      assert.equal(result.__status, 429);
      assert.equal(state.events.filter((event) => event === "verify").length, 3);
      assert.equal(state.tokens.size, 0);
      assert.equal(result.__cookies, undefined);
    });
  }
});

test("QR password success clears the existing login limit only after desktop confirmation", async () => {
  const body = createQrBody();
  const state = fixture(body);
  const result = await state.run();
  assert.equal(result.ok, true);
  assert.equal(result.redirect, "/orders");
  assert.equal(result.token, undefined);
  assert.equal(result.__cookies[0].value, "remembered-mobile-token");
  assert.deepEqual(state.events[0].slice(0, 3), ["rate", "auth:qr-security-test", 3]);
  assert.ok(state.events[0][3] > 0);
  assert.deepEqual(state.events.slice(-3), [["create", "desktop-1"], ["clear", "auth:qr-security-test"], "mobile-cookie"]);
  assert.deepEqual(consumeConfirmedQrSession(body.sid), {
    status: "confirmed", token: "desktop-1",
    user: { id: 9, name: "Bob", username: "bob", role: "operator", roles: ["operator"], avatar_url: "", tenant: null },
    redirect: "/orders"
  });
  assert.deepEqual(consumeConfirmedQrSession(body.sid), { status: "expired" });
});

test("QR wrong credentials and disabled accounts do not create sessions or clear login failures", async (t) => {
  for (const [name, overrides] of [
    ["wrong password", { verifyPassword: () => false }],
    ["unknown account", { findPersonForLogin: async () => null }],
    ["disabled account", { findPersonForLogin: async () => ({ ...user, active: 0 }) }]
  ]) {
    await t.test(name, async () => {
      const state = fixture(createQrBody(), overrides);
      const result = await state.run();
      assert.equal(result.__status, 401);
      assert.equal(result.__cookies, undefined);
      assert.equal(state.tokens.size, 0);
      assert.ok(!state.events.some((event) => Array.isArray(event) && ["clear", "create"].includes(event[0])));
      assert.ok(!state.events.includes("mobile-cookie"));
    });
  }
});

test("QR remembered mobile confirmation rechecks the account without using password attempts", async (t) => {
  for (const active of [1, 0]) {
    await t.test(`active=${active}`, async () => {
      const body = createQrBody();
      delete body.username;
      delete body.password;
      let checkedId;
      const state = fixture(body, {
        getQrMobileSession: () => ({ user: { id: user.id } }),
        findPersonById: async (id) => { checkedId = id; return { ...user, active }; }
      });
      const result = await state.run();
      assert.equal(checkedId, user.id);
      assert.equal(result.ok, active ? true : undefined);
      assert.equal(result.__status, active ? undefined : 401);
      assert.equal(state.tokens.size, active ? 1 : 0);
      assert.ok(!state.events.includes("find-login"));
      assert.ok(!state.events.includes("verify"));
      assert.ok(!state.events.some((event) => Array.isArray(event) && ["rate", "clear"].includes(event[0])));
      if (active) {
        assert.equal(result.__cookies[0].name, "erp_qr_mobile");
        assert.equal(consumeConfirmedQrSession(body.sid).token, "desktop-1");
      } else assert.equal(result.__cookies, undefined);
    });
  }
});

test("QR expiry during account lookup is rejected before session persistence", async (t) => {
  let currentTime = Date.now();
  t.mock.method(Date, "now", () => currentTime);
  const state = fixture(createQrBody(), {
    findPersonForLogin: async () => { currentTime += 5 * 60 * 1000; return user; }
  });
  const result = await state.run();
  assert.equal(result.__status, 410);
  assert.equal(state.tokens.size, 0);
  assert.ok(!state.events.some((event) => Array.isArray(event) && event[0] === "create"));
  assert.equal(result.__cookies, undefined);
});

test("QR expiry during session persistence revokes the unconfirmed token", async (t) => {
  let currentTime = Date.now();
  t.mock.method(Date, "now", () => currentTime);
  const body = createQrBody();
  const state = fixture(body, {
    createSession: async () => {
      state.tokens.add("expired-token");
      currentTime += 5 * 60 * 1000;
      return "expired-token";
    }
  });
  const result = await state.run();
  assert.equal(result.__status, 410);
  assert.equal(state.tokens.size, 0);
  assert.deepEqual(state.events.at(-1), ["destroy", "expired-token"]);
  assert.ok(!state.events.some((event) => Array.isArray(event) && event[0] === "clear"));
  assert.equal(result.__cookies, undefined);
  assert.deepEqual(consumeConfirmedQrSession(body.sid), { status: "expired" });
});

test("QR repeat confirmation cannot create a second token or remembered account", async () => {
  const body = createQrBody();
  const state = fixture(body);
  assert.equal((await state.run()).ok, true);
  const firstEvents = [...state.events];
  const result = await state.run();
  assert.equal(result.__status, 409);
  assert.equal(result.__cookies, undefined);
  assert.deepEqual(state.events, firstEvents);
  assert.deepEqual([...state.tokens], ["desktop-1"]);
  assert.equal(consumeConfirmedQrSession(body.sid).token, "desktop-1");
});

test("QR concurrent confirmation revokes the losing token before and after desktop consumption", async (t) => {
  for (const consumeFirst of [false, true]) {
    await t.test(`desktop consumed=${consumeFirst}`, async () => {
      const body = createQrBody();
      const releases = [];
      let notifyStarted;
      const bothStarted = new Promise((resolve) => { notifyStarted = resolve; });
      const state = fixture(body, {
        createSession: async () => {
          const token = `race-${releases.length + 1}`;
          state.tokens.add(token);
          await new Promise((resolve) => {
            releases.push(resolve);
            if (releases.length === 2) notifyStarted();
          });
          return token;
        }
      });
      const first = state.run();
      const second = state.run();
      await bothStarted;
      releases[0]();
      assert.equal((await first).ok, true);
      if (consumeFirst) assert.equal(consumeConfirmedQrSession(body.sid).token, "race-1");
      releases[1]();
      const rejected = await second;
      assert.equal(rejected.__status, consumeFirst ? 410 : 409);
      assert.equal(rejected.__cookies, undefined);
      assert.deepEqual([...state.tokens], ["race-1"]);
      assert.ok(state.events.some((event) => Array.isArray(event) && event[0] === "destroy" && event[1] === "race-2"));
      assert.equal(state.events.filter((event) => event === "mobile-cookie").length, 1);
      if (!consumeFirst) assert.equal(consumeConfirmedQrSession(body.sid).token, "race-1");
    });
  }
});

test("QR confirmation exceptions revoke the unconfirmed token", async () => {
  const state = fixture(createQrBody(), {
    confirmQrLoginSession: () => { throw new Error("confirmation failed"); }
  });
  await assert.rejects(state.run(), /confirmation failed/);
  assert.equal(state.tokens.size, 0);
  assert.deepEqual(state.events.at(-1), ["destroy", "desktop-1"]);
  assert.ok(!state.events.includes("mobile-cookie"));
});

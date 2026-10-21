import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const apiSource = readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../frontend/admin/stores/auth.js", import.meta.url), "utf8");
const moduleBody = source => source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function person(id, tenantId = id) {
  return { id, name: `Fixture person ${id}`, roles: ["operations"], tenant: { id: tenantId, slug: `fixture-${tenantId}`, role: "member" } };
}

function harness() {
  const calls = [];
  const listeners = new Map();
  const timers = new Map();
  const localStorage = storage();
  const context = vm.createContext({
    window: {
      localStorage, sessionStorage: storage(), location: { hash: "#/dashboard" },
      setTimeout(callback) { const id = Symbol(); timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); }
    },
    AbortController, DOMException, console,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    beginApiPerf() { return {}; }, endApiPerf() {},
    ref: value => ({ value }), computed: read => ({ get value() { return read(); } }), defineStore: (_id, create) => create,
    fetch(url, options) { const pending = deferred(); calls.push({ url, options, ...pending }); return pending.promise; }
  });
  vm.runInContext(`(() => {
    ${moduleBody(apiSource)}
    globalThis.api = { apiClient, currentApiCacheScope, getAuthToken, setAuthToken, clearAuthToken };
  })()`, context, { filename: "frontend/admin/utils/api.js" });
  vm.runInContext(`(() => {
    const { apiClient, clearAuthToken, currentApiCacheScope, getAuthToken, setAuthToken } = api;
    ${moduleBody(authSource)}
    globalThis.store = useAuthStore();
  })()`, context, { filename: "frontend/admin/stores/auth.js" });
  return {
    store: context.store, api: context.api, calls, localStorage, timers,
    login(id, { tenantId = id, token = `fixture-session-${id}` } = {}) {
      context.store.applyLoginResult({ token, user: person(id, tenantId) });
    },
    respond(index, data, status = 200) {
      calls[index].resolve({ ok: status >= 200 && status < 300, status,
        headers: { get() { return "application/json"; } }, async json() { return data; } });
    },
    cachedUser() { return JSON.parse(localStorage.getItem("baodanAuthUser") || "null"); }
  };
}

test("bootstrap cannot overwrite or clear a login established while its old request is pending", async () => {
  for (const status of [200, 401]) {
    const h = harness();
    h.api.setAuthToken("fixture-session-1");
    const bootstrap = h.store.bootstrap();
    h.login(2);
    h.respond(0, status === 200 ? person(1) : { error: "Fixture expired session" }, status);
    await bootstrap;
    assert.equal(h.store.user.value.id, 2);
    assert.equal(h.cachedUser().id, 2);
    assert.equal(h.api.getAuthToken(), "fixture-session-2");
    assert.equal(h.store.bootstrapped.value, true);
    assert.equal(h.timers.size, 0);
  }
});

test("store-level bootstrap and verification guards reject late successful identity callbacks", async () => {
  for (const method of ["bootstrap", "verifySession"]) {
    const h = harness();
    const pending = deferred();
    h.api.apiClient.get = () => pending.promise;
    if (method === "bootstrap") h.api.setAuthToken("fixture-session-1");
    else h.login(1);
    const loading = h.store[method]();
    h.login(2);
    pending.resolve(person(1));
    await loading;
    assert.equal(h.store.user.value.id, 2);
    assert.equal(h.cachedUser().id, 2);
    assert.equal(h.api.getAuthToken(), "fixture-session-2");
  }
});

for (const rotation of ["token", "tenant"]) {
  test(`verification deduplicates within one scope and starts fresh after ${rotation} changes`, async () => {
    const h = harness();
    h.login(1);
    const first = h.store.verifySession();
    const same = h.store.verifySession();
    assert.equal(h.calls.length, 1);
    if (rotation === "token") h.login(2);
    else h.login(1, { tenantId: 2 });
    const second = h.store.verifySession();
    const duplicate = h.store.verifySession();
    assert.equal(h.calls.length, 2, "new authentication scope must not reuse old verification");
    h.respond(0, { error: "Fixture old session expired" }, 401);
    assert.equal(await first, null);
    assert.equal(await same, null);
    assert.equal(h.store.user.value.tenant.id, 2);
    const third = h.store.verifySession();
    assert.equal(h.calls.length, 2, "old finally must not clear the current verification record");
    const currentUser = { ...person(rotation === "token" ? 2 : 1, 2), name: "Fresh canonical identity" };
    h.respond(1, currentUser);
    await Promise.all([second, duplicate, third]);
    assert.equal(h.store.user.value.name, currentUser.name);
    assert.equal(h.cachedUser().name, currentUser.name);
    assert.equal(h.api.getAuthToken(), rotation === "token" ? "fixture-session-2" : "fixture-session-1");
    assert.equal(h.timers.size, 0);
  });
}

test("intentional verification cancellation preserves the current authenticated session", async () => {
  const h = harness();
  h.login(1);
  const verification = h.store.verifySession();
  h.calls[0].reject(new DOMException("Fixture cancelled request", "AbortError"));
  assert.equal(await verification, null);
  assert.equal(h.store.user.value.id, 1);
  assert.equal(h.api.getAuthToken(), "fixture-session-1");
  assert.equal(h.cachedUser().id, 1);
});

test("current unauthorized verification still clears the session without affecting a later login", async () => {
  const h = harness();
  h.login(1);
  const pending = deferred();
  h.api.apiClient.get = () => pending.promise;
  const verification = h.store.verifySession();
  pending.reject(Object.assign(new Error("Fixture expired session"), { status: 401 }));
  await verification;
  assert.equal(h.store.user.value, null);
  assert.equal(h.cachedUser(), null);
  assert.equal(h.api.getAuthToken(), "");
  h.login(2);
  assert.equal(h.store.user.value.id, 2);
});

test("a stale logout completion cannot clear a new login, while current logout still clears everything", async () => {
  const h = harness();
  h.login(1);
  const staleLogout = h.store.logout();
  h.login(2);
  h.respond(0, { ok: true });
  await staleLogout;
  assert.equal(h.store.user.value.id, 2);
  assert.equal(h.cachedUser().id, 2);
  assert.equal(h.api.getAuthToken(), "fixture-session-2");
  const currentLogout = h.store.logout();
  h.respond(1, { ok: true });
  await currentLogout;
  assert.equal(h.store.isAuthenticated.value, false);
  assert.equal(h.store.user.value, null);
  assert.equal(h.cachedUser(), null);
  assert.equal(h.api.getAuthToken(), "");
});

test("current logout clears local authentication even when its network request fails", async () => {
  const h = harness();
  h.login(1);
  const logout = h.store.logout();
  h.calls[0].reject(new TypeError("Fixture network unavailable"));
  await logout;
  assert.equal(h.store.user.value, null);
  assert.equal(h.cachedUser(), null);
  assert.equal(h.api.getAuthToken(), "");
});

test("first bootstrap adopts canonical identity and finishes after its own cache scope changes", async () => {
  const h = harness();
  h.api.setAuthToken("fixture-session-1");
  const bootstrap = h.store.bootstrap();
  h.respond(0, person(1));
  await bootstrap;
  assert.equal(h.store.user.value.id, 1);
  assert.equal(h.cachedUser().id, 1);
  assert.equal(h.store.bootstrapped.value, true);
  assert.equal(h.timers.size, 0);
});

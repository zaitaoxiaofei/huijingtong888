import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const apiSource = readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8");
const dictionarySource = readFileSync(new URL("../frontend/admin/utils/shop-dictionary.js", import.meta.url), "utf8");

function createStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function moduleBody(source) {
  return source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
}

function createHarness() {
  let now = Date.now();
  const listeners = new Map();
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const calls = [];
  const window = {
    localStorage,
    sessionStorage,
    location: { hash: "#/dashboard" },
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    }
  };
  const context = vm.createContext({
    window,
    console,
    AbortController,
    DOMException,
    TextDecoder,
    Uint8Array,
    Date: class extends Date { static now() { return now; } },
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    beginApiPerf() { return {}; },
    endApiPerf() {},
    reactive(value) { return value; },
    fetch(url, options) {
      const pending = deferred();
      // Deliberately ignore aborted signals: the response guard must also reject late results.
      calls.push({ url, options, ...pending });
      return pending.promise;
    }
  });
  vm.runInContext(`(() => {
    ${moduleBody(apiSource)}
    globalThis.api = { apiClient, currentApiCacheScope, getAuthToken, setAuthToken, clearAuthToken, streamApiResponse };
  })()`, context, { filename: "frontend/admin/utils/api.js" });
  vm.runInContext(`(() => {
    const { apiClient, currentApiCacheScope } = globalThis.api;
    ${moduleBody(dictionarySource)}
    globalThis.dictionary = { loadShopDictionary, useShopDictionary, invalidateShopDictionary };
  })()`, context, { filename: "frontend/admin/utils/shop-dictionary.js" });
  function setUser({ tenantId = 1, personId = 10 } = {}) {
    localStorage.setItem("baodanAuthUser", JSON.stringify({ personId, tenant: { id: tenantId, slug: `tenant-${tenantId}` } }));
  }
  function respond(index, data, status = 200) {
    calls[index].resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get(name) { return name.toLowerCase() === "content-type" ? "application/json" : null; } },
      async json() { return data; },
      async text() { return JSON.stringify(data); }
    });
  }
  setUser();
  return {
    ...context.api,
    ...context.dictionary,
    calls,
    localStorage,
    sessionStorage,
    window,
    setUser,
    respond,
    advance(ms) { now += ms; },
    cacheKeys() {
      return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
        .filter((key) => key.startsWith("erp:get-cache:"));
    }
  };
}

function rejectsStale(promise) {
  return assert.rejects(promise, (error) => error.name === "AbortError");
}

test("cached and persisted GET results cannot cross tokens even while cached user identity remains stale", async () => {
  const h = createHarness();
  h.setAuthToken("session-token-A-private");
  const scopeA = h.currentApiCacheScope();
  const first = h.apiClient.get("/api/shops");
  h.respond(0, [{ id: 1, name: "A shop" }]);
  assert.equal((await first)[0].id, 1);
  assert.equal((await h.apiClient.get("/api/shops"))[0].id, 1);
  assert.equal(h.calls.length, 1, "same session should retain the memory cache");

  const persistedKeys = h.cacheKeys();
  assert.equal(persistedKeys.length, 1);
  assert.ok(!persistedKeys[0].includes("session-token-A-private"));
  assert.ok(!scopeA.includes("session-token-A-private"));
  h.advance(31000);
  assert.equal((await h.apiClient.get("/api/shops"))[0].id, 1);
  assert.equal(h.calls.length, 1, "same session should reuse persisted cache after memory TTL expires");

  h.setAuthToken("session-token-B-private");
  assert.notEqual(h.currentApiCacheScope(), scopeA);
  assert.equal(h.cacheKeys().length, 0, "changing tokens must clear persisted old-session data");
  const second = h.apiClient.get("/api/shops");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].options.headers.Authorization, "Bearer session-token-B-private");
  h.respond(1, [{ id: 2, name: "B shop" }]);
  assert.equal((await second)[0].id, 2);
  assert.ok(h.cacheKeys().every((key) => !key.includes("session-token-")));
});

test("no-cache shop requests dedupe within one session and never dedupe across sessions", async () => {
  const h = createHarness();
  const options = { noCache: true, cache: "no-store" };
  h.setAuthToken("session-A");
  const first = h.apiClient.get("/api/shops", options);
  assert.equal(h.apiClient.get("/api/shops", options), first);
  const stale = rejectsStale(first);
  h.setAuthToken("session-B");
  const second = h.apiClient.get("/api/shops", options);
  assert.notEqual(first, second);
  assert.equal(h.apiClient.get("/api/shops", options), second);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.headers.Authorization, "Bearer session-A");
  assert.equal(h.calls[1].options.headers.Authorization, "Bearer session-B");
  h.respond(1, [{ id: 2 }]);
  assert.equal((await second)[0].id, 2);
  h.respond(0, [{ id: 1 }]);
  await stale;
});

test("a cacheable old-session response cannot populate the new session's memory or persisted cache", async () => {
  const h = createHarness();
  h.setAuthToken("session-A");
  const first = h.apiClient.get("/api/shops");
  assert.equal(h.apiClient.get("/api/shops"), first);
  const stale = rejectsStale(first);
  h.setAuthToken("session-B");
  const second = h.apiClient.get("/api/shops");
  assert.equal(h.calls.length, 2);
  h.respond(1, [{ id: 2 }]);
  await second;
  h.respond(0, [{ id: 1 }]);
  await stale;
  assert.equal((await h.apiClient.get("/api/shops"))[0].id, 2);
  h.advance(31000);
  assert.equal((await h.apiClient.get("/api/shops"))[0].id, 2);
  assert.equal(h.calls.length, 2);
});

for (const change of [
  { name: "active tenant", user: { tenantId: 2, personId: 10 } },
  { name: "person", user: { tenantId: 1, personId: 20 } }
]) {
  test(`cached GET results are invalidated when ${change.name} changes under the same token`, async () => {
    const h = createHarness();
    h.setAuthToken("unchanged-token");
    const scopeA = h.currentApiCacheScope();
    const first = h.apiClient.get("/api/shops");
    h.respond(0, [{ id: 1 }]);
    await first;
    h.setUser(change.user);
    const second = h.apiClient.get("/api/shops");
    assert.notEqual(h.currentApiCacheScope(), scopeA);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].options.headers.Authorization, "Bearer unchanged-token");
    h.respond(1, [{ id: 2 }]);
    assert.equal((await second)[0].id, 2);
  });
}

test("clearing authentication synchronously removes cache entries and visible dictionary rows", async () => {
  const h = createHarness();
  h.setAuthToken("session-A");
  const { state } = h.useShopDictionary();
  const dictionary = h.loadShopDictionary();
  h.respond(0, [{ id: 1, name: "A shop" }]);
  await dictionary;
  const cached = h.apiClient.get("/api/people");
  h.respond(1, [{ id: 10 }]);
  await cached;
  assert.equal(state.rows[0].id, 1);
  assert.equal(h.cacheKeys().length, 1);
  h.clearAuthToken();
  assert.equal(h.getAuthToken(), "");
  assert.equal(h.cacheKeys().length, 0);
  assert.equal(state.rows.length, 0);
  assert.equal(state.loadedAt, 0);
  assert.equal(state.loading, false);
});

test("late old-session dictionary responses cannot replace the new session's rows or loading state", async () => {
  const h = createHarness();
  h.setAuthToken("session-A");
  const { state } = h.useShopDictionary();
  const oldLoad = h.loadShopDictionary();
  const stale = rejectsStale(oldLoad);
  h.setAuthToken("session-B");
  const newLoad = h.loadShopDictionary();
  assert.equal(h.calls.length, 2);
  assert.equal(state.loading, true);
  h.respond(0, [{ id: 1, name: "A shop" }]);
  await stale;
  assert.equal(state.rows.length, 0);
  assert.equal(state.loading, true, "old completion must not finish the new session's load");
  h.respond(1, [{ id: 2, name: "B shop" }]);
  assert.equal((await newLoad)[0].id, 2);
  assert.equal(state.rows[0].id, 2);
  assert.equal(state.loading, false);
  assert.equal((await h.loadShopDictionary())[0].id, 2);
  assert.equal(h.calls.length, 2, "same-session dictionary reuse must remain enabled");
});

test("an old dictionary response arriving after the new dictionary is loaded leaves the new rows intact", async () => {
  const h = createHarness();
  h.setAuthToken("session-A");
  const { state } = h.useShopDictionary();
  const oldLoad = h.loadShopDictionary();
  const stale = rejectsStale(oldLoad);
  h.setAuthToken("session-B");
  const newLoad = h.loadShopDictionary();
  h.respond(1, [{ id: 2, name: "B shop" }]);
  await newLoad;
  const loadedAt = state.loadedAt;
  h.advance(1000);
  h.respond(0, [{ id: 1, name: "A shop" }]);
  await stale;
  assert.equal(state.rows[0].id, 2);
  assert.equal(state.loadedAt, loadedAt);
  assert.equal(state.loading, false);
  assert.equal((await h.loadShopDictionary())[0].id, 2);
  assert.equal(h.calls.length, 2);
});

test("a cross-tab tenant change clears visible dictionary data before fetching the new tenant", async () => {
  const h = createHarness();
  h.setAuthToken("unchanged-token");
  const { state } = h.useShopDictionary();
  const first = h.loadShopDictionary();
  const duplicate = h.loadShopDictionary();
  assert.equal(h.calls.length, 1);
  h.respond(0, [{ id: 1 }]);
  await Promise.all([first, duplicate]);
  h.setUser({ tenantId: 2 });
  h.window.dispatchEvent({ type: "storage", key: "baodanAuthUser" });
  assert.equal(state.rows.length, 0);
  assert.equal(state.loadedAt, 0);
  const second = h.loadShopDictionary();
  assert.equal(h.calls.length, 2);
  h.respond(1, [{ id: 2 }]);
  await second;
  assert.equal(state.rows[0].id, 2);
});

test("a late unauthorized response from an old session cannot expire the current login", async () => {
  const h = createHarness();
  let expired = false;
  h.window.addEventListener("app:auth-expired", () => { expired = true; });
  h.setAuthToken("session-A");
  const first = h.apiClient.get("/api/shops", { noCache: true });
  const stale = rejectsStale(first);
  h.setAuthToken("session-B");
  h.respond(0, { error: "old session expired" }, 401);
  await stale;
  assert.equal(expired, false);
  assert.equal(h.getAuthToken(), "session-B");
});

test("stream deltas received after a session switch never reach the old request's callback", async () => {
  const h = createHarness();
  h.setAuthToken("session-A");
  const chunks = [deferred(), deferred()];
  const secondRead = deferred();
  const deltas = [];
  let readCount = 0;
  const request = h.streamApiResponse("/api/ai/stream", {}, { onDelta(delta) { deltas.push(delta); } });
  const stale = rejectsStale(request);
  h.calls[0].resolve({
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            const chunk = chunks[readCount++];
            if (readCount === 2) secondRead.resolve();
            return chunk?.promise || Promise.resolve({ done: true });
          },
          async cancel() {}
        };
      }
    }
  });
  chunks[0].resolve({ value: new TextEncoder().encode('event: delta\ndata: {"delta":"before switch"}\n\n'), done: false });
  await secondRead.promise;
  assert.deepEqual(deltas, ["before switch"]);
  h.setAuthToken("session-B");
  chunks[1].resolve({
    value: new TextEncoder().encode('event: delta\ndata: {"delta":"private late delta"}\n\nevent: done\ndata: {"result":"old completion"}\n\n'),
    done: false
  });
  await stale;
  assert.deepEqual(deltas, ["before switch"]);
  assert.equal(h.getAuthToken(), "session-B");
});

for (const status of [200, 401]) {
  test(`a session switch during a delayed ${status} download body rejects the old response`, async () => {
    const h = createHarness();
    h.setAuthToken("session-A");
    const body = deferred();
    const bodyStarted = deferred();
    let expired = false;
    h.window.addEventListener("app:auth-expired", () => { expired = true; });
    const request = h.apiClient.blob("/api/export");
    const stale = rejectsStale(request);
    h.calls[0].resolve({
      ok: status === 200,
      status,
      headers: { get() { return "application/json"; } },
      blob() { bodyStarted.resolve(); return body.promise; },
      json() { bodyStarted.resolve(); return body.promise; }
    });
    await bodyStarted.promise;
    h.setAuthToken("session-B");
    body.resolve(status === 200 ? { privateExport: "A data" } : { error: "A expired" });
    await stale;
    assert.equal(expired, false);
    assert.equal(h.getAuthToken(), "session-B");
  });
}

for (const cache of ["memory", "persisted"]) {
  test(`a ${cache} cache hit awaiting delivery is rejected if the session changes immediately`, async () => {
    const h = createHarness();
    h.setAuthToken("session-A");
    const first = h.apiClient.get("/api/shops");
    h.respond(0, [{ id: 1 }]);
    await first;
    if (cache === "persisted") h.advance(31000);
    const cached = h.apiClient.get("/api/shops");
    const stale = rejectsStale(cached);
    h.setAuthToken("session-B");
    await stale;
    assert.equal(h.calls.length, 1);
  });
}

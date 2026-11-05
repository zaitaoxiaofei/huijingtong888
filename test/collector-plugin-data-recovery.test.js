import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const contentSource = readFileSync(new URL("../ozon-erp-collector-plugin/content.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../ozon-erp-collector-plugin/background.js", import.meta.url), "utf8");
const collectorSource = readFileSync(new URL("../ozon-erp-collector-plugin/collector.js", import.meta.url), "utf8");

function loadFunction(source, start, end, name, globals = {}) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return runInNewContext(`${source.slice(from, to)}; ${name}`, globals);
}

function loadPriceReader() {
  return loadFunction(contentSource, "  function parseListCardPrice(text)", "  function cleanListCardTitleText", "extractListCardPrice");
}

test("list cards read the visible price when no cached price exists", () => {
  const readPrice = loadPriceReader();
  const priceNode = { textContent: "172 ₽", className: "tsHeadlinePrice" };
  const root = { textContent: "172 ₽", querySelectorAll: () => [priceNode] };
  assert.equal(readPrice(root, root, {}, { sku: "123" }), 172);
  assert.equal(readPrice(root, root, {}, { price: "", cardPrice: "" }), 172);
  assert.equal(readPrice(root, root, {}, { price: "", cardPrice: "200" }), 200);
  assert.equal(readPrice({}, {}, {}, { sku: "123" }), "");
});

function loadCookieReader(cookies) {
  return loadFunction(backgroundSource, "async function getSellerCookieInfo(", "async function syncPendingSellerAuthBinding", "getSellerCookieInfo", { URL, chrome: { cookies } });
}

test("seller authorization includes parent-domain cookies and retains the page company", async () => {
  const queries = [];
  const pageUrl = "https://seller.ozon.ru/app/products";
  const readCookies = loadCookieReader({
    getAll: async (query) => {
      queries.push(query);
      const sellerCookie = { name: "sc_company_id", value: "700001", domain: "seller.ozon.ru", path: "/", secure: true };
      return query.url ? [sellerCookie, { name: "parent_session", value: "test-session", domain: ".ozon.ru", path: "/", httpOnly: true }] : [sellerCookie];
    },
    get: async (query) => {
      queries.push(query);
      return query.name === "sc_company_id" ? { value: "700001" } : null;
    }
  });
  const result = await readCookies(pageUrl);
  assert.equal(queries[0].url, pageUrl);
  assert.equal(queries[1].url, pageUrl);
  assert.equal(result.companyId, "700001");
  assert.ok(result.header.includes("parent_session=test-session"));
  assert.ok(result.cookies.some((cookie) => cookie.domain === ".ozon.ru" && cookie.httpOnly));
});

test("cookie reads reject untrusted page origins", async () => {
  const queries = [];
  const readCookies = loadCookieReader({
    getAll: async (query) => { queries.push(query); return []; },
    get: async (query) => { queries.push(query); return null; }
  });
  for (const url of ["https://seller.ozon.ru.evil.example/", "http://seller.ozon.ru/", "https://ozon.ru/", "invalid"]) {
    const result = await readCookies(url);
    assert.equal(result.header, "");
    assert.equal(result.companyId, "");
  }
  assert.ok(queries.every((query) => query.url === "https://seller.ozon.ru/"));
});

function loadEntrypoint(fetchImpl) {
  let timer;
  let timeoutMs;
  let clearCount = 0;
  const request = loadFunction(collectorSource, "  async function fetchOzonEntrypoint(", "  function parseVariantsFromAspects", "fetchOzonEntrypoint", {
    global: { location: { origin: "https://www.ozon.ru" } },
    fetch: fetchImpl,
    AbortController,
    setTimeout: (callback, delay) => { timer = callback; timeoutMs = delay; return 1; },
    clearTimeout: (id) => { assert.equal(id, 1); clearCount += 1; }
  });
  return { request, expire: () => timer(), timeoutMs: () => timeoutMs, clearCount: () => clearCount };
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

test("entrypoint requests preserve credentials and clear the timer after JSON finishes", async () => {
  let captured;
  let finishBody;
  let started;
  const bodyStarted = new Promise((resolve) => { started = resolve; });
  const harness = loadEntrypoint(async (url, options) => {
    captured = { url, options };
    return { ok: true, json: () => new Promise((resolve) => { finishBody = resolve; started(); }) };
  });
  const pending = harness.request("/product/123/");
  await bodyStarted;
  assert.equal(harness.timeoutMs(), 15000);
  assert.equal(harness.clearCount(), 0);
  assert.equal(captured.options.credentials, "include");
  assert.ok(captured.url.endsWith("?url=%2Fproduct%2F123%2F"));
  finishBody({ widgetStates: {} });
  const result = await pending;
  assert.deepEqual(result.data, { widgetStates: {} });
  assert.equal(harness.clearCount(), 1);
});

for (const phase of ["fetch", "body"]) {
  test(`entrypoint ${phase} stalls abort after 15 seconds`, async () => {
    let signal;
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const harness = loadEntrypoint(async (url, options) => {
      signal = options.signal;
      if (phase === "fetch") { started(); return waitForAbort(signal); }
      return { ok: true, json: () => { started(); return waitForAbort(signal); } };
    });
    const pending = harness.request("/product/123/");
    await requestStarted;
    assert.equal(harness.timeoutMs(), 15000);
    harness.expire();
    await assert.rejects(pending, /Ozon entrypoint.*timed out/);
    assert.equal(signal.aborted, true);
    assert.equal(harness.clearCount(), 1);
  });
}

test("entrypoint HTTP failures retain their status and clear the timer", async () => {
  const harness = loadEntrypoint(async () => ({ ok: false, status: 403 }));
  await assert.rejects(harness.request("/product/123/"), /Ozon entrypoint failed 403/);
  assert.equal(harness.clearCount(), 1);
});

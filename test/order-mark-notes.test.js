import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server, useOrdersPage, fetchHandler;
const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function storage() {
  const values = new Map([["erpPerfMonitor", "off"]]);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

before(async () => {
  // Resolve the real frontend modules (including extensionless imports) through
  // Vite. Only the browser environment and HTTP transport are test doubles.
  await import("element-plus");
  let timer = 0;
  globalThis.window = { location: { hash: "#/orders", pathname: "/admin.html" }, localStorage: storage(), sessionStorage: storage(),
    addEventListener() {}, setTimeout: () => ++timer, clearTimeout() {} };
  globalThis.fetch = (url, options) => String(url).startsWith("/api/orders/inventory-availability?")
    ? Promise.resolve(json({ rows: [] })) : fetchHandler(String(url), options);
  server = await createServer({ configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ useOrdersPage } = await server.ssrLoadModule("/frontend/orders/composables/useOrdersPage.js"));
});

after(async () => {
  await server?.close();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  globalThis.fetch = previousFetch;
});

test("the real composable forwards Unicode and multiline notes through orders-service PUT", async () => {
  const calls = [];
  fetchHandler = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return json({ ok: true, id: 41, ...JSON.parse(options.body) });
  };
  const page = useOrdersPage();
  const note = "客户要求周五再发货 🚚\n核对外包装：不要折叠\nПримечание: хрупкое";
  const result = await page.saveOrderMark(41, "follow", note);
  assert.deepEqual(calls, [{ url: "/api/orders/41/mark", method: "PUT", body: { mark_type: "follow", note } }]);
  assert.equal(result.note, note);
});

test("empty notes and clearing the mark remain explicit in the real PUT payload", async () => {
  const calls = [];
  fetchHandler = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return json({ ok: true, ...JSON.parse(options.body) });
  };
  const page = useOrdersPage();
  await page.saveOrderMark(41, "special", "");
  await page.saveOrderMark(41, "", "");
  await page.saveOrderMark(41, "urgent");
  assert.deepEqual(calls.map((call) => call.body), [
    { mark_type: "special", note: "" }, { mark_type: "", note: "" }, { mark_type: "urgent", note: "" }
  ]);
});

test("a successful note change or clear removes the old list snapshot before a delayed reload", async () => {
  for (const [suffix, note] of [["updated", "已与客户确认\n等待补件"], ["cleared", ""]]) {
    const page = useOrdersPage();
    page.vm.filters.searchQuery = `mark-note-success-${suffix}`;
    fetchHandler = async (url) => url === "/api/shops" ? json([]) : json({ rows: [{ id: 41, mark_type: "follow", mark_note: "旧备注" }], total: 1 });
    await page.loadOrders();
    assert.equal(page.vm.rows[0].mark_note, "旧备注");
    fetchHandler = async (_url, options) => json({ ok: true, ...JSON.parse(options.body) });
    await page.saveOrderMark(41, "follow", note);

    const nextList = deferred();
    fetchHandler = async (url) => url === "/api/shops" ? json([]) : nextList.promise;
    const reopened = useOrdersPage();
    reopened.vm.filters = { ...page.vm.filters };
    const reload = reopened.loadOrders();
    assert.equal(reopened.vm.rows.length, 0, "reopening must not paint the pre-save cached note while the GET is pending");
    nextList.resolve(json({ rows: [{ id: 41, mark_type: "follow", mark_note: note }], total: 1 }));
    await reload;
    assert.equal(reopened.vm.rows[0].mark_note, note);
  }
});

test("a failed PUT rejects without changing the visible note or discarding its cached list", async () => {
  const page = useOrdersPage();
  page.vm.filters.searchQuery = "mark-note-rejected";
  fetchHandler = async (url) => url === "/api/shops" ? json([]) : json({ rows: [{ id: 41, mark_type: "follow", mark_note: "已保存备注" }], total: 1 });
  await page.loadOrders();
  let writes = 0;
  fetchHandler = async (_url, options) => {
    assert.equal(options.method, "PUT");
    writes++;
    return json({ error: "备注保存失败" }, 500);
  };
  await assert.rejects(page.saveOrderMark(41, "issue", "未保存的新备注"), /备注保存失败/);
  assert.equal(writes, 1);
  assert.equal(page.vm.rows[0].mark_note, "已保存备注");
  assert.equal(page.vm.rows[0].mark_type, "follow");

  const nextList = deferred();
  fetchHandler = async (url) => url === "/api/shops" ? json([]) : nextList.promise;
  const reopened = useOrdersPage();
  reopened.vm.filters = { ...page.vm.filters };
  const reload = reopened.loadOrders();
  assert.equal(reopened.vm.rows[0]?.mark_note, "已保存备注", "a failed mutation must leave the last successful list cache available");
  nextList.resolve(json({ rows: [{ id: 41, mark_type: "follow", mark_note: "已保存备注" }], total: 1 }));
  await reload;
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";

const exec = promisify(execFile);
const appSource = readFileSync(new URL("../frontend/admin/App.vue", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/analytics/SellerAnalyticsView.vue", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function metadataFixture(capabilities, policy = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ozon-unified-release-"));
  try {
    for (const [name, version] of [["ozon-erp-collector-plugin", "1.5.0"], ["pivot-table-master", "1.0.41"], ["pdd-procurement-logistics-plugin", "1.0.2"]]) {
      await fs.mkdir(path.join(directory, name));
      await fs.writeFile(path.join(directory, name, "manifest.json"), JSON.stringify({ version }), "utf8");
    }
    if (capabilities !== undefined) await fs.writeFile(path.join(directory, "ozon-erp-collector-plugin/capabilities.json"), JSON.stringify(capabilities), "utf8");
    await fs.mkdir(path.join(directory, "data"));
    const old = { version: "1.4.9", package_name: "old.zip", download_url: "/downloads/old.zip", mandatory: true, ...policy };
    await fs.writeFile(path.join(directory, "data/global-update-status.json"), JSON.stringify({ plugin: old, analytics_plugin: old }), "utf8");
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
      const { globalUpdateStatus } = await import(process.argv[1]);
      console.log(JSON.stringify(['1.3.0','1.4.0','1.5.0','1.6.0'].map(version => globalUpdateStatus({plugin_version:version,analytics_plugin_version:version}))));
    `, new URL("../src/server/notifications.js", import.meta.url).href], {
      cwd: directory,
      env: { ...process.env, COLLECTOR_PLUGIN_VERSION: "1.0.0", ANALYTICS_PLUGIN_VERSION: "0.1.0", COLLECTOR_PLUGIN_DOWNLOAD_URL: "/stale.zip", ANALYTICS_PLUGIN_DOWNLOAD_URL: "/stale-analysis.zip" }
    });
    return JSON.parse(stdout);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith("ozon-unified-release-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("explicit unified capabilities pin both update domains to the same manifest and package", async () => {
  const [status] = await metadataFixture({ collector: true, sellerAnalytics: true });
  for (const domain of [status.plugin, status.analytics_plugin]) {
    assert.equal(domain.version, "1.5.0");
    assert.equal(domain.package_name, "ozon-baodan-erp-plugin-1.5.0.zip");
    assert.equal(domain.download_url, "/downloads/ozon-baodan-erp-plugin-1.5.0.zip");
    assert.equal(domain.unified, true);
    assert.equal(domain.mandatory, false);
  }
});

test("missing or partial capabilities preserve standalone update metadata", async () => {
  for (const capabilities of [undefined, { collector: true, sellerAnalytics: "true" }]) {
    const [status] = await metadataFixture(capabilities);
    assert.equal(status.plugin.version, "1.4.9");
    assert.equal(status.analytics_plugin.version, "1.0.41");
    assert.equal(status.analytics_plugin.package_name, "ozon-seller-analytics-plugin-1.0.41.zip");
    assert.equal(status.plugin.unified, undefined);
  }
});

test("unified releases retain explicit system-bug minimums without forcing compatible or future clients", async () => {
  const statuses = await metadataFixture({ collector: true, sellerAnalytics: true }, {
    minimum_supported_version: "1.4.0", update_reason_type: "system_bug", update_reason: "A documented system bug."
  });
  for (const key of ["plugin", "analytics_plugin"]) {
    assert.equal(statuses[0][key].update_required, true);
    assert.equal(statuses[1][key].update_available, true);
    for (const status of statuses.slice(1)) assert.equal(status[key].update_required, false);
    assert.equal(statuses[3][key].update_available, false);
  }
});

test("unversioned aliases resolve the unified archive while explicit standalone versions retain their file", async () => {
  const source = serverSource.slice(serverSource.indexOf("async function resolveDownloadArtifactPath("), serverSource.indexOf("\nconst routeModules ="));
  const canonical = "ozon-baodan-erp-plugin-1.5.0.zip";
  const resolve = new Function("fs", "path", "globalUpdateStatus", `${source}; return resolveDownloadArtifactPath;`)(
    { access: async file => {
      if (![canonical, "ozon-seller-analytics-plugin-1.0.41.zip", "ozon-seller-analytics-plugin.zip"].some(name => file === path.resolve("dist", name))) throw new Error("Missing fixture");
    } }, path, () => ({ plugin: { unified: true, package_name: canonical } })
  );
  for (const alias of ["ozon-baodan-erp-plugin.zip", "ozon-erp-collector-plugin.zip", "ozon-seller-analytics-plugin.zip"]) {
    assert.equal(await resolve(alias), path.resolve("dist", canonical));
  }
  assert.equal(await resolve("ozon-seller-analytics-plugin-1.0.41.zip"), path.resolve("dist", "ozon-seller-analytics-plugin-1.0.41.zip"));
});

function appHarness(get) {
  const calls = [], events = [], posted = [];
  let scope = "scope-a";
  const window = { location: { origin: "https://erp.test" }, postMessage: data => posted.push(data), dispatchEvent: event => events.push(event) };
  const source = appSource.slice(appSource.indexOf("async function syncAnalyticsPluginUpdate"), appSource.indexOf("\nuseGlobalImagePreviewDismiss();"));
  const functions = new Function("apiClient", "window", "CustomEvent", "currentApiCacheScope", "authStore", `${source}; return {syncAnalyticsPluginUpdate,handleAnalyticsPluginInstanceMessage,resetAnalyticsPluginIdentity};`)(
    { get: async url => { calls.push(url); return get(url); } }, window,
    class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    () => scope, { isAuthenticated: true }
  );
  return {
    calls, events, posted, ...functions,
    scope(value) { scope = value; },
    announce(id, version = "1.5.0", unified = true, origin = window.location.origin) {
      functions.handleAnalyticsPluginInstanceMessage({ source: window, origin, data: {
        type: "BAODAN_ANALYTICS_PLUGIN_INSTANCE", pluginInstanceId: id, pluginVersion: version,
        ...(unified ? { capabilities: { collector: true, sellerAnalytics: true } } : {})
      } });
    }
  };
}

test("App never queries legacy status without a live instance and prefers actual unified manifest identity", async () => {
  const app = appHarness(url => url.includes("plugin-status")
    ? { plugin_version: "1.0.41" }
    : { analytics_plugin: { version: "1.5.0", update_available: false } });
  const status = { analytics_plugin: { version: "1.5.0" } };
  await app.syncAnalyticsPluginUpdate(status);
  assert.equal(app.calls.length, 0);
  assert.equal(app.posted[0].type, "BAODAN_ANALYTICS_PLUGIN_INSTANCE_REQUEST");
  app.announce("unified-instance"); await tick();
  assert.match(app.calls[0], /plugin_instance_id=unified-instance/);
  assert.match(app.calls[1], /analytics_plugin_version=1\.5\.0/);
  const calls = app.calls.length;
  app.announce("late-standalone", "1.0.41", false); await tick();
  app.announce("foreign-instance", "1.5.0", true, "https://foreign.test"); await tick();
  assert.equal(app.calls.length, calls);
});

test("App discards a late old-instance result and invalidates identity across enterprise scopes", async () => {
  let resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const app = appHarness(url => url.includes("plugin_instance_id=old") ? old
    : url.includes("plugin-status") ? { plugin_version: "1.5.0" }
    : { analytics_plugin: { version: "1.5.0", update_available: false } });
  await app.syncAnalyticsPluginUpdate({ analytics_plugin: { version: "1.5.0" } });
  app.announce("old", "1.0.41", false);
  app.announce("new", "1.5.0", true); await tick();
  resolveOld({ plugin_version: "1.0.41" }); await tick();
  assert.equal(app.calls.some(url => url.includes("analytics_plugin_version=1.0.41")), false);
  app.scope("scope-b");
  const count = app.calls.length;
  await app.syncAnalyticsPluginUpdate({ analytics_plugin: { version: "1.5.0" } });
  assert.equal(app.calls.length, count);
});

function viewHarness() {
  const listeners = new Set(), posted = [], timers = new Map();
  let timer = 0, resolveOld;
  const old = new Promise(resolve => { resolveOld = resolve; });
  const window = {
    location: { origin: "https://erp.test" },
    addEventListener: (_type, callback) => listeners.add(callback),
    removeEventListener: (_type, callback) => listeners.delete(callback),
    setTimeout: callback => { timers.set(++timer, callback); return timer; },
    clearTimeout: id => timers.delete(id), postMessage: data => posted.push(data)
  };
  const context = vm.createContext({ window,
    pluginInstanceId: { value: "" }, pluginInstanceUnified: false, pluginInstanceEpoch: 0,
    pendingPluginStoreChecks: new Set(), pluginStatus: { value: null }, pluginValidation: { value: null },
    selectedStoreId: { value: "company" }, state: { filters: { shopId: "1" } }, selectedShop: { value: { name: "Shop" } },
    getSellerAnalyticsPluginStatus: query => query.plugin_instance_id === "old" ? old : Promise.resolve({ plugin_instance_id: query.plugin_instance_id }),
    validateSellerAnalyticsPluginStatus: query => Promise.resolve({ plugin_instance_id: query.plugin_instance_id })
  });
  const functions = [
    viewSource.slice(viewSource.indexOf("async function loadPluginStatus("), viewSource.indexOf("async function loadAuthBindingStatus(")),
    viewSource.slice(viewSource.indexOf("async function loadPluginValidation("), viewSource.indexOf("async function loadActiveMetaPane(")),
    viewSource.slice(viewSource.indexOf("function wakeAnalyticsPlugin("), viewSource.indexOf("async function ensureCollectReady(")),
    viewSource.slice(viewSource.indexOf("function handlePluginInstanceMessage("), viewSource.indexOf("function requestPluginInstance("))
  ];
  vm.runInContext(functions.join("\n"), context);
  const message = data => ({ source: window, origin: window.location.origin, data });
  return { context, posted, timers,
    resolveOld,
    announce(id, unified) { context.handlePluginInstanceMessage(message({ type: "BAODAN_ANALYTICS_PLUGIN_INSTANCE", pluginInstanceId: id,
      ...(unified ? { capabilities: { collector: true, sellerAnalytics: true } } : {}) })); },
    result(request, instance, result = { ok: true }) {
      for (const listener of [...listeners]) listener(message({ type: "BAODAN_ANALYTICS_PLUGIN_CHECK_STORE_RESULT", requestId: request.requestId, pluginInstanceId: instance, result }));
    }
  };
}

test("analysis view replaces an old instance safely and cancels old checks and stale API results", async () => {
  const view = viewHarness(); view.announce("old", false);
  const check = view.context.checkCurrentShopViaPlugin("company");
  view.announce("unified", true);
  assert.equal(await check, null);
  assert.equal(view.timers.size, 0);
  view.resolveOld({ plugin_instance_id: "old" }); await tick();
  assert.equal(view.context.pluginStatus.value.plugin_instance_id, "unified");
  view.announce("late-old", false);
  assert.equal(view.context.pluginInstanceId.value, "unified");
  assert.equal(view.posted.find(message => message.type === "BAODAN_ANALYTICS_PLUGIN_WAKE").pluginInstanceId, "old");
  assert.equal(view.posted.at(-1).pluginInstanceId, "unified");
});

test("unified shop checks require the selected response identity while old standalone responses stay compatible", async () => {
  const view = viewHarness(); view.announce("unified", true);
  let settled = false;
  const check = view.context.checkCurrentShopViaPlugin("company").then(result => { settled = true; return result; });
  const request = view.posted.at(-1);
  view.result(request, undefined); view.result(request, "old"); await tick();
  assert.equal(settled, false);
  view.result(request, "unified");
  assert.equal((await check).ok, true);
  const legacy = viewHarness(); legacy.announce("old", false);
  const oldCheck = legacy.context.checkCurrentShopViaPlugin("company");
  legacy.result(legacy.posted.at(-1), undefined);
  assert.equal((await oldCheck).ok, true);
  legacy.resolveOld({ plugin_instance_id: "old" });
});

test("unmount invalidates pending readiness checks before cancelling their listener", async () => {
  const view = viewHarness(); view.announce("unified", true);
  const epoch = view.context.pluginInstanceEpoch;
  const check = view.context.checkCurrentShopViaPlugin("company");
  let unmount;
  Object.assign(view.context, { onBeforeUnmount: callback => { unmount = callback; }, stopPolling() {}, stopPluginPolling() {} });
  vm.runInContext(viewSource.slice(viewSource.indexOf("onBeforeUnmount(() =>"), viewSource.indexOf("onActivated(() =>")), view.context);
  unmount();
  assert.equal(await check, null);
  assert.equal(view.context.pluginInstanceEpoch, epoch + 1);
});

test("download menu exposes one canonical entry and labels the latest server version", async () => {
  const source = layoutSource.slice(layoutSource.indexOf("const pluginDownloadRelease"), layoutSource.indexOf("const routeSwitching"));
  const menu = new Function("ref", "computed", "apiClient", "currentApiCacheScope", `${source}; return {pluginDownloadLinks,loadPluginDownloadRelease};`)(
    value => ({ value }), read => ({ get value() { return read(); } }),
    { get: async () => ({ plugin: { version: "1.5.0", download_url: "/downloads/ozon-baodan-erp-plugin-1.5.0.zip" } }) }, () => "scope"
  );
  await menu.loadPluginDownloadRelease();
  assert.equal(menu.pluginDownloadLinks.value.length, 1);
  assert.match(menu.pluginDownloadLinks.value[0].label, /最新 v1\.5\.0/);
  assert.equal(menu.pluginDownloadLinks.value[0].url, "/downloads/ozon-baodan-erp-plugin-1.5.0.zip");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const backgroundSource = () => fs.readFileSync("pivot-table-master/background.js", "utf8");
const manifest = () => JSON.parse(fs.readFileSync("pivot-table-master/manifest.json", "utf8"));
const popupSource = () => fs.readFileSync("pivot-table-master/popup.js", "utf8");
const popupHtml = () => fs.readFileSync("pivot-table-master/popup.html", "utf8");
const erpInstanceSource = () => fs.readFileSync("pivot-table-master/content/erp-instance.js", "utf8");

test("seller analytics polling stays low frequency and avoids forced status sync", () => {
  const source = backgroundSource();
  assert.match(source, /const POLL_INTERVAL_MS = 60000/);
  assert.match(source, /const PREPARE_POLL_INTERVAL_MS = 60000/);
  assert.match(source, /const PLUGIN_STATUS_SYNC_MIN_INTERVAL_MS = 30000/);
  assert.match(source, /const AUTH_BINDING_SYNC_MIN_INTERVAL_MS = 300000/);
  assert.match(source, /await syncPluginStatus\(\)\.catch/);
  const nextRequestsSource = source.match(/async function getNextCollectRequests\(\)[\s\S]*?async function getNextPrepareRequest/)?.[0] || "";
  assert.doesNotMatch(nextRequestsSource, /syncPluginStatus\(true\)/);
});

test("pivot analytics plugin defaults to hosted ERP and supports local plugin token", () => {
  const source = backgroundSource();

  assert.match(source, /const DEFAULT_ERP_BASE_URL = 'https:\/\/erp\.hjt888\.xyz'/);
  assert.match(source, /const LOCAL_PLUGIN_TOKEN_KEY = 'pivot-erp-local-plugin-token'/);
  assert.match(source, /const LOCAL_MIRROR_BASE_URL_KEY = 'pivot-erp-local-mirror-base-url'/);
  assert.match(source, /const DEFAULT_LOCAL_PLUGIN_TOKEN = 'ozon-erp-collector-hjt888-default'/);
  assert.match(source, /const DEFAULT_LOCAL_MIRROR_BASE_URL = 'http:\/\/127\.0\.0\.1:8788'/);
  assert.match(source, /function localPluginHeaders/);
  assert.match(source, /async function mirrorSnapshotToLocal/);
  assert.match(source, /headers\['x-local-plugin-token'\] = config\.localPluginToken/);
});

test("pivot analytics plugin polling starts only after explicit user enablement", () => {
  const source = backgroundSource();

  assert.doesNotMatch(source, /stored\[POLLING_ENABLED_KEY\] !== false/);
  assert.equal((source.match(/stored\[POLLING_ENABLED_KEY\] === true/g) || []).length, 2);
});

test("pivot analytics plugin wakes on an ERP collection event and sleeps after draining", () => {
  const background = backgroundSource();
  const bridge = erpInstanceSource();

  assert.match(bridge, /BAODAN_ANALYTICS_PLUGIN_WAKE/);
  assert.match(bridge, /PIVOT_ERP_COLLECT_WAKE/);
  assert.match(background, /async function drainCollectQueue\(\)/);
  assert.match(background, /while \(await pollCollectOnce\(\)\)/);
  assert.match(background, /message\?\.type === 'PIVOT_ERP_COLLECT_WAKE'/);
});

test("pivot analytics plugin claims collect tasks for the current Ozon store only", () => {
  const source = backgroundSource();

  assert.match(source, /const companyId = currentSellerCompanyId\(sellerTab\?\.id\) \|\| panelState\.currentCompanyId \|\| ''/);
  assert.match(source, /params\.set\('store_id', companyId\)/);
  assert.match(source, /params\.set\('company_id', companyId\)/);
});

test("pivot analytics plugin locks preparation to one fresh seller tab identity", () => {
  const source = backgroundSource();

  assert.match(source, /let prepareSellerTabId = 0/);
  assert.match(source, /latestContextHeadersByTab\.delete\(tab\.id\)/);
  assert.match(source, /Number\(context\?\.updated_at \|\| 0\) < prepareStartedAt/);
  assert.match(source, /const observedCompanyId = String\(currentSellerCompanyId\(tab\?\.id\) \|\| ''\)\.trim\(\)/);
  assert.doesNotMatch(source, /const observedCompanyId = String\(currentSellerCompanyId\(tab\?\.id\) \|\| cookieInfo\.companyId/);
  assert.match(source, /if \(!authContext\.success\)/);
});

test("pivot analytics plugin saves authorization only after a successful probe", () => {
  const source = backgroundSource();
  const probeIndex = source.indexOf('const probe = await probeServerSideAuth(companyId, tab)');
  const bindIndex = source.indexOf('const binding = await bindServerSideAuth(companyId, tab, true)', probeIndex);

  assert.ok(probeIndex >= 0);
  assert.ok(bindIndex > probeIndex);
});

test("pivot analytics plugin blocks collection while preparing or when task store differs", () => {
  const source = backgroundSource();

  assert.match(source, /if \(polling \|\| preparing\) return/);
  assert.match(source, /requestStoreId !== currentCompanyId/);
  assert.match(source, /STORE_CONTEXT_MISMATCH task=/);
});

test("pivot analytics plugin popup exposes token configuration", () => {
  assert.match(popupHtml(), /id="localPluginToken"/);
  assert.match(popupHtml(), /id="localMirrorBaseUrl"/);
  assert.match(popupHtml(), /id="pageStatus"/);
  assert.match(popupHtml(), /id="taskStatus"/);
  assert.match(popupHtml(), /id="serviceStatusHint"/);
  assert.match(popupSource(), /localPluginToken: document\.getElementById\('localPluginToken'\)/);
  assert.match(popupSource(), /localMirrorBaseUrl: document\.getElementById\('localMirrorBaseUrl'\)/);
  assert.match(popupSource(), /pageStatus: document\.getElementById\('pageStatus'\)/);
  assert.match(popupSource(), /taskStatus: document\.getElementById\('taskStatus'\)/);
  assert.match(popupSource(), /localPluginToken: els\.localPluginToken\.value/);
  assert.match(popupSource(), /localMirrorBaseUrl: els\.localMirrorBaseUrl\.value/);
  assert.match(popupSource(), /els\.serviceStatusHint\.textContent = 'https:\/\/erp\.hjt888\.xyz\/'/);
});

test("pivot analytics plugin manifest keeps premium analytics injector enabled", () => {
  const contentScripts = Array.isArray(manifest().content_scripts) ? manifest().content_scripts : [];
  const injectedFiles = contentScripts.flatMap((item) => Array.isArray(item.js) ? item.js : []);

  assert.ok(injectedFiles.includes("content/ozon.js"));
  assert.ok(injectedFiles.includes("content/erp-relay-page.js"));
  assert.ok(injectedFiles.includes("content/erp-relay-bridge.js"));
  assert.ok(injectedFiles.includes("content/erp-instance.js"));
});

test("pivot analytics plugin scopes heartbeat and preparation to its extension instance", () => {
  const source = backgroundSource();
  assert.match(source, /plugin_instance_id: chrome\.runtime\.id/);
  assert.match(source, /new URLSearchParams\(\{ plugin_instance_id: chrome\.runtime\.id \}\)/);
});

test("pivot analytics plugin pairs itself with the active trusted ERP origin", () => {
  const background = backgroundSource();
  const bridge = erpInstanceSource();

  assert.match(bridge, /PIVOT_ERP_PAIR_ORIGIN/);
  assert.match(bridge, /erpBaseUrl: window\.location\.origin/);
  assert.match(bridge, /\^192\\\.168\\\./);
  assert.match(background, /message\?\.type === 'PIVOT_ERP_PAIR_ORIGIN'/);
  assert.match(background, /requestedOrigin !== normalizeErpBaseUrl\(senderOrigin\)/);
  assert.match(background, /pollPrepareOnce\(\)/);
});

test("pivot analytics plugin fast-binds an already aligned seller store", () => {
  const source = backgroundSource();
  const fastPathIndex = source.indexOf('fast_path: true');
  const warmupIndex = source.indexOf('const warmup = await warmSellerAnalyticsPermission', fastPathIndex);

  assert.ok(fastPathIndex >= 0);
  assert.ok(warmupIndex > fastPathIndex);
  assert.match(source, /existingCompanyId === expectedStoreId/);
  assert.match(source, /快速完成授权绑定/);
});

test("pivot analytics plugin includes parent-domain cookies used by Seller", () => {
  const source = backgroundSource();
  assert.match(source, /chrome\.cookies\.getAll\(\{ url: 'https:\/\/seller\.ozon\.ru\/' \}\)/);
  assert.doesNotMatch(source, /chrome\.cookies\.getAll\(\{ domain: 'seller\.ozon\.ru' \}\)/);
});

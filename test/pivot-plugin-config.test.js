import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const backgroundSource = () => fs.readFileSync("pivot-table-master/background.js", "utf8");
const manifest = () => JSON.parse(fs.readFileSync("pivot-table-master/manifest.json", "utf8"));
const popupSource = () => fs.readFileSync("pivot-table-master/popup.js", "utf8");
const popupHtml = () => fs.readFileSync("pivot-table-master/popup.html", "utf8");

test("pivot analytics plugin defaults to hosted ERP and supports local plugin token", () => {
  const source = backgroundSource();

  assert.match(source, /const DEFAULT_ERP_BASE_URL = 'https:\/\/erp\.hjt888\.xyz'/);
  assert.match(source, /const LOCAL_PLUGIN_TOKEN_KEY = 'pivot-erp-local-plugin-token'/);
  assert.match(source, /const LOCAL_MIRROR_BASE_URL_KEY = 'pivot-erp-local-mirror-base-url'/);
  assert.match(source, /const DEFAULT_LOCAL_PLUGIN_TOKEN = 'ozon-erp-collector-hjt888-default'/);
  assert.match(source, /const DEFAULT_LOCAL_MIRROR_BASE_URL = 'http:\/\/127\.0\.0\.1:8787'/);
  assert.match(source, /function localPluginHeaders/);
  assert.match(source, /async function mirrorSnapshotToLocal/);
  assert.match(source, /headers\['x-local-plugin-token'\] = config\.localPluginToken/);
});

test("pivot analytics plugin polling is enabled by default unless manually paused", () => {
  const source = backgroundSource();

  assert.match(source, /panelState\.pollingEnabled = stored\[POLLING_ENABLED_KEY\] !== false/);
});

test("pivot analytics plugin claims collect tasks for the current Ozon store only", () => {
  const source = backgroundSource();

  assert.match(source, /const companyId = currentSellerCompanyId\(sellerTab\?\.id\) \|\| panelState\.currentCompanyId \|\| ''/);
  assert.match(source, /params\.set\('store_id', companyId\)/);
  assert.match(source, /params\.set\('company_id', companyId\)/);
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
});

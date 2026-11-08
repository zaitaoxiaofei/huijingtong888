import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'pivot-table-master');
const targetDir = path.join(root, 'ozon-erp-collector-plugin', 'analytics');

function replaceSection(source, start, end, replacement) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Analytics sync anchor missing: ${start}`);
  return source.slice(0, from) + replacement + source.slice(to);
}

let background = await fs.readFile(path.join(sourceDir, 'background.js'), 'utf8');
background = replaceSection(background, 'async function getErpConfig(', 'function localPluginHeaders(', `async function getErpConfig() {
  const config = await global.OzonUnifiedConfig.get();
  rememberPluginToken(config.localPluginToken);
  return config;
}

async function saveErpConfig(patch = {}) {
  if (patch.localPluginToken !== undefined) await global.OzonUnifiedConfig.saveKey(patch.localPluginToken);
  return getErpConfig();
}

`);
background = replaceSection(background, 'function setActionBadge(', 'function updateActionBadge(', `function setActionBadge(text, color) {
  global.OzonUnifiedRuntime.setAnalyticsBadge({ text, color });
}

`);
const legacyCookieInfo = background.slice(background.indexOf('async function getOzonCookieInfo('), background.indexOf('function rememberPluginToken('))
  .replace('async function getOzonCookieInfo(', 'async function getLegacyOzonCookieInfo(');
background = replaceSection(background, 'async function getOzonCookieInfo(', 'function rememberPluginToken(', `${legacyCookieInfo}async function getOzonCookieInfo(tab = null) {
  if (!global.OzonSellerCookieContext?.read) return getLegacyOzonCookieInfo(tab);
  const pageIdentity = await readSellerPageCompanyId(tab);
  const context = await global.OzonSellerCookieContext.read(tab, { pageCompanyId: String(pageIdentity.companyId || '').trim() });
  const conflict = context.code === 'STORE_CONTEXT_MISMATCH';
  const cookies = conflict ? [] : (Array.isArray(context.cookies) ? context.cookies : []);
  return {
    header: cookies.filter(item => item?.name).map(item => \`\${item.name}=\${item.value || ''}\`).join('; '),
    companyId: conflict ? '' : String(context.companyId || '').trim(),
    storeId: context.storeId || '',
    code: context.code || '',
    diagnosticCode: context.diagnosticCode || ''
  };
}

`);
background = replaceSection(background, 'async function ensureSellerAnalyticsGraphsTab(', 'async function warmSellerAnalyticsPermission(', `function parseSellerNavigationTarget(targetUrl) {
  let target;
  try { target = new URL(targetUrl); } catch (error) { throw new Error('SELLER_NAVIGATION_TARGET_NOT_ALLOWED'); }
  if (target.origin !== 'https://seller.ozon.ru') throw new Error('SELLER_NAVIGATION_TARGET_NOT_ALLOWED');
  return target;
}

async function ensureSellerAnalyticsGraphsTab(targetUrl = 'https://seller.ozon.ru/app/analytics/graphs', preferredTab = null) {
  parseSellerNavigationTarget(targetUrl);
  let tab = preferredTab || await findAnySellerTab();
  if (!tab?.id) tab = await chrome.tabs.create({ url: targetUrl, active: true });
  if (!tab?.id) {
    panelState.sellerTab = null;
    panelState.sellerMissing = true;
    updateActionBadge();
    return tab;
  }
  const loaded = await navigateSellerTab(tab.id, targetUrl, 'open_analytics');
  panelState.sellerTab = { id: loaded.id, title: loaded.title || '', url: loaded.url || '' };
  panelState.sellerMissing = false;
  updateActionBadge();
  return loaded;
}

async function sellerDocumentReady(tab, targetUrl, notBefore = 0) {
  if (!tab?.id || tab.pendingUrl) return false;
  try {
    const target = parseSellerNavigationTarget(targetUrl);
    const actual = new URL(tab.url);
    if (actual.origin !== target.origin || actual.pathname.replace(/\\/+$/, '') !== target.pathname.replace(/\\/+$/, '')) return false;
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      injectImmediately: true,
      args: [target.origin, target.pathname.replace(/\\/+$/, ''), notBefore],
      func: (origin, pathname, since) => ({
        ready: location.origin === origin && location.pathname.replace(/\\/+$/, '') === pathname &&
          ['interactive', 'complete'].includes(document.readyState) && performance.timeOrigin >= since
      })
    });
    return result?.[0]?.result?.ready === true;
  } catch (error) { return false; }
}

async function navigateSellerTab(tabId, targetUrl, stage) {
  try {
    const target = parseSellerNavigationTarget(targetUrl);
    const matchesTarget = value => {
      try {
        const actual = new URL(value);
        return actual.origin === target.origin && actual.pathname.replace(/\\/+$/, '') === target.pathname.replace(/\\/+$/, '');
      } catch (error) { return false; }
    };
    const deadline = Date.now() + 15000;
    let tab = await chrome.tabs.get(tabId);
    if (!tab.pendingUrl && matchesTarget(tab.url) && (tab.status === 'complete' || await sellerDocumentReady(tab, targetUrl))) return tab;
    if (!matchesTarget(tab.pendingUrl) && !(tab.status === 'loading' && matchesTarget(tab.url))) {
      await chrome.tabs.update(tabId, { url: targetUrl, active: true });
    }
    while (Date.now() < deadline) {
      tab = await chrome.tabs.get(tabId);
      if (!tab.pendingUrl && matchesTarget(tab.url) && (tab.status === 'complete' || await sellerDocumentReady(tab, targetUrl))) return tab;
      await sleep(250);
    }
    throw new Error('SELLER_NAVIGATION_TIMEOUT state=' + (tab?.status || '-') + ' path=' + (() => { try { return new URL(tab.url).pathname; } catch { return '-'; } })());
  } catch (error) {
    const detail = \`SELLER_NAVIGATION_FAILED stage=\${stage} tab=\${tabId}: \${error?.message || error}\`;
    logPanel(detail, 'error');
    throw new Error(detail);
  }
}

`);
const warmStart = background.indexOf('async function warmSellerAnalyticsPermission(');
const warmEnd = background.indexOf('async function openSellerAnalyticsGraphsAfterWarmup(', warmStart);
let warmSource = background.slice(warmStart, warmEnd);
for (const [timeoutMs, stage] of [[15000, 'warm_analytics'], [20000, 'reload_analytics']]) {
  const before = `  await waitForTabComplete(tabId, ${timeoutMs});`;
  if (!warmSource.includes(before)) throw new Error('Analytics warmup wait anchor missing');
  warmSource = warmSource.replace(before, `  if (!(await waitForTabComplete(tabId, ${timeoutMs}))) {
    const detail = 'SELLER_NAVIGATION_FAILED stage=${stage} tab=' + tabId + ': SELLER_NAVIGATION_TIMEOUT';
    logPanel(detail, 'error');
    throw new Error(detail);
  }`);
}
background = replaceSection(background, 'async function warmSellerAnalyticsPermission(', 'async function openSellerAnalyticsGraphsAfterWarmup(', warmSource);
background = replaceSection(background, 'async function openSellerAnalyticsGraphsAfterWarmup(', 'async function waitForTabComplete(', `async function openSellerAnalyticsGraphsAfterWarmup(tabId, targetUrl) {
  if (!tabId) return null;
  const loaded = await navigateSellerTab(tabId, targetUrl, 'open_graphs');
  panelState.sellerTab = { id: loaded.id, title: loaded.title || '', url: loaded.url || '' };
  panelState.sellerMissing = false;
  updateActionBadge();
  return loaded;
}

`);
background = replaceSection(background, 'async function waitForTabComplete(', 'function expectedStoreIdFromPrepare(', `async function waitForTabComplete(tabId, timeoutMs = 15000, notBefore = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) return false;
    if (!tab.pendingUrl && (notBefore === 0 && tab.status === 'complete' || await sellerDocumentReady(tab, tab.url, notBefore))) return true;
    await sleep(250);
  }
  return false;
}

`);
background = background.replace('    await chrome.tabs.reload(tabId, { bypassCache: true });', '    reloadStartedAt = Date.now();\n    await chrome.tabs.reload(tabId, { bypassCache: true });')
  .replace("  logPanel('销售漏斗页已打开，开始强制刷新以激活分析权限');", "  let reloadStartedAt = 0;\n  logPanel('销售漏斗页已打开，开始强制刷新以激活分析权限');")
  .replace('await waitForTabComplete(tabId, 20000)', 'await waitForTabComplete(tabId, 20000, reloadStartedAt)');
background = background.replace("const ERP_BASE_URL_KEY = 'pivot-erp-base-url';\n", '')
  .replace("const ERP_TENANT_ID_KEY = 'pivot-erp-tenant-id';\n", '')
  .replace("const LOCAL_PLUGIN_TOKEN_KEY = 'pivot-erp-local-plugin-token';\n", '')
  .replace("const stored = await chrome.storage.local.get([PANEL_LOG_HISTORY_KEY, LOCAL_PLUGIN_TOKEN_KEY]);\n  rememberPluginToken(String(stored[LOCAL_PLUGIN_TOKEN_KEY] || '').trim());",
    'const stored = await chrome.storage.local.get([PANEL_LOG_HISTORY_KEY]);\n  await getErpConfig();')
  .replaceAll('response.json().catch(() => null)', "response.json().catch((error) => { if (error?.name === 'AbortError') throw error; return null; })")
  .replaceAll("files: ['content/", "files: ['analytics/content/");
background = replaceSection(background, "  if (message?.type === 'PIVOT_ERP_PAIR_ORIGIN') {", "  if (message?.type === 'PIVOT_ERP_PANEL_GET_STATUS') {", `  if (message?.type === 'PIVOT_ERP_PAIR_ORIGIN') {
    let senderUrl;
    try { senderUrl = new URL(sender?.tab?.url || ''); } catch (error) {}
    const hostname = senderUrl?.hostname || '';
    const trusted = senderUrl?.origin === 'https://erp.hjt888.xyz' || (senderUrl?.protocol === 'http:' && (
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || /^10\\./.test(hostname) || /^192\\.168\\./.test(hostname) || /^172\\.(1[6-9]|2\\d|3[01])\\./.test(hostname)));
    if (!trusted || normalizeErpBaseUrl(message.erpBaseUrl) !== normalizeErpBaseUrl(senderUrl.origin)) {
      sendResponse({ error: 'ERP_ORIGIN_MISMATCH' });
      return false;
    }
    getErpConfig().then(config => sendResponse({ ok: true, config }))
      .catch(() => sendResponse({ error: '企业密钥状态暂不可用，请稍后重试' }));
    return true;
  }
`);
const initialize = 'restorePanelLogsPromise = restorePanelLogs().catch(() => {});';
if (!background.includes(initialize)) throw new Error('Analytics sync initialization anchor missing');
background = background.replace(initialize, `const runPrepareWithoutNavigationGate = runPrepareRequest;
runPrepareRequest = request => global.OzonUnifiedRuntime.withAnalyticsPreparation(() => runPrepareWithoutNavigationGate(request));
global.OzonUnifiedAnalytics = { loaded: true };
${initialize}`);
// Keep operator-facing infrastructure labels consistent with the unified popup.
background = background.replaceAll('ECS 直连', '云端直连');
await fs.mkdir(targetDir, { recursive: true });
const fetchAdapter = `// Keep remote preparation calls from indefinitely holding the shared Seller tab gate.
async function fetch(url, options = {}) {
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
  const abort = () => {
    controller.abort();
    const error = new Error('ERP 请求超时或已取消，请稍后重试');
    error.name = 'AbortError';
    rejectDeadline(error);
  };
  const timer = setTimeout(abort, 15000);
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await Promise.race([global.fetch(url, { ...options, signal: controller.signal }), deadline]);
    const consume = async (method) => {
      try { return await Promise.race([response[method](), deadline]); }
      finally { cleanup(); }
    };
    return { ok: response.ok, status: response.status, json: () => consume('json'), text: () => consume('text') };
  } catch (error) { cleanup(); throw error; }
}
`;
await fs.writeFile(path.join(targetDir, 'background.js'), `// Generated by scripts/sync-unified-analytics.mjs; edit the source or adapter.\n(function initUnifiedAnalytics(global) {\n'use strict';\n${fetchAdapter}\n${background}\n})(globalThis);\n`, 'utf8');

await fs.cp(path.join(sourceDir, 'content'), path.join(targetDir, 'content'), { recursive: true });
await fs.copyFile(path.join(sourceDir, 'LICENSE'), path.join(targetDir, 'LICENSE'));
const instancePath = path.join(targetDir, 'content', 'erp-instance.js');
let instance = await fs.readFile(instancePath, 'utf8');
instance = instance.replace('pluginInstanceId: instanceId,', 'pluginInstanceId: instanceId,\n      capabilities: { collector: true, sellerAnalytics: true, storeDiscovery: instanceId !== chrome.runtime.id, browserInstance: instanceId !== chrome.runtime.id },');
await fs.writeFile(instancePath, instance, 'utf8');
for (const file of ['popup.html', 'popup.js', 'popup.css']) {
  let source = await fs.readFile(path.join(sourceDir, file), 'utf8');
  if (file === 'popup.html') {
    const inputIndex = source.indexOf('id="erpBaseUrl"');
    const sectionStart = source.lastIndexOf('<section', inputIndex);
    if (inputIndex < 0 || sectionStart < 0) throw new Error('Analytics connection section anchor missing');
    source = source.slice(0, sectionStart) + source.slice(sectionStart).replace('<section', '<section hidden style="display:none"');
    source = source.replaceAll('id="erpBaseUrl"', 'id="erpBaseUrl" readonly').replaceAll('id="tenantId"', 'id="tenantId" readonly').replaceAll('id="localPluginToken"', 'id="localPluginToken" readonly');
  }
  if (file === 'popup.css') source += '\n/* The unified popup owns the viewport and scrolling. */\nbody { width: 100%; max-height: none; }\n.panel { max-height: none; overflow: visible; }\n';
  await fs.writeFile(path.join(targetDir, file), source, 'utf8');
}
console.log('Unified analytics runtime and assets synchronized.');

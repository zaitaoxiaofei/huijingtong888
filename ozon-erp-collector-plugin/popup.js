const fields = {
  erpBaseUrl: document.getElementById('erp-base-url'),
  localPluginToken: document.getElementById('local-plugin-token'),
  injectCards: document.getElementById('inject-cards'),
  manualSkus: document.getElementById('manual-skus'),
  status: document.getElementById('status'),
  tokenWarning: document.getElementById('token-warning'),
  pluginUpdateCard: document.getElementById('plugin-update-card'),
  pluginUpdateTitle: document.getElementById('plugin-update-title'),
  pluginUpdateMessage: document.getElementById('plugin-update-message'),
  pluginUpdateDownload: document.getElementById('plugin-update-download'),
  grantOzonAccess: document.getElementById('grant-ozon-access')
};

const erpConfig = window.OzonErpCollectorConfig || {};
const ERP_BASE_URL_STORAGE_KEY = erpConfig.ERP_BASE_URL_STORAGE_KEY || 'ozon-erp-base-url';
const LOCAL_PLUGIN_TOKEN_STORAGE_KEY = erpConfig.LOCAL_PLUGIN_TOKEN_STORAGE_KEY || 'ozon-erp-local-plugin-token';
const DEFAULT_LOCAL_PLUGIN_TOKEN = erpConfig.DEFAULT_LOCAL_PLUGIN_TOKEN || 'ozon-erp-collector-hjt888-default';
const DEFAULT_ERP_BASE_URL = erpConfig.DEFAULT_ERP_BASE_URL || 'https://erp.hjt888.xyz';
const SEND_MESSAGE_TIMEOUT_MS = 8000;
const MANUAL_PROGRESS_STORAGE_KEY = 'ozon-erp-manual-progress';
const PLUGIN_UPDATE_STATUS_STORAGE_KEY = 'ozon-erp-plugin-update-status';
const OZON_PERMISSION_ORIGINS = [
  'https://ozon.ru/*',
  'https://www.ozon.ru/*',
  'https://m.ozon.ru/*',
  'https://ozon.kz/*',
  'https://www.ozon.kz/*',
  'https://m.ozon.kz/*',
  'https://ozon.by/*',
  'https://www.ozon.by/*',
  'https://m.ozon.by/*',
  'https://*.ozon.ru/*',
  'https://*.ozon.kz/*',
  'https://*.ozon.by/*'
];
const manualProgressState = {
  active: false,
  summary: '',
  items: new Map()
};
let pluginUpdateDownloadUrl = '';

function normalizeErpBaseUrl(value) {
  if (typeof erpConfig.normalizeErpBaseUrl === 'function') {
    return erpConfig.normalizeErpBaseUrl(value);
  }
  return DEFAULT_ERP_BASE_URL;
}

function setStatus(text) {
  fields.status.classList.remove('has-detail');
  fields.status.textContent = text || '';
}

function renderTokenWarning() {
  const token = String(fields.localPluginToken.value || '').trim();
  const usesDefaultToken = !token || token === DEFAULT_LOCAL_PLUGIN_TOKEN;
  fields.tokenWarning.classList.toggle('is-visible', usesDefaultToken);
  fields.tokenWarning.textContent = usesDefaultToken
    ? '当前会使用默认回传令牌，适合本机测试。正式环境建议在 ERP 后台和插件中配置一致的专用密钥。'
    : '';
}

function renderPluginUpdate(plugin) {
  const updateRequired = plugin?.update_required === true;
  fields.pluginUpdateCard.classList.toggle('is-visible', updateRequired);
  if (!updateRequired) return;
  pluginUpdateDownloadUrl = String(plugin.download_url || '').trim();
  fields.pluginUpdateTitle.textContent = plugin.title || '爆单ERP插件有新版本';
  fields.pluginUpdateMessage.textContent = plugin.message || '请下载最新版爆单ERP插件并重新安装。';
  fields.pluginUpdateDownload.disabled = !pluginUpdateDownloadUrl;
}

async function loadPluginUpdateStatus() {
  const stored = await chrome.storage.local.get([PLUGIN_UPDATE_STATUS_STORAGE_KEY]);
  renderPluginUpdate(stored?.[PLUGIN_UPDATE_STATUS_STORAGE_KEY]);
  chrome.runtime.sendMessage({ type: 'OZON_ERP_CHECK_PLUGIN_UPDATE' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.success) renderPluginUpdate(response.plugin);
  });
}

function resetManualProgress() {
  manualProgressState.active = false;
  manualProgressState.summary = '';
  manualProgressState.items.clear();
  fields.status.classList.remove('has-detail');
}

function renderManualProgress(summary = manualProgressState.summary || '') {
  manualProgressState.summary = summary;
  const lines = [];
  if (summary) lines.push(summary);
  for (const item of manualProgressState.items.values()) {
    lines.push(item.text);
  }
  fields.status.classList.toggle('has-detail', lines.length > 1 || manualProgressState.items.size > 0);
  fields.status.textContent = lines.filter(Boolean).join('\n');
}

function updateManualProgress(progress) {
  const sku = String(progress?.sku || '').trim();
  if (!sku) return;
  manualProgressState.active = true;
  manualProgressState.items.set(sku, {
    sku,
    status: progress?.status || 'running',
    text: progress?.text || sku
  });
  const total = manualProgressState.items.size;
  const successCount = Array.from(manualProgressState.items.values()).filter((item) => item.status === 'success').length;
  const errorCount = Array.from(manualProgressState.items.values()).filter((item) => item.status === 'error').length;
  const runningCount = Array.from(manualProgressState.items.values()).filter((item) => item.status === 'running').length;
  renderManualProgress(`批量采集中：已完成 ${successCount}，失败 ${errorCount}，采集中 ${runningCount}，共 ${total}`);
}

async function restoreManualProgress() {
  const stored = await chrome.storage.local.get([MANUAL_PROGRESS_STORAGE_KEY]);
  const state = stored?.[MANUAL_PROGRESS_STORAGE_KEY];
  if (!state || typeof state !== 'object') return;
  resetManualProgress();
  manualProgressState.active = state.active === true;
  manualProgressState.summary = String(state.summary || '');
  const items = Array.isArray(state.items) ? state.items : [];
  for (const item of items) {
    const sku = String(item?.sku || '').trim();
    if (!sku) continue;
    manualProgressState.items.set(sku, {
      sku,
      status: String(item?.status || 'pending'),
      text: String(item?.text || sku)
    });
  }
  if (manualProgressState.summary || manualProgressState.items.size > 0) {
    renderManualProgress(manualProgressState.summary);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'OZON_ERP_MANUAL_COLLECT_PROGRESS') return;
  updateManualProgress(message.progress);
});

function isOzonFrontPage(url) {
  try {
    const hostname = new URL(String(url || '')).hostname.toLowerCase();
    return /(^|\.)ozon\.(ru|kz|by)$/i.test(hostname) && !hostname.startsWith('seller.ozon.');
  } catch (error) {
    return false;
  }
}

async function hasOzonAccess() {
  if (!chrome?.permissions?.contains) return true;
  return await chrome.permissions.contains({ origins: OZON_PERMISSION_ORIGINS }).catch(() => false);
}

async function refreshOzonAccessButton() {
  const granted = await hasOzonAccess();
  fields.grantOzonAccess.textContent = granted ? '重新注入 Ozon 页面' : '授权 Ozon 页面访问';
  fields.grantOzonAccess.disabled = false;
}

async function grantOzonAccess() {
  if (!chrome?.permissions?.request) {
    setStatus('当前浏览器不支持插件主动申请站点权限，请在扩展详情里把站点访问权限设为所有站点。');
    return;
  }
  const granted = await chrome.permissions.request({ origins: OZON_PERMISSION_ORIGINS }).catch(() => false);
  await refreshOzonAccessButton();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isOzonFrontPage(tab.url)) {
    setStatus(granted ? 'Ozon 权限已授权。请打开 Ozon 商品页或列表页后再重试。' : 'Edge 没有授予 Ozon 页面访问权限，请在扩展详情里把站点访问权限设为所有站点。');
    return;
  }
  const injected = await chrome.runtime.sendMessage({ type: 'OZON_ERP_INJECT_ACTIVE_OZON_FRONT' }).catch((error) => ({
    success: false,
    error: error?.message || String(error)
  }));
  if (injected?.success) {
    setStatus('已在当前 Ozon 页面注入插件。如果后续页面仍无显示，请在扩展详情里把站点访问权限设为所有站点。');
    return;
  }
  setStatus('Edge 仍然阻止注入。请打开扩展详情，把“站点访问权限”改为“在所有站点上”，然后刷新 Ozon 页面。');
}

async function load() {
  const stored = await chrome.storage.local.get([
    ERP_BASE_URL_STORAGE_KEY,
    LOCAL_PLUGIN_TOKEN_STORAGE_KEY,
    'ozon-erp-inject-cards',
    'ozon-erp-manual-skus'
  ]);
  const normalizedErpBaseUrl = normalizeErpBaseUrl(stored[ERP_BASE_URL_STORAGE_KEY] || DEFAULT_ERP_BASE_URL);
  fields.erpBaseUrl.value = normalizedErpBaseUrl;
  fields.localPluginToken.value = stored[LOCAL_PLUGIN_TOKEN_STORAGE_KEY] || '';
  renderTokenWarning();
  if (stored[ERP_BASE_URL_STORAGE_KEY] !== normalizedErpBaseUrl) {
    await chrome.storage.local.set({ [ERP_BASE_URL_STORAGE_KEY]: normalizedErpBaseUrl });
  }
  fields.injectCards.checked = stored['ozon-erp-inject-cards'] !== false;
  fields.manualSkus.value = stored['ozon-erp-manual-skus'] || '';
  await restoreManualProgress();
  await loadPluginUpdateStatus();
  await refreshOzonAccessButton();
}

async function save() {
  await chrome.storage.local.set({
    [ERP_BASE_URL_STORAGE_KEY]: normalizeErpBaseUrl(fields.erpBaseUrl.value.trim()),
    [LOCAL_PLUGIN_TOKEN_STORAGE_KEY]: fields.localPluginToken.value.trim(),
    'ozon-erp-inject-cards': fields.injectCards.checked,
    'ozon-erp-manual-skus': fields.manualSkus.value.trim()
  });
  renderTokenWarning();
  setStatus('配置已保存，刷新 Ozon 页面后生效');
}

function parseSkus(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,，;；]+/g)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

/** 采集当前页 - 只对当前活跃标签页操作，不做自动查找 */
async function collectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('没有找到当前标签页');
    return;
  }
  if (!isOzonFrontPage(tab.url)) {
    setStatus('请在 Ozon 商品详情页使用此功能');
    return;
  }
  setStatus('正在采集当前页...');
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'OZON_ERP_MANUAL_COLLECT_DETAIL' }).catch((error) => ({
    success: false,
    error: error?.message || String(error)
  }));
  if (response?.success) {
    setStatus(`采集完成：${response.data?.sku || ''}，已打开采集箱`);
  } else {
    setStatus(`采集失败：${response?.error || '当前页不是 Ozon 商品页'}`);
  }
}

async function syncManualSkus() {
  const skus = parseSkus(fields.manualSkus.value);
  if (skus.length === 0) {
    setStatus('请先填写 SKU');
    return;
  }
  resetManualProgress();
  await chrome.storage.local.set({ 'ozon-erp-manual-skus': fields.manualSkus.value.trim() });
  renderManualProgress(`正在打开 ${skus.length} 个 Ozon 详情页并写入已采集商品...`);
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'OZON_ERP_COLLECT_MANUAL_DETAIL_SKUS',
      skus
    }, (result) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(result);
    });
  });
  if (response?.success) {
    renderManualProgress(`已写入已采集商品：成功 ${response.successCount || 0} 个，失败 ${response.failCount || 0} 个`);
  } else {
    const message = response?.message || response?.error || '后台未响应';
    if (manualProgressState.items.size > 0) {
      renderManualProgress(`操作失败：${message}`);
    } else {
      setStatus(`操作失败：${message}`);
    }
  }
  manualProgressState.active = false;
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('collect').addEventListener('click', collectActiveTab);
fields.grantOzonAccess.addEventListener('click', grantOzonAccess);
document.getElementById('manual-sync').addEventListener('click', syncManualSkus);
fields.localPluginToken.addEventListener('input', renderTokenWarning);
fields.pluginUpdateDownload.addEventListener('click', () => {
  if (!pluginUpdateDownloadUrl) return;
  chrome.tabs.create({ url: pluginUpdateDownloadUrl });
});
load();

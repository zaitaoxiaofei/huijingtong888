const fields = {
  localPluginToken: document.getElementById('local-plugin-token'),
  save: document.getElementById('save'),
  saveFeedback: document.getElementById('save-feedback'),
  connectionStatus: document.getElementById('connection-status'),
  connectionDetail: document.getElementById('connection-detail'),
  installedVersion: document.getElementById('installed-version'),
  onlineVersion: document.getElementById('online-version'),
  collectorTab: document.getElementById('collector-tab'),
  analyticsTab: document.getElementById('analytics-tab'),
  collectorPanel: document.getElementById('collector-panel'),
  analyticsPanel: document.getElementById('analytics-panel'),
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
const LOCAL_PLUGIN_TOKEN_STORAGE_KEY = erpConfig.LOCAL_PLUGIN_TOKEN_STORAGE_KEY || 'ozon-erp-local-plugin-token';
const DEFAULT_LOCAL_PLUGIN_TOKEN = erpConfig.DEFAULT_LOCAL_PLUGIN_TOKEN || '';
const DEFAULT_ERP_BASE_URL = erpConfig.DEFAULT_ERP_BASE_URL || 'https://erp.hjt888.xyz';
const SEND_MESSAGE_TIMEOUT_MS = 8000;
const MANUAL_PROGRESS_STORAGE_KEY = 'ozon-erp-manual-progress';
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
let savingKey = false;
let requiresKeyEntry = false;
let keyRevision = 0;
let connectionEpoch = 0;
let connectionRequestId = 0;
let renderedConnectionRequestId = 0;

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => finish({ success: false, error: '插件后台响应超时，请重试' }), SEND_MESSAGE_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        finish(error ? { success: false, error: error.message } : (response || { success: false, error: '插件后台未响应，请重试' }));
      });
    } catch (error) {
      finish({ success: false, error: error?.message || String(error) });
    }
  });
}

function setSaveFeedback(message, tone = '') {
  fields.saveFeedback.textContent = message;
  fields.saveFeedback.dataset.tone = tone;
}

function renderConnection(connection = {}) {
  requiresKeyEntry = connection.requiresKeyEntry === true;
  if (requiresKeyEntry) {
    if (keyRevision === 0) {
      fields.localPluginToken.value = '';
      renderTokenWarning();
    }
    fields.connectionStatus.dataset.state = 'error';
    fields.connectionStatus.textContent = '请重新填写密钥';
    fields.connectionDetail.textContent = connection.lastError || '请从 ERP 企业管理复制密钥并保存。';
    return;
  }
  const state = !connection.configured ? 'empty' : connection.connected ? 'connected' : connection.lastError ? 'error' : 'pending';
  fields.connectionStatus.dataset.state = state;
  fields.connectionStatus.textContent = { empty: '未配置密钥', connected: '已连接企业', error: '连接未通过', pending: '正在验证密钥' }[state];
  fields.connectionDetail.textContent = !connection.configured
    ? '从 ERP 企业管理复制专属密钥，保存后自动连接。'
    : connection.connected ? '商品采集和店铺分析共用此密钥。'
      : connection.lastError || '密钥已保存在本机，正在验证连接。';
}

async function refreshConnection() {
  if (savingKey) return;
  const epoch = connectionEpoch;
  const requestId = ++connectionRequestId;
  const response = await sendRuntimeMessage({ type: 'OZON_UNIFIED_GET_CONNECTION' });
  if (epoch !== connectionEpoch || savingKey || requestId < renderedConnectionRequestId) return;
  renderedConnectionRequestId = requestId;
  if (response?.success) renderConnection(response.connection);
  else {
    fields.connectionStatus.dataset.state = 'error';
    fields.connectionStatus.textContent = '连接状态未获取';
    fields.connectionDetail.textContent = response?.error || '请稍后重新打开插件。';
  }
}

function selectFeature(feature) {
  const analytics = feature === 'analytics';
  fields.collectorTab.setAttribute('aria-selected', String(!analytics));
  fields.analyticsTab.setAttribute('aria-selected', String(analytics));
  fields.collectorPanel.hidden = analytics;
  fields.analyticsPanel.hidden = !analytics;
}

function setStatus(text) {
  fields.status.classList.remove('has-detail');
  fields.status.textContent = text || '';
}

function setStatusDetail(lines) {
  fields.status.classList.add('has-detail');
  fields.status.textContent = lines.filter(Boolean).join('\n');
}

function renderTokenWarning() {
  const token = String(fields.localPluginToken.value || '').trim();
  const usesDefaultToken = !token || token === DEFAULT_LOCAL_PLUGIN_TOKEN;
  fields.tokenWarning.classList.toggle('is-visible', usesDefaultToken);
  fields.tokenWarning.textContent = usesDefaultToken
    ? '正式环境请在 ERP「企业管理」中为当前企业生成专属插件令牌，并粘贴到此处；不同企业不能共用令牌。'
    : '';
}

function renderPluginUpdate(plugin) {
  fields.onlineVersion.textContent = String(plugin?.version || '暂未获取');
  const updateAvailable = plugin?.update_available === true || plugin?.update_required === true;
  fields.pluginUpdateCard.classList.toggle('is-visible', updateAvailable);
  pluginUpdateDownloadUrl = '';
  if (!updateAvailable) return;
  try {
    const url = new URL(String(plugin.download_url || ''), DEFAULT_ERP_BASE_URL);
    if (plugin.download_url && ['http:', 'https:'].includes(url.protocol)) pluginUpdateDownloadUrl = url.href;
  } catch (error) {}
  fields.pluginUpdateTitle.textContent = plugin.title || '爆单ERP插件可更新';
  fields.pluginUpdateMessage.textContent = plugin.message || '新版已提供，可按需下载更新。';
  fields.pluginUpdateDownload.disabled = !pluginUpdateDownloadUrl;
}

async function loadPluginUpdateStatus() {
  const response = await sendRuntimeMessage({ type: 'OZON_ERP_CHECK_PLUGIN_UPDATE' });
  if (response?.success && response.plugin) renderPluginUpdate(response.plugin);
  else fields.onlineVersion.textContent = '暂未获取';
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

function originPatternForUrl(url) {
  try {
    const target = new URL(String(url || ''));
    return `${target.protocol}//${target.hostname}/*`;
  } catch (error) {
    return '';
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

async function diagnoseActiveOzonPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isOzonFrontPage(tab.url)) return;
  const currentOrigin = originPatternForUrl(tab.url);
  const originGranted = currentOrigin
    ? await chrome.permissions.contains({ origins: [currentOrigin] }).catch(() => false)
    : false;
  const contentState = await chrome.tabs.sendMessage(tab.id, { type: 'OZON_ERP_EXPORT_STATE' }).catch((error) => ({
    success: false,
    error: error?.message || String(error)
  }));
  setStatusDetail([
    `当前页：${new URL(tab.url).hostname}`,
    `站点权限：${originGranted ? '已授权' : '未授权'}`,
    `页面脚本：${contentState?.success === false ? '未加载' : '已加载'}`,
    contentState?.success === false ? '处理：点击“授权 Ozon 页面访问”，或在扩展详情把站点访问权限改为“在所有站点上”。' : '如果页面仍无面板，问题在页面定位/渲染。'
  ]);
}

async function grantOzonAccess() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isOzonFrontPage(tab.url)) {
    setStatus('请先切到 Ozon 商品页或列表页，再点击这个按钮。');
    return;
  }
  if (!chrome?.permissions?.request) {
    setStatus('当前浏览器不支持插件主动申请站点权限，请在扩展详情里把站点访问权限设为所有站点。');
    return;
  }
  const currentOrigin = originPatternForUrl(tab.url);
  const alreadyGranted = currentOrigin
    ? await chrome.permissions.contains({ origins: [currentOrigin] }).catch(() => false)
    : false;
  const granted = alreadyGranted || await chrome.permissions.request({ origins: currentOrigin ? [currentOrigin] : OZON_PERMISSION_ORIGINS }).catch(() => false);
  await refreshOzonAccessButton();
  const injected = await chrome.runtime.sendMessage({ type: 'OZON_ERP_INJECT_ACTIVE_OZON_FRONT' }).catch((error) => ({
    success: false,
    error: error?.message || String(error)
  }));
  if (injected?.success) {
    setStatus(injected.alreadyLoaded ? '当前 Ozon 页面已加载插件脚本。如果页面没有面板，问题在页面渲染定位。' : '已在当前 Ozon 页面注入插件。');
    return;
  }
  setStatus(granted
    ? '权限接口已返回允许，但 Edge 仍阻止脚本。请在扩展详情里把“站点访问权限”改为“在所有站点上”，再刷新 Ozon 页面。'
    : 'Edge 没有授予当前 Ozon 域名权限。请在扩展详情里把“站点访问权限”改为“在所有站点上”。');
}

async function load() {
  fields.installedVersion.textContent = chrome.runtime.getManifest()?.version || '未知';
  const initialKeyRevision = keyRevision;
  const stored = await chrome.storage.local.get([
    LOCAL_PLUGIN_TOKEN_STORAGE_KEY,
    'ozon-erp-inject-cards',
    'ozon-erp-manual-skus'
  ]);
  if (keyRevision === initialKeyRevision && !requiresKeyEntry) fields.localPluginToken.value = stored[LOCAL_PLUGIN_TOKEN_STORAGE_KEY] || '';
  renderTokenWarning();
  fields.injectCards.checked = stored['ozon-erp-inject-cards'] !== false;
  fields.manualSkus.value = stored['ozon-erp-manual-skus'] || '';
  await Promise.allSettled([restoreManualProgress(), loadPluginUpdateStatus(), refreshOzonAccessButton(), refreshConnection()]);
  if (!fields.status.textContent) await diagnoseActiveOzonPage();
}

async function save() {
  if (savingKey) return;
  savingKey = true;
  fields.save.disabled = true;
  connectionEpoch++;
  const submittedRevision = keyRevision;
  const submittedKey = fields.localPluginToken.value.trim();
  setSaveFeedback('正在保存…', 'pending');
  try {
    await chrome.storage.local.set({
      'ozon-erp-inject-cards': fields.injectCards.checked,
      'ozon-erp-manual-skus': fields.manualSkus.value.trim()
    });
    const response = await sendRuntimeMessage({ type: 'OZON_UNIFIED_SAVE_KEY', key: submittedKey });
    if (!response?.success) throw new Error(response?.error || '保存失败，请重试');
    renderConnection(response.connection);
    setSaveFeedback(keyRevision === submittedRevision ? '已保存在本机，连接状态将自动更新。' : '已保存提交的密钥，当前还有未保存修改。');
    renderTokenWarning();
  } catch (error) {
    setSaveFeedback(`保存未完成：${error?.message || String(error)}`, 'error');
  } finally {
    connectionEpoch++;
    savingKey = false;
    fields.save.disabled = false;
  }
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

fields.save.addEventListener('click', save);
fields.collectorTab.addEventListener('click', () => selectFeature('collector'));
fields.analyticsTab.addEventListener('click', () => selectFeature('analytics'));
document.getElementById('collect').addEventListener('click', collectActiveTab);
fields.grantOzonAccess.addEventListener('click', grantOzonAccess);
document.getElementById('manual-sync').addEventListener('click', syncManualSkus);
fields.localPluginToken.addEventListener('input', () => {
  keyRevision++;
  renderTokenWarning();
  setSaveFeedback('密钥有未保存修改。', 'pending');
});
fields.injectCards.addEventListener('change', () => {
  chrome.storage.local.set({ 'ozon-erp-inject-cards': fields.injectCards.checked }).catch((error) => setStatus(error?.message || '显示设置保存失败'));
});
fields.pluginUpdateDownload.addEventListener('click', () => {
  if (!pluginUpdateDownloadUrl) return;
  chrome.tabs.create({ url: pluginUpdateDownloadUrl });
});
load().catch((error) => setSaveFeedback(error?.message || '读取配置失败，请重试', 'error'));
setInterval(() => { void refreshConnection(); }, 2000);

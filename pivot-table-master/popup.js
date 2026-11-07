const els = {
  statusText: document.getElementById('statusText'),
  refreshBtn: document.getElementById('refreshBtn'),
  erpBaseUrl: document.getElementById('erpBaseUrl'),
  tenantId: document.getElementById('tenantId'),
  localPluginToken: document.getElementById('localPluginToken'),
  saveBtn: document.getElementById('saveBtn'),
  saveFeedback: document.getElementById('saveFeedback'),
  pollBtn: document.getElementById('pollBtn'),
  authProbeBtn: document.getElementById('authProbeBtn'),
  startPollingBtn: document.getElementById('startPollingBtn'),
  stopPollingBtn: document.getElementById('stopPollingBtn'),
  claimedCount: document.getElementById('claimedCount'),
  completedCount: document.getElementById('completedCount'),
  failedCount: document.getElementById('failedCount'),
  activeCount: document.getElementById('activeCount'),
  pollingStatus: document.getElementById('pollingStatus'),
  pageStatus: document.getElementById('pageStatus'),
  pageStatusHint: document.getElementById('pageStatusHint'),
  taskStatus: document.getElementById('taskStatus'),
  taskStatusHint: document.getElementById('taskStatusHint'),
  serviceStatus: document.getElementById('serviceStatus'),
  serviceStatusHint: document.getElementById('serviceStatusHint'),
  sellerTab: document.getElementById('sellerTab'),
  queueList: document.getElementById('queueList'),
  logList: document.getElementById('logList'),
  exportLogsBtn: document.getElementById('exportLogsBtn')
};

const configFields = ['erpBaseUrl', 'tenantId', 'localPluginToken'];
const fieldVersions = Object.fromEntries(configFields.map((key) => [key, 0]));
const dirtyFields = new Set();
let configEpoch = 0;
let statusRequestId = 0;
let latestRenderedStatusId = 0;
let savingConfig = false;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (response || { error: '插件后台没有响应，请重试' }));
    });
  });
}

function formatTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '-';
  return new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function formatDateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '-';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function setSaveFeedback(message, tone = '') {
  els.saveFeedback.textContent = message;
  els.saveFeedback.className = `save-feedback ${tone}`.trim();
}

function syncConfigFields(config, savedVersions = null) {
  for (const key of configFields) {
    const input = els[key];
    if (savedVersions && fieldVersions[key] === savedVersions[key]) dirtyFields.delete(key);
    if (dirtyFields.has(key) || document.activeElement === input) continue;
    input.value = config[key] || '';
  }
}

function renderQueue(queue = []) {
  els.queueList.replaceChildren();
  if (!queue.length) {
    els.queueList.className = 'list empty';
    els.queueList.textContent = '暂无任务';
    return;
  }
  els.queueList.className = 'list';
  for (const item of queue.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = `${item.source_label || '-'} · ${item.endpoint_type || '-'}`;
    const status = document.createElement('span');
    status.className = 'tag';
    status.textContent = item.status === 'running' ? '执行中' : '待执行';
    row.append(label, status);
    els.queueList.append(row);
  }
}

function renderLogs(logs = []) {
  els.logList.replaceChildren();
  if (!logs.length) {
    els.logList.className = 'list empty';
    els.logList.textContent = '暂无日志';
    return;
  }
  els.logList.className = 'list';
  for (const item of logs.slice(0, 6)) {
    const level = ['error', 'success'].includes(item.level) ? item.level : 'info';
    const row = document.createElement('div');
    row.className = `row log-${level}`;
    const label = document.createElement('span');
    label.textContent = `${level === 'error' ? '错误' : level === 'success' ? '成功' : '信息'} · ${item.message || '-'}`;
    const time = document.createElement('time');
    time.textContent = formatTime(item.time);
    row.append(label, time);
    els.logList.append(row);
  }
}

function renderStatus(payload = {}, options = {}) {
  if (payload.error) {
    els.statusText.textContent = payload.error;
    return;
  }
  const config = payload.config || {};
  const state = payload.state || {};
  if (options.syncConfig !== false) syncConfigFields(config, options.savedVersions);
  els.claimedCount.textContent = state.claimed || 0;
  els.completedCount.textContent = state.completed || 0;
  els.failedCount.textContent = state.failed || 0;
  els.activeCount.textContent = state.active || 0;
  const sellerMissing = Boolean(state.sellerMissing);
  const currentTask = Array.isArray(state.queue) && state.queue.length ? state.queue[0] : null;
  let statusClass = 'status-paused';
  let pollingText = '已暂停';
  if (sellerMissing) {
    statusClass = 'status-missing';
    pollingText = state.pollingEnabled ? '等待 Ozon 分析页' : '未找到 Ozon 分析页';
  } else if (state.running) {
    statusClass = 'status-running';
    pollingText = '正在采集';
  } else if (state.pollingEnabled) {
    statusClass = 'status-enabled';
    pollingText = `轮询中 · 约 ${Math.round((state.pollIntervalMs || 60000) / 1000)} 秒`;
  }
  els.pollingStatus.className = statusClass;
  els.pollingStatus.textContent = pollingText;
  els.startPollingBtn.disabled = Boolean(state.pollingEnabled);
  els.stopPollingBtn.disabled = !state.pollingEnabled;
  if (sellerMissing) {
    els.pageStatus.textContent = '未连接分析页';
    els.pageStatusHint.textContent = '请打开 Ozon 数据分析页';
  } else if (state.currentCompanyId) {
    els.pageStatus.textContent = '已识别店铺';
    els.pageStatusHint.textContent = state.currentCompanyId;
  } else {
    els.pageStatus.textContent = '分析页已打开';
    els.pageStatusHint.textContent = '正在识别当前店铺';
  }
  if (currentTask) {
    const taskPeriod = currentTask.period_key === '28d' ? '近 28 天' : currentTask.period_key === '7d' ? '近 7 天' : (currentTask.period_key || '当前周期');
    const taskPage = Number(currentTask.page_index || 0) + 1;
    els.taskStatus.textContent = `同步 ${currentTask.source_label || '当前店铺'}`;
    els.taskStatusHint.textContent = `${taskPeriod} · 第 ${taskPage} 页`;
  } else if (state.running) {
    els.taskStatus.textContent = '领取任务中';
    els.taskStatusHint.textContent = '正在等待 ERP 下发采集请求';
  } else {
    els.taskStatus.textContent = '等待任务';
    els.taskStatusHint.textContent = '暂无执行中的采集任务';
  }
  els.serviceStatus.textContent = state.running || currentTask ? '正在回传 ERP' : 'ERP 服务';
  els.serviceStatusHint.textContent = config.erpBaseUrl || 'https://erp.hjt888.xyz';
  els.statusText.textContent = state.running ? '正在同步数据' : (state.lastError || '已就绪，等待采集任务');
  els.sellerTab.className = state.sellerTab?.url ? 'seller-tab-ready' : 'seller-tab-missing';
  els.sellerTab.textContent = state.sellerTab?.url || '未找到 Ozon 数据分析页';
  renderQueue(state.queue || []);
  renderLogs(state.logs || []);
}

async function refresh() {
  const requestId = ++statusRequestId;
  const requestEpoch = configEpoch;
  const status = await sendMessage({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
  if (requestId < latestRenderedStatusId) return;
  latestRenderedStatusId = requestId;
  renderStatus(status, { syncConfig: requestEpoch === configEpoch && !savingConfig });
}

async function saveConfig() {
  if (savingConfig) return;
  savingConfig = true;
  els.saveBtn.disabled = true;
  setSaveFeedback('保存中…');
  configEpoch += 1;
  const requestId = ++statusRequestId;
  const submittedVersions = { ...fieldVersions };
  const config = Object.fromEntries(configFields.map((key) => [key, els[key].value]));
  const status = await sendMessage({
    type: 'PIVOT_ERP_PANEL_SAVE_CONFIG',
    config
  });
  latestRenderedStatusId = Math.max(latestRenderedStatusId, requestId);
  configEpoch += 1;
  savingConfig = false;
  els.saveBtn.disabled = false;
  if (status.error) {
    setSaveFeedback(`保存失败：${status.error}`, 'error');
    els.statusText.textContent = status.error;
    return;
  }
  renderStatus(status, { savedVersions: submittedVersions });
  setSaveFeedback(dirtyFields.size ? '新修改尚未保存' : '已保存', dirtyFields.size ? 'pending' : 'success');
}

async function runAction(type, progress) {
  els.statusText.textContent = progress;
  const status = await sendMessage({ type });
  renderStatus(status, { syncConfig: false });
  return status;
}

async function authProbe() {
  const status = await runAction('PIVOT_ERP_PANEL_AUTH_PROBE', '正在测试后台直连 Ozon');
  if (status.authProbe) {
    els.statusText.textContent = `后台直连 ${status.authProbe.ok ? '成功' : '失败'}：HTTP ${status.authProbe.status || '-'}`;
  }
}

async function exportLogs() {
  const diagnostics = await sendMessage({ type: 'PIVOT_ERP_PANEL_GET_DIAGNOSTICS' });
  if (diagnostics.error) {
    els.statusText.textContent = `导出失败：${diagnostics.error}`;
    return;
  }
  const lines = [
    '爆单 ERP 数据分析插件诊断日志',
    `插件版本：${diagnostics.version || '-'}`,
    `导出时间（北京时间）：${formatDateTime(diagnostics.exportedAt)}`,
    `日志条数：${diagnostics.logs?.length || 0}`,
    ''
  ];
  for (const item of diagnostics.logs || []) {
    const level = item.level === 'error' ? '错误' : item.level === 'success' ? '成功' : '信息';
    lines.push(`[${formatDateTime(item.time)}] [${level}] ${item.message || '-'}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ozon-analytics-logs-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const key of configFields) {
  els[key].addEventListener('input', () => {
    fieldVersions[key] += 1;
    dirtyFields.add(key);
    setSaveFeedback('有未保存的修改', 'pending');
  });
}
els.refreshBtn.addEventListener('click', refresh);
els.saveBtn.addEventListener('click', saveConfig);
els.pollBtn.addEventListener('click', () => runAction('PIVOT_ERP_PANEL_POLL_NOW', '正在触发采集'));
els.authProbeBtn?.addEventListener('click', authProbe);
els.startPollingBtn.addEventListener('click', () => runAction('PIVOT_ERP_PANEL_START_POLLING', '正在启动轮询'));
els.stopPollingBtn.addEventListener('click', () => runAction('PIVOT_ERP_PANEL_STOP_POLLING', '正在停止轮询'));
els.exportLogsBtn.addEventListener('click', exportLogs);

refresh();
setInterval(refresh, 2000);

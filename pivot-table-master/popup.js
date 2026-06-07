const els = {
  statusText: document.getElementById('statusText'),
  refreshBtn: document.getElementById('refreshBtn'),
  erpBaseUrl: document.getElementById('erpBaseUrl'),
  tenantId: document.getElementById('tenantId'),
  localPluginToken: document.getElementById('localPluginToken'),
  localMirrorBaseUrl: document.getElementById('localMirrorBaseUrl'),
  saveBtn: document.getElementById('saveBtn'),
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
  logList: document.getElementById('logList')
};

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || {});
    });
  });
}

function formatTime(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
  } catch (error) {
    return '-';
  }
}

function renderQueue(queue = []) {
  if (!queue.length) {
    els.queueList.className = 'list empty';
    els.queueList.textContent = '暂无任务';
    return;
  }
  els.queueList.className = 'list';
  els.queueList.innerHTML = queue.map((item) => `
    <div class="row">
      <span>${item.source_label || '-'} / ${item.endpoint_type || '-'}</span>
      <span class="tag">${item.status || 'pending'}</span>
    </div>
  `).join('');
}

function renderLogs(logs = []) {
  if (!logs.length) {
    els.logList.className = 'list empty';
    els.logList.textContent = '暂无日志';
    return;
  }
  els.logList.className = 'list';
  els.logList.innerHTML = logs.map((item) => `
    <div class="row log-${item.level || 'info'}">
      <span>${item.message || '-'}</span>
      <span>${formatTime(item.time)}</span>
    </div>
  `).join('');
}

function renderStatus(payload = {}) {
  if (payload.error) {
    els.statusText.textContent = payload.error;
    return;
  }
  const config = payload.config || {};
  const state = payload.state || {};
  els.erpBaseUrl.value = config.erpBaseUrl || '';
  els.tenantId.value = config.tenantId || '';
  els.localPluginToken.value = config.localPluginToken || '';
  els.localMirrorBaseUrl.value = config.localMirrorBaseUrl || '';
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
    pollingText = state.pollingEnabled ? '等待 seller 页面，3 秒重试' : '未启动：未找到 seller 页面';
  } else if (state.running) {
    statusClass = 'status-running';
    pollingText = '正在采集';
  } else if (state.pollingEnabled) {
    statusClass = 'status-enabled';
    pollingText = `已启动，${Math.round((state.pollIntervalMs || 3000) / 1000)} 秒一次`;
  }
  els.pollingStatus.className = statusClass;
  els.pollingStatus.textContent = pollingText;
  els.startPollingBtn.disabled = Boolean(state.pollingEnabled);
  els.stopPollingBtn.disabled = !state.pollingEnabled;
  if (sellerMissing) {
    els.pageStatus.textContent = '未连接分析页';
    els.pageStatusHint.textContent = '请停留在 seller.ozon.ru/app/analytics';
  } else if (state.currentCompanyId) {
    els.pageStatus.textContent = 'JS 注入成功';
    els.pageStatusHint.textContent = `已识别店铺 ${state.currentCompanyId}`;
  } else {
    els.pageStatus.textContent = '分析页已打开';
    els.pageStatusHint.textContent = '正在识别当前店铺';
  }
  if (currentTask) {
    const taskPeriod = currentTask.period_key === '28d' ? '近 28 天' : currentTask.period_key === '7d' ? '近 7 天' : (currentTask.period_key || '当前周期');
    const taskPage = Number(currentTask.page_index || 0) + 1;
    els.taskStatus.textContent = `正在同步 ${currentTask.source_label || '当前店铺'}`;
    els.taskStatusHint.textContent = `${taskPeriod} · 第 ${taskPage} 页`;
  } else if (state.running) {
    els.taskStatus.textContent = '正在领取任务';
    els.taskStatusHint.textContent = '正在等待 ERP 下发采集请求';
  } else {
    els.taskStatus.textContent = '等待任务';
    els.taskStatusHint.textContent = '暂无执行中的采集任务';
  }
  els.serviceStatus.textContent = state.running || currentTask ? '同步到官网服务中' : '已连接官网';
  els.serviceStatusHint.textContent = 'https://erp.hjt888.xyz/';
  els.statusText.textContent = state.running ? '正在同步数据' : (state.lastError || '已就绪，等待采集任务');
  els.sellerTab.className = state.sellerTab?.url ? 'seller-tab-ready' : 'seller-tab-missing';
  els.sellerTab.textContent = state.sellerTab?.url || '未找到 seller.ozon.ru/app/analytics 页面';
  renderQueue(state.queue || []);
  renderLogs(state.logs || []);
}

async function refresh() {
  const status = await sendMessage({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
  renderStatus(status);
}

async function saveConfig() {
  const status = await sendMessage({
    type: 'PIVOT_ERP_PANEL_SAVE_CONFIG',
    config: {
      erpBaseUrl: els.erpBaseUrl.value,
      tenantId: els.tenantId.value,
      localPluginToken: els.localPluginToken.value,
      localMirrorBaseUrl: els.localMirrorBaseUrl.value
    }
  });
  renderStatus(status);
}

async function pollNow() {
  els.statusText.textContent = '正在触发采集';
  const status = await sendMessage({ type: 'PIVOT_ERP_PANEL_POLL_NOW' });
  renderStatus(status);
}

async function startPolling() {
  els.statusText.textContent = '正在启动轮询';
  const status = await sendMessage({ type: 'PIVOT_ERP_PANEL_START_POLLING' });
  renderStatus(status);
}

async function stopPolling() {
  els.statusText.textContent = '正在停止轮询';
  const status = await sendMessage({ type: 'PIVOT_ERP_PANEL_STOP_POLLING' });
  renderStatus(status);
}

async function authProbe() {
  els.statusText.textContent = '正在测试后台直连 Ozon';
  const status = await sendMessage({ type: 'PIVOT_ERP_PANEL_AUTH_PROBE' });
  renderStatus(status);
  if (status.authProbe) {
    els.statusText.textContent = `后台直连 ${status.authProbe.ok ? '成功' : '失败'}：HTTP ${status.authProbe.status || '-'}`;
  }
}

els.refreshBtn.addEventListener('click', refresh);
els.saveBtn.addEventListener('click', saveConfig);
els.pollBtn.addEventListener('click', pollNow);
els.authProbeBtn?.addEventListener('click', authProbe);
els.startPollingBtn.addEventListener('click', startPolling);
els.stopPollingBtn.addEventListener('click', stopPolling);

refresh();
setInterval(refresh, 2000);

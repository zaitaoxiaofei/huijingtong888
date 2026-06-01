const els = {
  statusText: document.getElementById('statusText'),
  refreshBtn: document.getElementById('refreshBtn'),
  erpBaseUrl: document.getElementById('erpBaseUrl'),
  tenantId: document.getElementById('tenantId'),
  saveBtn: document.getElementById('saveBtn'),
  pollBtn: document.getElementById('pollBtn'),
  startPollingBtn: document.getElementById('startPollingBtn'),
  stopPollingBtn: document.getElementById('stopPollingBtn'),
  claimedCount: document.getElementById('claimedCount'),
  completedCount: document.getElementById('completedCount'),
  failedCount: document.getElementById('failedCount'),
  activeCount: document.getElementById('activeCount'),
  pollingStatus: document.getElementById('pollingStatus'),
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
  els.claimedCount.textContent = state.claimed || 0;
  els.completedCount.textContent = state.completed || 0;
  els.failedCount.textContent = state.failed || 0;
  els.activeCount.textContent = state.active || 0;
  const sellerMissing = Boolean(state.sellerMissing);
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
  els.statusText.textContent = state.running ? '正在采集' : (state.lastError || '待命中');
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
      tenantId: els.tenantId.value
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

els.refreshBtn.addEventListener('click', refresh);
els.saveBtn.addEventListener('click', saveConfig);
els.pollBtn.addEventListener('click', pollNow);
els.startPollingBtn.addEventListener('click', startPolling);
els.stopPollingBtn.addEventListener('click', stopPolling);

refresh();
setInterval(refresh, 2000);

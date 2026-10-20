import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const popupSource = fs.readFileSync('pivot-table-master/popup.js', 'utf8');
const backgroundSource = fs.readFileSync('pivot-table-master/background.js', 'utf8');

function popupHarness() {
  const ids = [
    'statusText', 'refreshBtn', 'erpBaseUrl', 'tenantId', 'localPluginToken',
    'saveBtn', 'saveFeedback', 'pollBtn', 'authProbeBtn', 'startPollingBtn',
    'stopPollingBtn', 'claimedCount', 'completedCount', 'failedCount',
    'activeCount', 'pollingStatus', 'pageStatus', 'pageStatusHint', 'taskStatus',
    'taskStatusHint', 'serviceStatus', 'serviceStatusHint', 'sellerTab',
    'queueList', 'logList', 'exportLogsBtn'
  ];
  const createElement = () => ({
    value: '', textContent: '', className: '', disabled: false, children: [], listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    click() { this.clicked = true; },
    remove() { this.removed = true; }
  });
  const elements = Object.fromEntries(ids.map((id) => [id, createElement()]));
  const pending = [];
  let interval = null;
  let downloadedBlob = null;
  const document = {
    activeElement: null,
    body: createElement(),
    getElementById(id) { return elements[id]; },
    createElement() { return createElement(); }
  };
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) { pending.push({ message, callback }); }
    }
  };
  vm.runInNewContext(popupSource, {
    document, chrome, Blob, Date, Intl,
    URL: { createObjectURL(blob) { downloadedBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    setInterval(callback) { interval = callback; },
    setTimeout() {}
  });
  return {
    elements, document, pending,
    refresh() { interval(); },
    click(id) { return elements[id].listeners.click(); },
    input(id, value) { elements[id].value = value; elements[id].listeners.input(); },
    async reply(type, payload, options = {}) {
      const index = pending.findIndex((item) => item.message.type === type);
      assert.ok(index >= 0, `pending message ${type}`);
      const [{ callback }] = pending.splice(index, 1);
      chrome.runtime.lastError = options.error || null;
      callback(payload);
      chrome.runtime.lastError = null;
      await new Promise((resolve) => setImmediate(resolve));
    },
    downloadedText: async () => downloadedBlob?.text()
  };
}

function status(localPluginToken = 'saved-token') {
  return {
    config: { erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'admin', localPluginToken },
    state: { pollingEnabled: true, queue: [], logs: [] }
  };
}

test('polling and save responses never replace a token being edited', async () => {
  const popup = popupHarness();
  await popup.reply('PIVOT_ERP_PANEL_GET_STATUS', status());
  assert.equal(popup.elements.localPluginToken.value, 'saved-token');

  popup.input('localPluginToken', 'new-token');
  popup.refresh();
  await popup.reply('PIVOT_ERP_PANEL_GET_STATUS', status());
  assert.equal(popup.elements.localPluginToken.value, 'new-token');
  assert.equal(popup.elements.saveFeedback.textContent, '有未保存的修改');

  popup.click('saveBtn');
  const saveMessage = popup.pending.find((item) => item.message.type === 'PIVOT_ERP_PANEL_SAVE_CONFIG');
  assert.equal(saveMessage.message.config.localPluginToken, 'new-token');
  popup.input('localPluginToken', 'newer-token');
  popup.refresh();
  await popup.reply('PIVOT_ERP_PANEL_SAVE_CONFIG', status('new-token'));
  await popup.reply('PIVOT_ERP_PANEL_GET_STATUS', status('saved-token'));
  assert.equal(popup.elements.localPluginToken.value, 'newer-token');
  assert.equal(popup.elements.saveFeedback.textContent, '新修改尚未保存');

  popup.click('saveBtn');
  await popup.reply('PIVOT_ERP_PANEL_SAVE_CONFIG', status('newer-token'));
  assert.equal(popup.elements.localPluginToken.value, 'newer-token');
  assert.equal(popup.elements.saveFeedback.textContent, '已保存');
});

test('missing status response preserves typed configuration and reports failure', async () => {
  const popup = popupHarness();
  popup.input('localPluginToken', 'typing-token');
  await popup.reply('PIVOT_ERP_PANEL_GET_STATUS', status('saved-token'));
  assert.equal(popup.elements.localPluginToken.value, 'typing-token');
  popup.refresh();
  await popup.reply('PIVOT_ERP_PANEL_GET_STATUS', undefined, { error: { message: '后台暂不可用' } });
  assert.equal(popup.elements.localPluginToken.value, 'typing-token');
  assert.equal(popup.elements.statusText.textContent, '后台暂不可用');
});

test('diagnostic export includes bounded log data without config or token', async () => {
  const popup = popupHarness();
  await popup.reply('PIVOT_ERP_PANEL_GET_STATUS', status('private-token'));
  popup.click('exportLogsBtn');
  await popup.reply('PIVOT_ERP_PANEL_GET_DIAGNOSTICS', {
    version: '1.0.36',
    exportedAt: '2026-10-20T12:00:00.000Z',
    config: { localPluginToken: 'private-token' },
    logs: [{ level: 'error', time: '2026-10-20T11:59:00.000Z', message: 'Ozon HTTP 429' }]
  });
  const text = await popup.downloadedText();
  assert.match(text, /1\.0\.36/);
  assert.match(text, /Ozon HTTP 429/);
  assert.match(text, /北京时间/);
  assert.doesNotMatch(text, /private-token|localPluginToken|config/);
});

test('background redacts credentials before retaining or exporting logs', () => {
  const start = backgroundSource.indexOf('function redactDiagnosticMessage(');
  const end = backgroundSource.indexOf('\nfunction safePanelLog(', start);
  assert.ok(start >= 0 && end > start);
  const context = { knownPluginTokens: new Set(['saved-private-token']) };
  vm.runInNewContext(`${backgroundSource.slice(start, end)}\nglobalThis.redact = redactDiagnosticMessage;`, context);
  const result = context.redact('Authorization: Bearer abc123; token="other-secret"; Cookie: sid=xyz\nsaved-private-token');
  assert.doesNotMatch(result, /abc123|other-secret|sid=xyz|saved-private-token/);
  assert.match(backgroundSource, /logs: panelState\.logs\.slice\(0, PANEL_LOG_LIMIT\)\.map\(safePanelLog\)/);
  assert.match(backgroundSource, /PANEL_LOG_LIMIT = 200/);
});

test('background serializes bounded log writes across overlapping updates', async () => {
  const start = backgroundSource.indexOf('function persistPanelLogsSoon(');
  const end = backgroundSource.indexOf('\nasync function restorePanelLogs(', start);
  assert.ok(start >= 0 && end > start);
  const scheduled = [];
  const writes = [];
  const context = {
    logPersistTimer: null,
    logPersistPromise: Promise.resolve(),
    restorePanelLogsPromise: Promise.resolve(),
    panelState: { logs: [{ message: 'first' }] },
    PANEL_LOG_HISTORY_KEY: 'logs',
    PANEL_LOG_LIMIT: 200,
    async getErpConfig() { return {}; },
    safePanelLog(item) { return item; },
    chrome: { storage: { local: { set(value) {
      return new Promise((resolve) => writes.push({ value, resolve }));
    } } } },
    setTimeout(callback) { scheduled.push(callback); return scheduled.length; }
  };
  vm.runInNewContext(`${backgroundSource.slice(start, end)}\nglobalThis.persist = persistPanelLogsSoon;`, context);
  context.persist();
  scheduled.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);

  context.panelState.logs = [{ message: 'second' }];
  context.persist();
  scheduled.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  writes[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].value.logs[0].message, 'second');
  writes[1].resolve();
});

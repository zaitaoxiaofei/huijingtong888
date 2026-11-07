import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync('ozon-erp-collector-plugin/popup.html', 'utf8');
const source = fs.readFileSync('ozon-erp-collector-plugin/popup.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ deferInitialStorage = false } = {}) {
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => {
    const classes = new Set();
    return [id, {
      value: '', textContent: id === 'online-version' ? '查询中' : '', checked: false, disabled: false, hidden: id === 'analytics-panel',
      dataset: {}, attributes: {}, listeners: {},
      classList: { add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; }
    }];
  }));
  const stored = {
    'ozon-erp-local-plugin-token': 'saved-key',
    'ozon-erp-inject-cards': false,
    'ozon-erp-manual-skus': '123\n456',
    'ozon-erp-plugin-update-status': { version: '1.4.1' }
  };
  const pending = [], writes = [], opened = [], tabMessages = [], intervals = [], timers = new Map();
  let timerId = 0, storageError = '', incoming, reads = 0, releaseStorage;
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '1.4.40' }), lastError: null,
      sendMessage(message, callback) {
        if (callback) pending.push({ message, callback, timerId });
        else return new Promise(resolve => pending.push({ message, callback: resolve, timerId }));
      },
      onMessage: { addListener(callback) { incoming = callback; } }
    },
    storage: { local: {
      get: async () => {
        if (deferInitialStorage && reads++ === 0) await new Promise(resolve => { releaseStorage = resolve; });
        return { ...stored };
      },
      set: async value => { if (storageError) throw new Error(storageError); writes.push(value); Object.assign(stored, value); }
    } },
    tabs: {
      query: async () => [{ id: 9, url: 'https://www.ozon.ru/product/123/' }],
      create: async value => { opened.push(value); },
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message });
        return { success: true, data: { sku: '123' } };
      }
    },
    permissions: { contains: async () => true, request: async () => true }
  };
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] }, window: {}, chrome, URL,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: callback => intervals.push(callback)
  });
  return {
    elements, stored, pending, writes, opened, tabMessages,
    click: id => elements[id].listeners.click(),
    input(value) { elements['local-plugin-token'].value = value; elements['local-plugin-token'].listeners.input(); },
    refresh() { intervals[0](); },
    setStorageError(value) { storageError = value; },
    releaseStorage() { releaseStorage(); },
    progress(value) { incoming({ type: 'OZON_ERP_MANUAL_COLLECT_PROGRESS', progress: value }); },
    async reply(type, payload) {
      const index = pending.findIndex(item => item.message.type === type);
      assert.ok(index >= 0, `pending ${type}`);
      pending.splice(index, 1)[0].callback(payload);
      await flush();
    },
    async expire(type) {
      const message = pending.find(item => item.message.type === type);
      assert.ok(message && timers.has(message.timerId));
      assert.equal(timers.get(message.timerId).delay, 8000);
      timers.get(message.timerId).callback();
      await flush();
    }
  };
}

test('unified popup has one editable connection key and preserves collector settings and feature tabs', async () => {
  assert.doesNotMatch(html, /id="(?:erp-base-url|tenantId|tenant-id)"/);
  assert.match(html, /src="analytics\/popup\.html"/);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  const h = harness(); await flush();
  assert.equal(h.elements['local-plugin-token'].value, 'saved-key');
  assert.equal(h.elements['manual-skus'].value, '123\n456');
  assert.equal(h.elements['inject-cards'].checked, false);
  assert.equal(h.elements['installed-version'].textContent, '1.4.40');
  assert.equal(h.elements['online-version'].textContent, '查询中');
  assert.equal(h.writes.length, 0);
  h.click('analytics-tab');
  assert.equal(h.elements['collector-panel'].hidden, true);
  assert.equal(h.elements['analytics-panel'].hidden, false);
  assert.equal(h.elements['analytics-tab'].attributes['aria-selected'], 'true');
  h.click('collector-tab');
  assert.equal(h.elements['collector-panel'].hidden, false);
  assert.equal(h.elements['analytics-panel'].hidden, true);
});

test('the online version comes from the live check and optional updates show a usable download', async () => {
  const h = harness(); await flush();
  await h.reply('OZON_ERP_CHECK_PLUGIN_UPDATE', { success: true, plugin: {
    version: '1.4.41', update_available: true, update_required: false,
    download_url: '/downloads/ozon-baodan-erp-plugin-1.4.41.zip'
  } });
  assert.equal(h.elements['online-version'].textContent, '1.4.41');
  assert.equal(h.elements['installed-version'].textContent, '1.4.40');
  assert.equal(h.elements['plugin-update-card'].classList.contains('is-visible'), true);
  h.click('plugin-update-download');
  assert.equal(h.opened[0].url, 'https://erp.hjt888.xyz/downloads/ozon-baodan-erp-plugin-1.4.41.zip');
});

test('an old-host credential requiring re-entry is cleared only before the user edits', async () => {
  const required = { success: true, connection: { configured: false, connected: false, requiresKeyEntry: true, lastError: '请重新保存当前企业的密钥' } };
  const initial = harness(); await flush();
  await initial.reply('OZON_UNIFIED_GET_CONNECTION', required);
  assert.equal(initial.elements['local-plugin-token'].value, '');
  assert.equal(initial.elements['connection-status'].textContent, '请重新填写密钥');
  assert.equal(initial.elements['connection-detail'].textContent, '请重新保存当前企业的密钥');
  const edited = harness(); await flush(); edited.input('my-new-key');
  await edited.reply('OZON_UNIFIED_GET_CONNECTION', required);
  assert.equal(edited.elements['local-plugin-token'].value, 'my-new-key');
  const delayed = harness({ deferInitialStorage: true }); await flush(); delayed.refresh();
  await delayed.reply('OZON_UNIFIED_GET_CONNECTION', required);
  delayed.releaseStorage(); await flush();
  assert.equal(delayed.elements['local-plugin-token'].value, '');
});

test('local key save is independent of verification and later responses never overwrite an edited key', async () => {
  const h = harness(); await flush();
  await h.reply('OZON_UNIFIED_GET_CONNECTION', { success: true, connection: { configured: true, connected: true } });
  h.input('  first-key  ');
  const saving = h.click('save'); await flush();
  assert.equal(h.pending.find(item => item.message.type === 'OZON_UNIFIED_SAVE_KEY').message.key, 'first-key');
  assert.equal(h.elements.save.disabled, true);
  h.input('second-key');
  await h.reply('OZON_UNIFIED_SAVE_KEY', { success: true, connection: { configured: true, connected: false, lastError: '' } });
  await saving;
  assert.equal(h.elements.save.disabled, false);
  assert.equal(h.elements['local-plugin-token'].value, 'second-key');
  assert.match(h.elements['save-feedback'].textContent, /未保存修改/);
  assert.equal(h.elements['connection-status'].textContent, '正在验证密钥');
  h.refresh();
  await h.reply('OZON_UNIFIED_GET_CONNECTION', { success: true, connection: { configured: true, connected: false, lastError: '密钥未通过验证' } });
  assert.equal(h.elements['local-plugin-token'].value, 'second-key');
  assert.equal(h.elements['connection-status'].textContent, '连接未通过');
});

test('save failure and timeout restore the button, preserve edits and ignore a late save callback', async () => {
  const h = harness(); await flush(); h.input('first-key');
  h.setStorageError('storage write failed');
  await h.click('save');
  assert.equal(h.pending.some(item => item.message.type === 'OZON_UNIFIED_SAVE_KEY'), false);
  assert.equal(h.elements.save.disabled, false);
  assert.match(h.elements['save-feedback'].textContent, /storage write failed/);
  h.setStorageError('');
  const saving = h.click('save'); await flush();
  await h.expire('OZON_UNIFIED_SAVE_KEY'); await saving;
  assert.equal(h.elements.save.disabled, false);
  assert.match(h.elements['save-feedback'].textContent, /响应超时/);
  h.input('new-edit');
  await h.reply('OZON_UNIFIED_SAVE_KEY', { success: true, connection: { configured: true, connected: true } });
  assert.equal(h.elements['local-plugin-token'].value, 'new-edit');
  assert.equal(h.elements['save-feedback'].textContent, '密钥有未保存修改。');
});

test('an old connection request cannot replace the state returned by a newer key save', async () => {
  const h = harness(); await flush(); h.input('new-key');
  const saving = h.click('save'); await flush();
  await h.reply('OZON_UNIFIED_SAVE_KEY', { success: true, connection: { configured: true, connected: true } }); await saving;
  await h.reply('OZON_UNIFIED_GET_CONNECTION', { success: true, connection: { configured: false, connected: false } });
  assert.equal(h.elements['connection-status'].textContent, '已连接企业');
  assert.equal(h.elements['local-plugin-token'].value, 'new-key');
});

test('manual SKU, current-page collection and permission injection retain their existing messages', async () => {
  const h = harness(); await flush();
  h.elements['manual-skus'].value = '123,456\n123';
  const collecting = h.click('manual-sync'); await flush();
  const request = h.pending.find(item => item.message.type === 'OZON_ERP_COLLECT_MANUAL_DETAIL_SKUS');
  assert.deepEqual(Array.from(request.message.skus), ['123', '456']);
  h.progress({ sku: '123', status: 'success', text: '123 已采集' });
  assert.match(h.elements.status.textContent, /123 已采集/);
  await h.reply('OZON_ERP_COLLECT_MANUAL_DETAIL_SKUS', { success: true, successCount: 2 }); await collecting;
  await h.click('collect');
  assert.ok(h.tabMessages.some(item => item.tabId === 9 && item.message.type === 'OZON_ERP_MANUAL_COLLECT_DETAIL'));
  const granting = h.click('grant-ozon-access'); await flush();
  await h.reply('OZON_ERP_INJECT_ACTIVE_OZON_FRONT', { success: true, alreadyLoaded: true }); await granting;
  assert.match(h.elements.status.textContent, /已加载插件脚本/);
});

test('pool status distinguishes local registrations from server companies without claiming concurrent execution', async () => {
  const h = harness(); await flush();
  assert.match(html, /<details id="browser-pool-diagnostics">/);
  assert.equal((html.match(/type="password"/g) || []).length, 1);
  await h.reply('OZON_ERP_BROWSER_POOL_DIAGNOSTICS', { success: true, diagnostics: {
    phase: 'registered', localTabCount: 4, verifiedCompanyCount: 2, registeredCompanyCount: 2, serverCompanyCount: 5,
    checkedAt: Date.UTC(2026, 10, 5, 16, 4, 5), token: 'private-token', cookie: 'private-cookie', rawURL: 'https://private.example/path'
  } });
  assert.equal(h.elements['browser-pool-status'].textContent, '本机 2 公司已接入 / 服务端 5 公司可用');
  assert.equal(h.elements['browser-pool-status'].dataset.state, 'connected');
  assert.match(h.elements['browser-pool-detail'].textContent, /已核实 2 公司 · 已登记 2 公司/);
  assert.match(h.elements['browser-pool-detail'].textContent, /北京时间.*2026\/11\/6 00:04:05/);
  assert.match(h.elements['browser-pool-detail'].textContent, /不代表正在同时执行/);
  assert.doesNotMatch(h.elements['browser-pool-detail'].textContent, /private/);
  h.refresh();
  await h.reply('OZON_ERP_BROWSER_POOL_DIAGNOSTICS', { success: true, diagnostics: {
    phase: 'registered', registeredCompanyCount: 1, serverCompanyCount: null
  } });
  assert.match(h.elements['browser-pool-status'].textContent, /本机 1 公司已接入 \/ 服务端 待确认/);
});

test('pool failures give recovery steps while diagnostics do not expose raw addresses or credentials', async () => {
  const cases = [
    [{ phase: 'no_seller_tabs', lastErrorCode: 'NO_SELLER_TAB' }, /打开并登录 Seller/],
    [{ phase: 'identity_unavailable', lastErrorCode: 'STORE_IDENTITY_UNAVAILABLE' }, /刷新 Seller 分析页/],
    [{ phase: 'identity_unavailable', lastErrorCode: 'STORE_CONTEXT_MISMATCH' }, /核对 Seller 店铺/],
    [{ phase: 'identity_unavailable', lastErrorCode: 'SELLER_TAB_PERMISSION_DENIED' }, /允许插件访问 Seller/],
    [{ phase: 'registration_failed', lastErrorCode: 'COLLECTOR_BROWSER_SHOP_FORBIDDEN' }, /切换本企业店铺/]
  ];
  for (const [diagnostics, message] of cases) {
    const h = harness(); await flush();
    await h.reply('OZON_ERP_BROWSER_POOL_DIAGNOSTICS', { success: true, diagnostics: {
      ...diagnostics, lastError: '请求 https://private.example/?cookie=secret 失败，ozp_private_key'
    } });
    assert.match(h.elements['browser-pool-status'].textContent, message);
    assert.doesNotMatch(h.elements['browser-pool-detail'].textContent, /private|secret|ozp_/);
    assert.equal(h.elements['browser-pool-status'].dataset.state, 'error');
  }
});

test('pool reads stay single flight and a late timed out snapshot cannot replace a newer result', async () => {
  const h = harness(); await flush();
  h.refresh(); h.refresh(); h.refresh(); await flush();
  assert.equal(h.pending.filter(item => item.message.type === 'OZON_ERP_BROWSER_POOL_DIAGNOSTICS').length, 1);
  await h.expire('OZON_ERP_BROWSER_POOL_DIAGNOSTICS');
  assert.match(h.elements['browser-pool-status'].textContent, /暂未读取/);
  h.refresh(); await flush();
  await h.reply('OZON_ERP_BROWSER_POOL_DIAGNOSTICS', { success: true, diagnostics: { phase: 'no_seller_tabs' } });
  assert.match(h.elements['browser-pool-status'].textContent, /暂未读取/);
  await h.reply('OZON_ERP_BROWSER_POOL_DIAGNOSTICS', { success: true, diagnostics: {
    phase: 'registered', registeredCompanyCount: 1, serverCompanyCount: 3
  } });
  assert.match(h.elements['browser-pool-status'].textContent, /本机 1 公司已接入 \/ 服务端 3 公司可用/);
});

test('pool reconnect is a local message that preserves edits and ignores a pre-reconnect snapshot', async () => {
  const h = harness(); await flush(); h.input('unsaved-enterprise-key');
  const reconnecting = h.click('browser-pool-reconnect'); await flush();
  assert.equal(h.elements['browser-pool-reconnect'].disabled, true);
  const request = h.pending.find(item => item.message.type === 'OZON_ERP_BROWSER_POOL_RECONNECT');
  assert.deepEqual(Object.keys(request.message), ['type']);
  await h.reply('OZON_ERP_BROWSER_POOL_RECONNECT', { success: true, diagnostics: {
    phase: 'registered', registeredCompanyCount: 1, serverCompanyCount: 2
  } });
  await reconnecting;
  await h.reply('OZON_ERP_BROWSER_POOL_DIAGNOSTICS', { success: true, diagnostics: { phase: 'no_seller_tabs' } });
  assert.match(h.elements['browser-pool-status'].textContent, /本机 1 公司已接入/);
  assert.equal(h.elements['browser-pool-reconnect'].disabled, false);
  assert.equal(h.elements['local-plugin-token'].value, 'unsaved-enterprise-key');
  assert.equal(h.writes.length, 0);
  assert.equal(h.opened.length, 0);
  assert.equal(h.tabMessages.some(item => /NAVIGATE|REFRESH/.test(item.message.type)), false);
});

test('pool reconnect timeout restores its button and key saves invalidate old enterprise diagnostics', async () => {
  const h = harness(); await flush();
  const reconnecting = h.click('browser-pool-reconnect'); await flush();
  await h.expire('OZON_ERP_BROWSER_POOL_RECONNECT'); await reconnecting;
  assert.equal(h.elements['browser-pool-reconnect'].disabled, false);
  assert.match(h.elements['browser-pool-status'].textContent, /重连请求未完成/);
  await h.reply('OZON_ERP_BROWSER_POOL_RECONNECT', { success: true, diagnostics: {
    phase: 'registered', registeredCompanyCount: 9, serverCompanyCount: 9
  } });
  assert.doesNotMatch(h.elements['browser-pool-status'].textContent, /9/);
  h.input('new-key');
  const saving = h.click('save'); await flush();
  await h.reply('OZON_ERP_BROWSER_POOL_DIAGNOSTICS', { success: true, diagnostics: {
    phase: 'registered', registeredCompanyCount: 8, serverCompanyCount: 8
  } });
  await h.reply('OZON_UNIFIED_SAVE_KEY', { success: true, connection: { configured: true, connected: false } });
  await saving;
  assert.match(h.elements['browser-pool-status'].textContent, /正在检查/);
  assert.doesNotMatch(h.elements['browser-pool-detail'].textContent, /8 公司/);
  assert.equal(h.elements['local-plugin-token'].value, 'new-key');
});

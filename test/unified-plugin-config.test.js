import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync('ozon-erp-collector-plugin/unified-config.js', 'utf8');
const TOKEN = 'ozon-erp-local-plugin-token';
const KEY_A = 'ozp_' + 'a'.repeat(43);
const KEY_B = 'ozp_' + 'b'.repeat(43);
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ stored = {}, fetchImpl, timeoutMs = 1000, crypto = webcrypto, storageSet } = {}) {
  const values = { ...stored }, listeners = [], requests = [];
  const chrome = {
    runtime: {
      id: 'unified-fixture', getManifest: () => ({ version: '1.5.0' }),
      getURL: path => 'chrome-extension://unified-fixture/' + path,
      onMessage: { addListener: callback => listeners.push(callback) }
    },
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, values[key]])),
      set: async patch => storageSet ? storageSet(values, patch) : Object.assign(values, patch)
    } }
  };
  const context = { crypto, TextEncoder, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  const client = context.OzonUnifiedConfig.create({ chrome, timeoutMs, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return fetchImpl ? fetchImpl(url, init) : { ok: true, json: async () => ({ success: true, data: { connected: true, app: 'ozon-erp', tenantId: '42' } }) };
  } });
  return { client, chrome, values, requests, listeners };
}

test('one key saves locally before network completion and derives enterprise from the existing authenticated status endpoint', async () => {
  let release, started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const h = fixture({ fetchImpl: () => new Promise(resolve => {
    release = () => resolve({ ok: true, json: async () => ({ success: true, data: { connected: true, app: 'ozon-erp', tenantId: '73' } }) });
    started();
  }) });
  const saved = await h.client.saveKey(KEY_A);
  assert.equal(saved.configured, true);
  assert.equal(saved.connected, false);
  assert.equal(h.values[TOKEN], KEY_A);
  assert.doesNotMatch(JSON.stringify(saved), /ozp_/);
  await requestStarted;
  assert.equal(h.requests[0].url, 'https://erp.hjt888.xyz/api/local-plugin/plugin/status?plugin_version=1.5.0');
  assert.equal(h.requests[0].init.headers['x-local-plugin-token'], KEY_A);
  assert.equal(h.requests[0].init.headers['x-tenant-id'], undefined);
  release();
  await h.client.refresh();
  const config = await h.client.get();
  assert.equal(config.tenantId, '73');
  assert.equal(config.erpBaseUrl, 'https://erp.hjt888.xyz');
  assert.equal((await h.client.connection()).connected, true);
  assert.equal(h.values['pivot-erp-local-plugin-token'], undefined);
});

test('existing product keys are preserved while explicit empty keys never resurrect a separate analytics token', async () => {
  const existing = fixture({ stored: { [TOKEN]: KEY_A } });
  assert.equal((await existing.client.get()).localPluginToken, KEY_A);
  const cleared = fixture({ stored: { [TOKEN]: '', 'pivot-erp-local-plugin-token': KEY_B } });
  assert.equal((await cleared.client.get()).localPluginToken, '');
  assert.equal((await cleared.client.connection()).configured, false);
  await flush();
  assert.equal(cleared.requests.length, 0);
});

test('a key from another ERP origin is not sent to the fixed production service until the user explicitly saves a key', async () => {
  const h = fixture({ stored: { [TOKEN]: KEY_A, 'ozon-erp-base-url': 'https://other.example' } });
  assert.equal((await h.client.get()).localPluginToken, '');
  assert.equal((await h.client.connection()).requiresKeyEntry, true);
  await flush();
  assert.equal(h.requests.length, 0);
  await h.client.saveKey(KEY_B);
  await h.client.refresh();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.headers['x-local-plugin-token'], KEY_B);
});

test('invalid keys fail before persistence or any network request', async () => {
  const h = fixture({ stored: { [TOKEN]: KEY_A } });
  await assert.rejects(h.client.saveKey('not-a-key'), /完整企业密钥/);
  assert.equal(h.values[TOKEN], KEY_A);
  assert.equal(h.requests.length, 0);
});

test('stalled response bodies have a total deadline and leave the saved key intact', async () => {
  const h = fixture({ timeoutMs: 25, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  await h.client.saveKey(KEY_A);
  const connection = await h.client.refresh();
  assert.equal(connection.connected, false);
  assert.match(connection.lastError, /密钥已保存/);
  assert.equal(h.values[TOKEN], KEY_A);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.doesNotMatch(JSON.stringify(connection), /ozp_/);
});

test('an expired or unauthorized key cannot supply an enterprise selector', async () => {
  const h = fixture({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  await h.client.saveKey(KEY_A);
  const connection = await h.client.refresh();
  assert.equal(connection.connected, false);
  assert.equal(connection.tenantId, '');
  assert.match(connection.lastError, /密钥无效/);
});

test('a delayed response for a replaced key cannot restore the old enterprise', async () => {
  let releaseA, seenA;
  const requestA = new Promise(resolve => { seenA = resolve; });
  const h = fixture({ fetchImpl: async (_url, init) => {
    if (init.headers['x-local-plugin-token'] === KEY_A) return new Promise(resolve => {
      releaseA = () => resolve({ ok: true, json: async () => ({ data: { connected: true, app: 'ozon-erp', tenantId: 'old-enterprise' } }) });
      seenA();
    });
    return { ok: true, json: async () => ({ data: { connected: true, app: 'ozon-erp', tenantId: 'new-enterprise' } }) };
  } });
  await h.client.saveKey(KEY_A);
  await requestA;
  await h.client.saveKey(KEY_B);
  await h.client.refresh();
  releaseA();
  await flush(); await flush();
  assert.equal((await h.client.get()).tenantId, 'new-enterprise');
  assert.equal(h.values[TOKEN], KEY_B);
});

test('only the extension popup can change its one-key connection and replies contain no key', async () => {
  const h = fixture();
  h.client.attach();
  const listener = h.listeners[0];
  let rejected;
  assert.equal(listener({ type: 'OZON_UNIFIED_SAVE_KEY', key: KEY_A }, {
    id: h.chrome.runtime.id, url: 'https://erp.hjt888.xyz/', tab: { id: 1 }
  }, response => { rejected = response; }), false);
  assert.equal(rejected.success, false);
  assert.equal(h.values[TOKEN], undefined);
  const response = await new Promise(resolve => {
    assert.equal(listener({ type: 'OZON_UNIFIED_SAVE_KEY', key: KEY_A }, {
      id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('popup.html')
    }, resolve), true);
  });
  assert.equal(response.success, true);
  assert.doesNotMatch(JSON.stringify(response), /ozp_/);
  await h.client.refresh();
});

test('content URL helpers pin the service and reject a foreign fallback target', () => {
  const context = { URL };
  vm.runInNewContext(readFileSync('ozon-erp-collector-plugin/erp-config.js', 'utf8'), context);
  const config = context.OzonErpCollectorConfig;
  assert.equal(config.normalizeErpBaseUrl('https://other.example'), 'https://erp.hjt888.xyz');
  assert.equal(config.resolveLocalPluginApiBaseUrl('https://other.example'), 'https://erp.hjt888.xyz/api/local-plugin');
  assert.equal(config.isAllowedLocalPluginUrl('https://other.example/api/local-plugin/plugin/status', 'https://other.example'), false);
  assert.equal(config.isAllowedLocalPluginUrl('https://erp.hjt888.xyz/api/local-plugin/plugin/status', 'https://other.example'), true);
  assert.equal(config.isAllowedErpApiUrl('https://other.example/api/products', 'https://other.example'), false);
});

test('the real content token helper blocks a key associated with another ERP host', async () => {
  const content = readFileSync('ozon-erp-collector-plugin/content.js', 'utf8');
  const start = content.indexOf('  async function withLocalPluginTokenHeader(');
  const end = content.indexOf('  async function localPluginFetch(', start);
  assert.ok(start > 0 && end > start);
  const stored = { [TOKEN]: KEY_A, 'ozon-erp-base-url': 'https://other.example' };
  const helper = vm.runInNewContext(content.slice(start, end) + '\nwithLocalPluginTokenHeader', {
    chrome: { storage: { local: { get: async () => stored } } },
    LOCAL_PLUGIN_TOKEN_STORAGE_KEY: TOKEN, ERP_BASE_URL_STORAGE_KEY: 'ozon-erp-base-url',
    DEFAULT_LOCAL_PLUGIN_TOKEN: '', DEFAULT_ERP_BASE_URL: 'https://erp.hjt888.xyz'
  });
  await assert.rejects(helper(), /重新填写企业密钥/);
  stored['ozon-erp-base-url'] = 'https://erp.hjt888.xyz';
  assert.equal((await helper()).headers['x-local-plugin-token'], KEY_A);
});

test('concurrent saves retain the latest key even when the older fingerprint finishes last', async () => {
  let releaseOld;
  const h = fixture({ crypto: { subtle: { digest: (algorithm, bytes) => {
    if (new TextDecoder().decode(bytes) !== KEY_A) return webcrypto.subtle.digest(algorithm, bytes);
    return new Promise(resolve => { releaseOld = async () => resolve(await webcrypto.subtle.digest(algorithm, bytes)); });
  } } } });
  const oldSave = h.client.saveKey(KEY_A);
  await h.client.saveKey(KEY_B);
  await releaseOld();
  await oldSave;
  await h.client.refresh();
  assert.equal(h.values[TOKEN], KEY_B);
  assert.equal((await h.client.get()).localPluginToken, KEY_B);
  assert.ok(h.requests.every(request => request.init.headers['x-local-plugin-token'] === KEY_B));
});

test('configuration writes are serialized so a pending older storage write cannot replace the latest key', async () => {
  let releaseOld, oldStarted;
  const entered = new Promise(resolve => { oldStarted = resolve; });
  const h = fixture({ storageSet: async (values, patch) => {
    if (patch[TOKEN] === KEY_A) {
      oldStarted();
      await new Promise(resolve => { releaseOld = resolve; });
    }
    Object.assign(values, patch);
  } });
  const oldSave = h.client.saveKey(KEY_A);
  await entered;
  const latestSave = h.client.saveKey(KEY_B);
  releaseOld();
  await Promise.all([oldSave, latestSave]);
  await h.client.refresh();
  assert.equal(h.values[TOKEN], KEY_B);
  assert.equal((await h.client.connection()).connected, true);
});

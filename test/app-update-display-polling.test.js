import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createDisplayReadScope } from '../frontend/admin/utils/display-read-scope.js';

const source = fs.readFileSync(new URL('../frontend/admin/App.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*;\r?$/gm, '').replaceAll('import.meta.env', 'IMPORT_ENV');
const tick = () => new Promise(resolve => setImmediate(resolve));
function events(extra = {}) {
  const listeners = new Map();
  return { ...extra, listeners, emitted: [],
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    dispatchEvent(event) { this.emitted.push(event); for (const handler of listeners.get(event.type) || []) handler(event); }
  };
}
function fixture({ hidden = false, read = async () => ({}) } = {}) {
  const timers = new Map(), requests = [], streams = [], hooks = {};
  let timerId = 0, scope = 'A';
  const document = events({ visibilityState: hidden ? 'hidden' : 'visible' });
  const window = events({ location: { origin: 'http://localhost:8788' }, postMessage() {},
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay, interval: true }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id)
  });
  class EventSource {
    constructor(url) { this.url = url; streams.push(this); }
    addEventListener() {}
    close() { this.closed = true; }
  }
  const context = vm.createContext({ window, document, EventSource, URLSearchParams, AbortController, DOMException,
    IMPORT_ENV: {}, __APP_RELEASE_VERSION__: 'test', __APP_RELEASE_CHANNEL__: 'test', zhCn: {},
    console: { warn() {} }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    ref: value => ({ value }), computed: read => ({ get value() { return read(); } }), h() {}, watch() {},
    onMounted: fn => { hooks.mount = fn; }, onBeforeUnmount: fn => { hooks.dispose = fn; },
    useRoute: () => ({ fullPath: '/' }), useRouter: () => ({ push() {} }), useGlobalImagePreviewDismiss() {},
    useAuthStore: () => ({ isAuthenticated: true, user: { id: 1, tenant: { id: 2 } }, bootstrap: async () => {} }),
    getAuthToken: () => 'synthetic-session', currentApiCacheScope: () => scope, createDisplayReadScope,
    sessionStorage: { getItem() { return null; } },
    apiClient: { get(url, options) { const request = { url, options }; requests.push(request); return read(request); } }
  });
  vm.runInContext(script + '\nglobalThis.subject={checkUpdateStatus,resetUpdateEventStreamForAuthScope,syncAnalyticsPluginUpdate,setPluginIdentity(){analyticsPluginIdentity={id:"synthetic-plugin",scope:currentApiCacheScope()};}};', context);
  return { timers, requests, streams, window, document, subject: context.subject,
    mount: () => hooks.mount(), dispose: () => hooks.dispose(),
    async visibility(value) { document.visibilityState = value; document.dispatchEvent({ type: 'visibilitychange' }); await tick(); },
    async verified() { window.dispatchEvent({ type: 'erp:auth-verified' }); await tick(); },
    async runInitial() { const [id, item] = [...timers].find(([, timer]) => !timer.interval) || []; assert.ok(item); timers.delete(id); await item.fn(); await tick(); },
    changeScope(value) { scope = value; context.subject.resetUpdateEventStreamForAuthScope(); }
  };
}

test('global update polling pauses while hidden, resumes once, and preserves an existing low-traffic SSE', async () => {
  const f = fixture(); await f.mount(); await f.runInitial();
  assert.equal(f.requests.length, 1); assert.equal(f.streams.length, 1);
  await f.visibility('hidden'); assert.equal(f.timers.size, 0); assert.equal(f.streams[0].closed, undefined);
  await f.subject.checkUpdateStatus(); assert.equal(f.requests.length, 1);
  await f.visibility('visible'); await f.runInitial();
  assert.equal(f.requests.length, 2); assert.equal(f.streams.length, 1); assert.equal(f.timers.size, 1);
  f.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.streams[0].closed, true);
  assert.equal([...f.window.listeners.values(), ...f.document.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
});

for (const status of [401, 403]) test(`global update HTTP ${status} stops retries until successful identity verification`, async () => {
  let rejected = true;
  const f = fixture({ read: async () => { if (rejected) throw Object.assign(new Error('denied'), { status }); return {}; } });
  await f.mount(); await f.runInitial(); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
  await f.subject.checkUpdateStatus(); await f.visibility('hidden'); await f.visibility('visible');
  assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
  rejected = false; await f.verified(); await f.runInitial(); assert.equal(f.requests.length, 2);
  f.dispose();
});

test('an aborted old initial check cannot reinstall another timer or apply stale-scope updates', async () => {
  let resolve;
  const f = fixture({ read: () => new Promise(done => { resolve = done; }) });
  await f.mount(); const initial = f.runInitial(); await tick();
  assert.equal(f.requests.length, 1);
  await f.visibility('hidden'); assert.equal(f.requests[0].options.signal.aborted, true);
  await f.visibility('visible'); f.changeScope('B');
  resolve({ app: { update_required: true } }); await initial;
  assert.equal(f.streams.length, 0); assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()].some(timer => timer.interval), false);
  f.dispose();
});

test('initially hidden app creates no polling or event connection until visible', async () => {
  const f = fixture({ hidden: true }); await f.mount();
  assert.equal(f.timers.size, 0); assert.equal(f.requests.length, 0); assert.equal(f.streams.length, 0);
  await f.visibility('visible'); await f.runInitial(); assert.equal(f.requests.length, 1);
  f.dispose();
});

for (const stage of ['identity', 'version']) test(`hiding during plugin ${stage} lookup cancels the chain without stale events`, async () => {
  let resolve;
  const f = fixture({ read: request => stage === 'version' && request.url.includes('/plugin-status?')
    ? Promise.resolve({ plugin_version: '1.0' }) : new Promise(done => { resolve = done; }) });
  await f.mount(); f.subject.setPluginIdentity();
  const work = f.subject.syncAnalyticsPluginUpdate({ analytics_plugin: { version: '2.0' } }); await tick();
  const count = stage === 'identity' ? 1 : 2;
  assert.equal(f.requests.length, count);
  await f.visibility('hidden'); assert.equal(f.requests.at(-1).options.signal.aborted, true);
  resolve({ plugin_version: '1.0', analytics_plugin: { update_available: true } }); await work;
  assert.equal(f.requests.length, count);
  assert.equal(f.window.emitted.filter(event => /app:plugin-update/.test(event.type)).length, 0);
  f.dispose();
});

test('plugin-only 403 pauses that lookup while the main update poll remains usable', async () => {
  const f = fixture({ read: async request => {
    if (request.url.includes('/plugin-status?')) throw Object.assign(new Error('plugin forbidden'), { status: 403 });
    return {};
  } });
  await f.mount(); f.subject.setPluginIdentity();
  const status = { analytics_plugin: { version: '2.0' } };
  await f.subject.syncAnalyticsPluginUpdate(status); await f.subject.syncAnalyticsPluginUpdate(status);
  assert.equal(f.requests.length, 1);
  await f.subject.checkUpdateStatus(); assert.equal(f.requests.length, 2); assert.equal(f.streams.length, 1);
  await f.verified(); await f.subject.syncAnalyticsPluginUpdate(status);
  assert.equal(f.requests.filter(request => request.url.includes('/plugin-status?')).length, 2);
  f.dispose();
});

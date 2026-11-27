import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { wbRecordMatches, wbRecordCanDelete } from '../frontend/admin/utils/wb-publish-record-view.js';

const component = readFileSync(new URL('../frontend/admin/views/inventory/WbPublishRecordsView.vue', import.meta.url), 'utf8');
const script = component.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?$/gm, '');
const record = (id = 1, status = 'processing') => ({ id, status, shop_id: 2, products: [] });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function events(values = {}) {
  const listeners = new Map();
  return { ...values, listeners,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name) { for (const callback of listeners.get(name) || []) callback({ type: name }); }
  };
}
function fixture({ hidden = false, get = async () => ({ rows: [record()] }), post = async () => ({ job: record(1, 'completed') }) } = {}) {
  const hooks = {}, timers = new Map(), reads = [], writes = [], errors = [];
  let timerId = 0, scope = 'tenant-A', token = 'fixture-session';
  const window = events(), document = events({ visibilityState: hidden ? 'hidden' : 'visible' });
  const context = vm.createContext({ window, document, AbortController, Number, Map, Set,
    ref: value => ({ value }), computed: read => Object.defineProperty({}, 'value', { get: read }), watch: () => {},
    onMounted: callback => { hooks.mount = callback; }, onActivated: callback => { hooks.activate = callback; },
    onDeactivated: callback => { hooks.deactivate = callback; }, onBeforeUnmount: callback => { hooks.dispose = callback; },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), useRouter: () => ({ push: () => {} }),
    currentApiCacheScope: () => scope, getAuthToken: () => token, wbRecordMatches, wbRecordCanDelete,
    ElMessage: { error: message => errors.push(message), warning: () => {}, success: () => {} },
    ElMessageBox: { confirm: async () => {} },
    apiClient: {
      get: (url, options) => { const request = { url, options }; reads.push(request); return get(request); },
      post: (url, body, options) => { const request = { url, body, options }; writes.push(request); return post(request); }
    }
  });
  vm.runInContext(script + '\nglobalThis.view = { load, sync, remove, resume, rows, loading, syncingId, deletingId, resumingId, working };', context);
  return { view: context.view, reads, writes, errors, timers, hooks,
    async mount() { hooks.mount(); hooks.activate(); await flush(); },
    async hide() { document.visibilityState = 'hidden'; document.emit('visibilitychange'); await flush(); },
    async show() { document.visibilityState = 'visible'; document.emit('visibilitychange'); await flush(); },
    async runTimer() { const [id, item] = timers.entries().next().value || []; assert.ok(item, 'a refresh must be scheduled'); timers.delete(id); item.callback(); await flush(); },
    async emit(name) { window.emit(name); await flush(); },
    changeScope(value, session = 'fixture-session') { scope = value; token = session; },
    async dispose() { hooks.dispose(); await flush(); },
    listenerCount: () => [...window.listeners.values(), ...document.listeners.values()].reduce((total, list) => total + list.size, 0)
  };
}

test('WB records pause on hidden/deactivated views and catch up once when visible/activated', async () => {
  const page = fixture();
  await page.mount();
  assert.equal(page.reads.length, 1, 'initial KeepAlive activation must not duplicate mount');
  assert.equal([...page.timers.values()][0].delay, 10000);
  await page.hide();
  assert.equal(page.timers.size, 0);
  await page.show();
  assert.equal(page.reads.length, 2);
  page.hooks.deactivate();
  assert.equal(page.timers.size, 0);
  await page.hide(); await page.show();
  assert.equal(page.reads.length, 2, 'visible browser tabs must not wake a deactivated route');
  page.hooks.activate(); await flush();
  assert.equal(page.reads.length, 3);
  await page.runTimer();
  assert.equal(page.reads.length, 4);
  assert.ok(page.reads.every(read => read.url === '/api/wb/publish-records' && read.options.noCache && read.options.signal));
  await page.dispose();
  assert.equal(page.listenerCount(), 0); assert.equal(page.timers.size, 0);
  await page.hide(); await page.show(); page.hooks.activate(); await flush();
  assert.equal(page.reads.length, 4);
});

test('an initially hidden WB records view waits for visibility before its first read', async () => {
  const page = fixture({ hidden: true });
  await page.mount();
  assert.equal(page.reads.length, 0);
  await page.show(); assert.equal(page.reads.length, 1);
  await page.dispose();
});

test('replacing, hiding and leaving WB records aborts only reads and rejects late stale responses', async () => {
  const pending = [];
  const page = fixture({ get: () => { const request = deferred(); pending.push(request); return request.promise; } });
  await page.mount();
  const replacement = page.view.load();
  assert.equal(page.reads[0].options.signal.aborted, true);
  pending[1].resolve({ rows: [record(2)] }); await replacement;
  pending[0].resolve({ rows: [record(1)] }); await flush();
  assert.equal(page.view.rows.value[0].id, 2);
  const hiddenRead = page.view.load();
  await page.hide();
  assert.equal(page.reads[2].options.signal.aborted, true); assert.equal(page.view.loading.value, false);
  pending[2].resolve({ rows: [record(3)] }); await hiddenRead;
  assert.equal(page.view.rows.value[0].id, 2);
  await page.show(); page.hooks.deactivate();
  assert.equal(page.reads[3].options.signal.aborted, true);
  pending[3].resolve({ rows: [record(4)] }); await flush();
  assert.equal(page.view.rows.value[0].id, 2); assert.equal(page.errors.length, 0); assert.equal(page.timers.size, 0);
  await page.dispose();
});

for (const status of [401, 403]) test(`HTTP ${status} pauses WB reads until authentication is verified again`, async () => {
  let allowed = false;
  const page = fixture({ get: async () => { if (!allowed) throw Object.assign(new Error('fixture access rejected'), { status }); return { rows: [record()] }; } });
  await page.mount();
  assert.equal(page.reads.length, 1); assert.equal(page.timers.size, 0);
  await page.view.load(); await page.hide(); await page.show(); page.hooks.deactivate(); page.hooks.activate(); await flush();
  assert.equal(page.reads.length, 1, 'visibility and manual refresh cannot clear a rejected authority');
  allowed = true;
  await page.emit('erp:auth-verified');
  assert.equal(page.reads.length, 2); assert.equal(page.view.rows.value.length, 1);
  await page.dispose();
});

test('auth scope reset clears old WB records, waits while hidden/logged out and recovers under the new scope', async () => {
  const page = fixture();
  await page.mount(); await page.hide();
  page.changeScope('logged-out', ''); await page.emit('erp:auth-scope-changed');
  assert.equal(page.view.rows.value.length, 0);
  await page.show(); assert.equal(page.reads.length, 1);
  page.changeScope('tenant-B'); await page.emit('erp:auth-scope-changed');
  assert.equal(page.reads.length, 2); assert.equal(page.view.rows.value.length, 1);
  await page.dispose();
});

for (const action of ['sync', 'remove', 'resume']) test(`pausing a WB view does not abort or strand the ${action} business action`, async () => {
  const pending = deferred(), existing = record(1, 'completed');
  const page = fixture({ get: async () => ({ rows: [existing] }), post: () => pending.promise });
  await page.mount();
  const operation = page.view[action](existing);
  await flush(); assert.equal(page.writes.length, 1); assert.equal(page.view.working.value, true);
  assert.equal(page.writes[0].options?.signal, undefined, 'display cancellation must never cancel business requests');
  await page.hide(); page.hooks.deactivate(); page.hooks.activate(); await page.show();
  assert.equal(page.reads.length, 1, 'catch-up waits for the business action to finish');
  pending.resolve({ ok: true, job: record(1, 'completed') });
  await operation; await flush();
  assert.equal(page.view.working.value, false);
  if (action !== 'resume') await page.runTimer();
  assert.equal(page.reads.length, 2);
  assert.equal(page.writes.length, 1);
  assert.ok(!page.writes.some(write => /cancel/.test(write.url)));
  await page.dispose();
});

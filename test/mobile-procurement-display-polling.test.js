import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createDisplayReadScope } from '../frontend/admin/utils/display-read-scope.js';
import { hasPermission } from '../src/shared/permissions.js';
import { inventorySearchDefaults, appendInventorySearch } from '../src/shared/inventory-search-fields.js';

const source = readFileSync(new URL('../frontend/admin/components/mobile/MobileWorkQueue.vue', import.meta.url), 'utf8');
const body = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\r?\n/gm, '');
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function emitter(extra = {}) {
  const listeners = new Map();
  return { ...extra, listeners, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }, dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); } };
}
function fixture({ hidden = false, get = async () => ({ rows: [], total: 0 }), post = async () => ({ ok: true }) } = {}) {
  const requests = [], writes = [], timers = new Map(), hooks = {}, watchers = [];
  let scope = 'tenant-A', token = 'fixture-session', timerId = 0;
  const auth = { user: { id: 7, roles: ['procurement', 'packing'], tenant: { id: 2, role: 'member' } } };
  const document = emitter({ visibilityState: hidden ? 'hidden' : 'visible', querySelector: () => null });
  const window = emitter({ setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  const context = vm.createContext({ document, window, URLSearchParams, AbortController, Date,
    computed: read => ({ get value() { return read(); } }), ref: value => ({ value }), reactive: value => value,
    watch: (target, fn) => watchers.push({ target, fn }), defineProps: () => ({ warehouse: false }), defineAsyncComponent: () => ({}),
    onMounted: fn => { hooks.mount = fn; }, onActivated: fn => { hooks.activate = fn; }, onDeactivated: fn => { hooks.deactivate = fn; }, onBeforeUnmount: fn => { hooks.dispose = fn; },
    useAuthStore: () => auth, createDisplayReadScope, hasPermission, inventorySearchDefaults, appendInventorySearch,
    currentApiCacheScope: () => scope, getAuthToken: () => token, ElMessage: { success() {}, error() {}, info() {}, warning() {} },
    apiClient: { get: (url, options) => { const request = { url, options }; requests.push(request); return get(request); },
      post: (url, data) => { writes.push({ url, data }); return post(url, data); } }
  });
  vm.runInContext(body + '\nglobalThis.subject={load,changed,changePage,saveLogistics,rows,page,pageSize,tab,snapshot,error,loading,edit,busy,selected,purchaseSelected,demandWaitExceeded,canReadLists,canPurchase,canReceive};', context);
  const subject = context.subject;
  return { subject, requests, writes, timers, window, document, auth,
    async mount() { hooks.mount(); hooks.activate(); await tick(); },
    async visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent({ type: 'visibilitychange' }); await tick(); },
    async deactivate() { hooks.deactivate(); await tick(); }, async activate() { hooks.activate(); await tick(); }, dispose: () => hooks.dispose(),
    async tab(value) { subject.tab.value = value; watchers.find(w => w.target === subject.tab).fn(); await tick(); },
    async poll() { const item = [...timers].find(([, value]) => value.delay === 8000); assert.ok(item, 'expected a snapshot follow-up'); timers.delete(item[0]); await item[1].fn(); await tick(); },
    async verified() { window.dispatchEvent({ type: 'erp:auth-verified' }); await tick(); },
    scope(value, nextToken = token) { scope = value; token = nextToken; window.dispatchEvent({ type: 'erp:auth-scope-changed' }); },
    async roles(values) { auth.user.roles = values; watchers.find(w => Array.isArray(w.target)).fn(); await tick(); }
  };
}
const query = request => new URL(request.url, 'http://localhost:8788');

test('mobile tabs keep their paged API contracts and only explicit refresh starts demand rebuilding', async () => {
  const f = fixture(); await f.mount(); assert.equal(f.requests.length, 1);
  let url = query(f.requests.at(-1)); assert.equal(url.pathname, '/api/products');
  for (const [key, value] of Object.entries({ paged: '1', view: 'inventory', includeStock: '0', page: '1', pageSize: '20', searchMode: 'inventory_id' })) assert.equal(url.searchParams.get(key), value);
  for (const tab of ['required', 'advisory']) {
    await f.tab(tab); url = query(f.requests.at(-1)); assert.equal(url.pathname, '/api/inventory-workflow/alerts');
    for (const [key, value] of Object.entries({ view: 'workspace', compact: '1', task: tab, snapshot_only: '1' })) assert.equal(url.searchParams.get(key), value);
    await f.subject.changePage({ page: 2, pageSize: 50 }); url = query(f.requests.at(-1));
    assert.equal(url.searchParams.get('page'), '2'); assert.equal(url.searchParams.get('pageSize'), '50'); assert.equal(url.searchParams.has('refresh'), false);
    await f.subject.load(false, true); assert.equal(query(f.requests.at(-1)).searchParams.get('refresh'), '1');
  }
  await f.tab('pending'); url = query(f.requests.at(-1)); assert.equal(url.pathname, '/api/inventory-workflow/purchase-arrivals');
  assert.equal(url.searchParams.get('status'), 'pending'); assert.equal(url.searchParams.get('day_mode'), 'pending');
  await f.tab('history'); url = query(f.requests.at(-1)); assert.equal(url.searchParams.get('status'), 'all'); assert.equal(url.searchParams.get('recent'), '1');
  assert.equal(url.searchParams.has('day_mode'), false); assert.equal(f.writes.length, 0); f.dispose();
});

test('hidden and KeepAlive-inactive mobile queues stop polls and resume with one non-refresh read', async () => {
  const f = fixture({ get: async () => ({ rows: [], snapshot: { available: true, refreshing: true } }) });
  await f.mount(); await f.tab('required'); await f.poll(); assert.equal(query(f.requests.at(-1)).searchParams.get('poll_snapshot'), '1');
  await f.visible(false); const count = f.requests.length; assert.equal(f.timers.size, 0);
  await f.subject.load(false, true); assert.equal(f.requests.length, count);
  await f.visible(true); assert.equal(f.requests.length, count + 1); assert.equal(query(f.requests.at(-1)).searchParams.has('refresh'), false);
  await f.deactivate(); assert.equal(f.timers.size, 0); await f.visible(false); await f.visible(true); assert.equal(f.requests.length, count + 1);
  await f.activate(); assert.equal(f.requests.length, count + 2); await f.activate(); assert.equal(f.requests.length, count + 2); f.dispose();
  assert.equal(f.timers.size, 0); assert.equal([...f.window.listeners.values(), ...f.document.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
});

test('an initially hidden queue waits for visibility before its first read', async () => {
  const f = fixture({ hidden: true }); await f.mount(); assert.equal(f.requests.length, 0);
  await f.visible(true); assert.equal(f.requests.length, 1); f.dispose();
});

test('a late aborted list cannot replace resumed mobile rows or clear a newer loading state', async () => {
  const pending = [];
  const f = fixture({ get: () => new Promise(resolve => pending.push(resolve)) }); await f.mount();
  await f.visible(false); assert.equal(f.requests[0].options.signal.aborted, true); await f.visible(true);
  pending[0]({ rows: [{ id: 1, name: 'obsolete' }], total: 1 }); await tick();
  assert.equal(f.subject.rows.value.length, 0); assert.equal(f.subject.loading.value, true);
  pending[1]({ rows: [{ id: 2, name: 'current' }], total: 1 }); await tick();
  assert.equal(f.subject.rows.value[0].product_id, 2); assert.equal(f.subject.loading.value, false); f.dispose();
});

for (const status of [401, 403]) test(`mobile HTTP ${status} blocks list reads until verified authority returns`, async () => {
  let denied = true;
  const f = fixture({ get: async () => { if (denied) throw Object.assign(new Error('fixture denied'), { status }); return { rows: [{ id: 2 }], total: 1 }; } });
  await f.mount(); assert.equal(f.requests.length, 1); assert.equal(f.subject.rows.value.length, 0);
  await f.subject.load(); await f.visible(false); await f.visible(true); await f.deactivate(); await f.activate(); assert.equal(f.requests.length, 1);
  denied = false; await f.verified(); assert.equal(f.requests.length, 2); assert.equal(f.subject.rows.value[0].product_id, 2);
  await f.verified(); assert.equal(f.requests.length, 2, 'unblocked auth verification must not add another refresh'); f.dispose();
});

test('snapshot follow-up denial stops the chain and scope changes cannot apply an earlier response', async () => {
  let pending, denied = false;
  const f = fixture({ get: request => {
    if (query(request).searchParams.has('poll_snapshot')) return Promise.reject(Object.assign(new Error('denied poll'), { status: 403 }));
    if (denied) return new Promise(resolve => { pending = resolve; });
    return Promise.resolve({ rows: [], snapshot: { available: true, refreshing: true } });
  } });
  await f.mount(); await f.tab('required'); await f.poll(); assert.equal(f.timers.size, 0); const count = f.requests.length;
  denied = true; await f.verified(); assert.equal(f.requests.length, count + 1); f.scope('tenant-B');
  pending({ rows: [{ product_id: 77 }], snapshot: { refreshing: true } }); await tick();
  assert.equal(f.subject.rows.value.length, 0); assert.equal(f.timers.size, 0);
  denied = false; await f.verified(); assert.equal(f.requests.length, count + 2); f.dispose();
});

test('a changed scope blocks paging, manual reads and role watchers until verification, including while hidden', async () => {
  const f = fixture(); await f.mount(); const before = f.requests.length;
  f.scope('tenant-B'); await f.subject.changePage({ page: 2, pageSize: 50 }); await f.subject.load();
  await f.roles(['packing']); assert.equal(f.requests.length, before);
  await f.verified(); assert.equal(f.requests.length, before + 1); await f.verified(); assert.equal(f.requests.length, before + 1);
  await f.visible(false); f.scope('tenant-C'); await f.subject.load(); await f.verified(); assert.equal(f.requests.length, before + 1);
  await f.visible(true); assert.equal(f.requests.length, before + 2); f.dispose();
});

test('pausing a display does not cancel or strand a logistics write, and recovery reads once', async () => {
  let complete;
  const f = fixture({ post: () => new Promise(resolve => { complete = resolve; }) }); await f.mount();
  f.subject.edit.row = { id: 7, updated_at: 'fixture-revision' };
  const saving = f.subject.saveLogistics(); assert.equal(f.subject.busy.value, true);
  await f.visible(false); complete({ ok: true }); await saving;
  assert.equal(f.subject.busy.value, false); assert.equal(f.subject.edit.row, null); assert.equal(f.requests.length, 1); assert.equal(f.writes.length, 1);
  await f.visible(true); assert.equal(f.requests.length, 2); f.dispose();
});

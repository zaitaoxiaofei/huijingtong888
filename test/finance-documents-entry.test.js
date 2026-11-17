import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const load = name => fs.readFile(new URL('../ozon-erp-collector-plugin/' + name, import.meta.url), 'utf8');
const [ui, erp, core, backend, content] = await Promise.all(['finance-archive.js', 'finance-erp-context.js', 'finance-documents-core.js', 'finance-entry-background.js', 'finance-entry-content.js'].map(load));
function node() {
  return { value: '', textContent: '', checked: false, disabled: false, dataset: {}, children: [],
    append(...items) { this.children.push(...items); for (const item of items) if (!this.value && item?.value) this.value = String(item.value); },
    replaceChildren() { this.children = []; this.value = ''; },
    get selectedOptions() { return this.children.filter(c => String(c.value) === String(this.value)); },
    setAttribute() {}, attachShadow() { this.shadowRoot = node(); return this.shadowRoot; }, remove() { this.removed = true; }
  };
}
async function uiRuntime() {
  const elements = new Map();
  const state = { id: '77', name: 'A店铺', erpId: '77', error: '', binding: 'A', switchDuringErp: false };
  const ctx = vm.createContext({ URLSearchParams, Date, location: { search: '?sellerTab=22&erpTab=11' },
    window: { addEventListener() {} }, setInterval() {},
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); }, createElement: node },
    OzonFinanceArchive: {}, OzonFinanceSellerRequest: function sellerRequest() {},
    chrome: { tabs: { query: async ({ url }) => url[0].includes('seller') ? [{ id: 21 }, { id: 22 }] : [{ id: 11 }] }, scripting: {
      executeScript: async ({ func, args }) => {
        if (func.name === 'erpContextRequest') {
          if (state.error) return [{ result: { ok: false, error: state.error } }];
          if (state.switchDuringErp) state.id = '88';
          return [{ result: { ok: true, data: { tenant_id: 1, shop: { id: 4, name: state.name, ozon_company_id: state.erpId }, binding_token: state.binding,
            bindings: args[0].months.split(',').map(month => ({ month, company: { id: 1, name: '公司甲' } })) } } }];
        }
        if (args[0].company && args[0].company !== state.id) return [{ result: { ok: false, error: 'Ozon 当前店铺已切换，请重新读取目录' } }];
        return [{ result: { ok: true, company: state.id, directoryNames: Array(10).fill('目录') } }];
      }
    } }
  });
  vm.runInContext(core, ctx); vm.runInContext(erp, ctx); vm.runInContext(ui, ctx);
  await new Promise(setImmediate);
  return { ctx, state, elements };
}
test('opening the archive matches the source shop without folder selection and defaults to English', async () => {
  const { ctx, elements } = await uiRuntime();
  assert.equal(elements.get('language').value, 'en');
  assert.equal(elements.get('seller-tab').value, '22');
  assert.equal(elements.get('identity').textContent, '已核对');
  assert.equal(elements.get('identity').dataset.state, 'matched');
  assert.match(elements.get('seller-tab').selectedOptions[0].textContent, /A店铺.*77/);
  assert.equal(elements.get('download').disabled, true);
  assert.equal(vm.runInContext('directory', ctx), undefined);
});
test('switch, mismatch and failed authorization clear the old shop and invalidate a prepared download', async () => {
  const { ctx, state, elements } = await uiRuntime();
  vm.runInContext("plan = { context: { binding_token: 'A' }, seller_tab: 22, erp_tab: 11 };", ctx);
  state.id = '88'; state.erpId = '88'; state.name = 'B店铺'; state.binding = 'B';
  await ctx.identify();
  assert.match(elements.get('seller-tab').selectedOptions[0].textContent, /B店铺.*88/);
  assert.equal(vm.runInContext('plan', ctx), null);
  state.erpId = '77'; await ctx.identify();
  assert.equal(elements.get('identity').dataset.state, 'error');
  assert.doesNotMatch(elements.get('identity').textContent, /已匹配/);
  state.error = 'ERP登录已失效，请先重新登录'; await ctx.identify();
  assert.match(elements.get('identity').textContent, /重新登录/);
  assert.equal(elements.get('download').disabled, true);
});
test('a switch while matching ERP cannot display the old shop as matched', async () => {
  const { ctx, state, elements } = await uiRuntime(); state.switchDuringErp = true;
  await ctx.identify();
  assert.equal(elements.get('identity').dataset.state, 'error');
  assert.match(elements.get('identity').textContent, /切换/);
});
function backgroundRuntime() {
  const state = { id: '77', erpId: '77', tenants: [1], switchDuringErp: false, created: [] }; let listener;
  const ctx = vm.createContext({ Date, OzonFinanceSellerRequest: function sellerRequest() {}, OzonFinanceErpContextRequest: function erpContextRequest() {},
    chrome: { runtime: { id: 'ours', getURL: s => 'chrome-extension://ours/' + s, onMessage: { addListener: l => { listener = l; } } },
      tabs: { query: async () => state.tenants.map((tenant, i) => ({ id: i + 11, tenant })), create: async x => state.created.push(x) },
      scripting: { executeScript: async ({ target, func, args }) => {
        if (func.name === 'sellerRequest') return [{ result: args[0].company && args[0].company !== state.id ? { ok: false, error: '店铺已切换' } : { ok: true, company: state.id } }];
        if (state.switchDuringErp) state.id = '88';
        return [{ result: { ok: true, data: { tenant_id: state.tenants[target.tabId - 11], shop: { id: 4, ozon_company_id: state.erpId, name: 'A店铺' } } } }];
      } }
    }
  });
  vm.runInContext(backend, ctx);
  const sender = { id: 'ours', frameId: 0, url: 'https://seller.ozon.ru/app/finances/documents', tab: { id: 22 } };
  const send = (type = 'OZON_FINANCE_MATCH', extra = {}) => new Promise(resolve => listener({ type }, { ...sender, ...extra }, resolve));
  return { state, send };
}
test('inline entry exposes only verified shop metadata and opens the exact source tab', async () => {
  const { state, send } = backgroundRuntime();
  const result = await send();
  assert.equal(result.ok, true); assert.equal(result.shopName, 'A店铺'); assert.equal(result.company, '77');
  assert.deepEqual(Object.keys(result).sort(), ['company', 'erpTab', 'ok', 'shopName']);
  await send('OZON_FINANCE_OPEN');
  assert.match(state.created[0].url, /finance-archive.html\?sellerTab=22&erpTab=11$/);
});
test('inline entry rejects untrusted senders, conflicting ERP enterprises and a shop switch', async () => {
  const { state, send } = backgroundRuntime();
  assert.equal((await send('OZON_FINANCE_MATCH', { url: 'https://evil.example/' })).ok, false);
  assert.equal((await send('OZON_FINANCE_OPEN', { frameId: 1 })).ok, false);
  assert.equal(state.created.length, 0);
  state.tenants = [1, 2]; assert.match((await send()).error, /多个 ERP 企业/);
  state.tenants = [1]; state.erpId = '88'; assert.match((await send()).error, /不一致/);
  state.erpId = '77'; state.switchDuringErp = true; assert.match((await send()).error, /切换/);
});
test('inline entry appears on Documents SPA navigation and removes stale match immediately after switching', async () => {
  const body = node(), doc = { cookie: 'sc_company_id=77', hidden: false, documentElement: body, createElement: node };
  let tick, pending; const state = { id: '77', name: 'A店铺', defer: false };
  const ctx = vm.createContext({ Date, document: doc, location: { pathname: '/app/products' }, window: { addEventListener() {} },
    setInterval: fn => { tick = fn; }, chrome: { runtime: { sendMessage: async () => state.defer ? await new Promise(resolve => { pending = resolve; }) : { ok: true, company: state.id, shopName: state.name } } } });
  vm.runInContext(content, ctx); assert.equal(body.children.length, 0);
  ctx.location.pathname = '/app/finances/documents'; tick(); await new Promise(setImmediate);
  const host = body.children[0], status = host.shadowRoot.children[1].children[1];
  assert.match(status.textContent, /A店铺.*77/);
  state.defer = true; doc.cookie = 'sc_company_id=88'; tick(); await new Promise(setImmediate);
  assert.doesNotMatch(status.textContent, /A店铺/); assert.equal(status.dataset.state, 'pending');
  doc.cookie = 'sc_company_id=99'; tick(); pending({ ok: true, company: '88', shopName: 'B店铺' }); await new Promise(setImmediate);
  assert.doesNotMatch(status.textContent, /B店铺/);
  ctx.location.pathname = '/app/products'; tick(); assert.equal(host.removed, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const load = name => fs.readFile(new URL('../ozon-erp-collector-plugin/' + name, import.meta.url), 'utf8');
const sources = await Promise.all(['finance-documents-core.js', 'finance-documents-archive.js', 'finance-archive.js'].map(load));
function runtime(extra = {}) {
  const ctx = vm.createContext({ Blob, Uint8Array, URLSearchParams, Date, crypto: webcrypto, setTimeout, clearTimeout, ...extra });
  vm.runInContext(sources[0], ctx); vm.runInContext(sources[1], ctx); return ctx;
}
function disk() {
  const files = new Map(), directories = new Set(['']);
  const dir = (prefix = '') => ({ name: '财务原件',
    async getDirectoryHandle(name, options = {}) {
      const path = prefix + name + '/';
      if (!directories.has(path) && !options.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      directories.add(path); return dir(path);
    },
    async getFileHandle(name, options = {}) {
      const path = prefix + name;
      if (!files.has(path) && !options.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      return { name, getFile: async () => files.get(path), createWritable: async () => {
        let value; return { write: async blob => { value = blob; }, close: async () => files.set(path, value), abort: async () => {} };
      } };
    },
    async *values() { for (const path of files.keys()) if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) yield { name: path.slice(prefix.length) }; }
  });
  return { root: dir(), files, directories };
}
const context = { tenant_id: 7, shop: { id: 4, name: 'A店', ozon_company_id: '77' } };
const binding = month => ({ month, company: { id: 10, name: '公司甲', tax_number: 'TAX-A' } });
function sections(core, month) {
  return core.folders.flatMap(folder => folder.sections.map(section => ({ folder, section, selected: true,
    documents: folder.id === core.folders[0].id ? [{ id: Number(month.replace('-', '')), name: '官方原件', date: month + '-31',
      document_type: { code: 'MarketplaceDocumentExecutionJobAct' }, file_name: 'raw.pdf', file_extension: 'pdf' }] : [] })));
}
async function populate(ctx, store, month, opts = {}) {
  const a = ctx.OzonFinanceArchive, core = ctx.OzonFinanceDocuments, m = a.createMonth(context, binding(month), 'ru');
  m.sections = sections(core, month); m.read_completed = true; m.binding_verified = true;
  const item = m.sections[0], doc = item.documents[0], blob = new Blob(['%PDF-1.7 original ' + month]);
  doc.path = a.filePath(m, item, doc, doc.file_name); doc.saved = true; doc.bytes = blob.size; doc.sha256 = await a.digest(blob);
  Object.assign(m, opts); await a.writeFile(store.root, doc.path, blob); await a.checkpoint(store.root, m); return m;
}
test('presence checks actual originals and checksum, not merely a folder or completion flag', async () => {
  const ctx = runtime(), store = disk(), a = ctx.OzonFinanceArchive, m = await populate(ctx, store, '2025-01');
  assert.equal((await a.inspect(store.root, context, binding('2025-01'), 'ru')).status, 'complete');
  store.files.set(m.sections[0].documents[0].path, new Blob(['corrupted same origin']));
  assert.equal((await a.inspect(store.root, context, binding('2025-01'), 'ru')).status, 'partial');
  store.files.delete(m.sections[0].documents[0].path);
  assert.equal((await a.inspect(store.root, context, binding('2025-01'), 'ru')).status, 'partial');
});
test('empty, partially selected and unfinished snapshots are not counted as complete', async () => {
  const ctx = runtime(), store = disk(), a = ctx.OzonFinanceArchive, m = await populate(ctx, store, '2025-01');
  m.sections[1].selected = false; assert.equal(a.snapshotComplete(m), false);
  m.sections[1].selected = true; m.binding_verified = false; assert.equal(a.snapshotComplete(m), false);
  m.binding_verified = true; m.sections[0].documents = []; assert.equal(a.snapshotComplete(m), false);
});
test('company, shop, tenant and language scopes remain distinct in the local archive', async () => {
  const ctx = runtime(), store = disk(), a = ctx.OzonFinanceArchive;
  await populate(ctx, store, '2025-01');
  assert.equal((await a.inspect(store.root, { ...context, tenant_id: 8 }, binding('2025-01'), 'ru')).status, 'missing');
  assert.equal((await a.inspect(store.root, context, binding('2025-01'), 'en')).status, 'missing');
  const index = await a.readJson(store.root, '_Ozon原件索引.json');
  assert.match(index.records[0].files[0].path, /公司甲__10\/A店__4\/2025-01\/含附加服务/);
  assert.ok(index.records[0].files[0].evidence_id);
});
test('overwrite requires the explicit mode; unrelated files and other months stay intact', async () => {
  const ctx = runtime(), store = disk(), a = ctx.OzonFinanceArchive, m = await populate(ctx, store, '2025-01');
  const path = m.sections[0].documents[0].path;
  await a.writeFile(store.root, '手工资料/notes.txt', new Blob(['keep']));
  await populate(ctx, store, '2025-02');
  await assert.rejects(a.writeFile(store.root, path, new Blob(['changed'])), /覆盖/);
  await a.writeFile(store.root, path, new Blob(['changed']), true);
  assert.equal(await store.files.get(path).text(), 'changed');
  assert.equal(await store.files.get('手工资料/notes.txt').text(), 'keep');
  assert.equal((await a.inspect(store.root, context, binding('2025-02'), 'ru')).status, 'complete');
  await assert.rejects(a.readFile(store.root, '../elsewhere'), /非法路径/);
});

const erpSource = sources[2].slice(sources[2].indexOf('async function erpContextRequest('), sources[2].indexOf('\nasync function execute('));
test('ERP authentication stays inside the ERP origin and session changes interrupt metadata reads', async () => {
  let token = 'private-session-token', headers;
  const ctx = vm.createContext({ location: { origin: 'https://erp.hjt888.xyz' }, localStorage: { getItem: () => token }, URLSearchParams,
    AbortController, setTimeout, clearTimeout, fetch: async (_url, options) => { headers = options.headers; return Response.json({ binding_token: 'abc', bindings: [] }); } });
  vm.runInContext(erpSource + ';globalThis.read=erpContextRequest;', ctx);
  const result = await ctx.read({ months: '2025-01', ozon_company_id: '77' });
  assert.equal(result.ok, true); assert.equal(headers.Authorization, 'Bearer private-session-token');
  assert.ok(!JSON.stringify(result).includes(token));
  ctx.fetch = async () => { token = 'changed'; return Response.json({ binding_token: 'abc', bindings: [] }); };
  assert.match((await ctx.read({})).error, /切换/);
  ctx.location.origin = 'https://example.com';
  assert.match((await ctx.read({})).error, /不受支持/);
});
test('verified version 1.5.8 files can be found and reused without claiming a new accounting classification', async () => {
  const ctx = runtime(), store = disk(), a = ctx.OzonFinanceArchive, core = ctx.OzonFinanceDocuments;
  const m = { company: '77', month: '2025-01', language: 'ru', sections: sections(core, '2025-01') }, d = m.sections[0].documents[0];
  const blob = new Blob(['%PDF-1.7 legacy']); d.path = '77/2025-01/old.pdf'; d.saved = true; d.sha256 = await a.digest(blob); d.bytes = blob.size;
  await a.writeFile(store.root, d.path, blob);
  await a.writeFile(store.root, '77/2025-01/采集清单_123.json', new Blob([JSON.stringify(m)]));
  const found = await a.inspect(store.root, context, binding('2025-01'), 'ru');
  assert.equal(found.status, 'complete'); assert.equal(found.needs_relocate, true); assert.equal(found.verified.length, 1);
});

test('selecting twelve months with January–October already archived downloads only November–December, then supports explicit full overwrite', async () => {
  const elements = new Map();
  function element() { return { value: '', textContent: '', checked: false, children: [],
    append(...children) { this.children.push(...children); for (const child of children) if (!this.value && child?.value) this.value = child.value; },
    replaceChildren() { this.children = []; this.value = ''; } }; }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  const store = disk(), ctx = runtime({ document, atob, showDirectoryPicker: async () => store.root });
  for (let m = 1; m <= 10; m++) await populate(ctx, store, '2025-' + String(m).padStart(2, '0'));
  const downloads = []; let changedBinding = false, changeAfterDownload = false, cancelAfterDownload = false;
  ctx.OzonFinanceSellerRequest = function sellerRequest() {};
  ctx.chrome = { tabs: { query: async ({ url }) => [{ id: url[0].includes('seller') ? 2 : 1, title: '已登录' }] }, scripting: {
    executeScript: async ({ func, args }) => {
      const input = args[0];
      if (func.name === 'erpContextRequest') {
        const months = input.months.split(',');
        return [{ result: { ok: true, data: { ...context, binding_token: changedBinding ? 'changed' : 'verified', bindings: months.map(binding) } } }];
      }
      if (!input.request) return [{ result: { ok: true, company: '77', directoryNames: Array(10).fill('目录') } }];
      const path = input.request.path;
      if (input.binary) {
        downloads.push(path); const blob = new Blob(['%PDF-1.7 downloaded ' + downloads.length]);
        if (changeAfterDownload) changedBinding = true;
        if (cancelAfterDownload) elements.get('stop').onclick();
        return [{ result: { ok: true, base64: btoa(await blob.text()), sha256: await ctx.OzonFinanceArchive.digest(blob), type: 'application/pdf', disposition: '' } }];
      }
      if (path.endsWith('/ask')) return [{ result: { ok: true, data: {} } }];
      if (path.includes('/status?')) return [{ result: { ok: true, data: { status: 'Ready' } } }];
      let data = { documents: [] };
      if (path.includes('/documents/upd?')) { const month = new URL(path, 'https://seller.ozon.ru').searchParams.get('from').slice(0, 7); data.documents = sections(ctx.OzonFinanceDocuments, month)[0].documents; }
      if (path.endsWith('/reports/list')) data = { reports: [] };
      if (path.includes('/reconciliation/') || path.includes('/fines/')) data = [];
      if (path.includes('/carriage/list')) data = { result: [] };
      return [{ result: { ok: true, data } }];
    }
  } };
  vm.runInContext(sources[2], ctx); await new Promise(r => setImmediate(r));
  document.getElementById('year').value = '2025'; document.getElementById('language').value = 'ru'; document.getElementById('only-missing').checked = true;
  await elements.get('choose-folder').onclick(); elements.get('select-all').onclick(); await elements.get('check').onclick();
  assert.equal(elements.get('months').children.length, 12);
  const chosen = () => elements.get('months').children.filter(tr => tr.children[0].children[0].checked).length;
  assert.equal(chosen(), 2);
  await elements.get('download').onclick();
  assert.equal(downloads.length, 2); assert.match(elements.get('status').textContent, /下载 2 份/);
  for (const m of ['2025-11', '2025-12']) assert.equal((await ctx.OzonFinanceArchive.inspect(store.root, context, binding(m), 'ru')).status, 'complete');
  for (const folder of ctx.OzonFinanceDocuments.folders) assert.ok(store.directories.has('公司甲__10/A店__4/2025-11/' + folder.name + '/'));
  elements.get('overwrite').checked = true; elements.get('overwrite').onchange(); assert.equal(chosen(), 12);
  await elements.get('download').onclick(); assert.equal(downloads.length, 14);
  assert.equal((await ctx.OzonFinanceArchive.readJson(store.root, '_Ozon原件索引.json')).records.length, 12);
  changeAfterDownload = true;
  await elements.get('download').onclick();
  assert.equal(downloads.length, 15); assert.match(elements.get('status').textContent, /绑定已变化/);
  assert.equal((await ctx.OzonFinanceArchive.inspect(store.root, context, binding('2025-01'), 'ru')).status, 'partial');
  changeAfterDownload = false; cancelAfterDownload = true;
  await elements.get('check').onclick(); await elements.get('download').onclick();
  assert.equal(downloads.length, 16); assert.match(elements.get('status').textContent, /已停止/);
  assert.equal((await ctx.OzonFinanceArchive.inspect(store.root, context, binding('2025-01'), 'ru')).status, 'partial');
});

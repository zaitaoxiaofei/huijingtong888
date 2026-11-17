import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../ozon-erp-collector-plugin/finance-documents-core.js', import.meta.url), 'utf8');
const ui = await fs.readFile(new URL('../ozon-erp-collector-plugin/finance-documents.js', import.meta.url), 'utf8');
const sandbox = { URLSearchParams, setTimeout, Date };
vm.runInNewContext(source, sandbox);
const c = sandbox.OzonFinanceDocuments;
const folder = c.folders[0], section = folder.sections[0];
const doc = (overrides = {}) => ({ id: 123, date: '2026-10-31T00:00:00Z', document_type: { code: 'MarketplaceDocumentExecutionJobAct' }, file_name: '原件.pdf', file_extension: 'pdf', ...overrides });

test('all ten folders include sales reference, partner invoices and special lists', () => {
  assert.equal(c.folders.length, 10);
  assert.equal(c.folders.flatMap(f => f.sections).length, 15);
  assert.match(c.listRequest(c.folders[1], c.folders[1].sections[1], '1', '2026-10').path, /realization\/reference\?from=2026-10-01&to=2026-10-31/);
  assert.equal(c.monthRange('2028-02').to, '2028-02-29');
  assert.throws(() => c.monthRange('2026-13'), /月份/);
});
test('month selection preserves same-id different formats and nested documents', () => {
  const result = c.normalizeList({ documents: [doc(), doc(), doc({ document_type: { code: 'AnotherReport' }, file_extension: 'xlsx' }),
    doc({ date: '2026-11-01' }), { date: '2026-10-31', children: [doc({ id: 456, date: undefined })] }] }, folder, section, '2026-10');
  assert.equal(result.length, 3);
  assert.equal(result[2].date, '2026-10-31');
});
test('empty and unreadable lists cannot be confused', () => {
  assert.equal(c.normalizeList({ documents: [] }, folder, section, '2026-10').length, 0);
  assert.throws(() => c.normalizeList({ message: 'blocked' }, folder, section, '2026-10'), /结构变化/);
  assert.throws(() => c.normalizeList({ documents: [doc({ date: undefined })] }, folder, section, '2026-10'), /有效日期/);
  assert.throws(() => c.normalizeList({ documents: [doc({ id: null })] }, folder, section, '2026-10'), /编号/);
});
test('quarterly reconciliation is collected by issue date without changing its business period', () => {
  const f = c.folders[8], name = 'Reconciliation 2026-07-01 - 2026-09-30';
  const [d] = c.normalizeList([{ actId: 33, createdAt: '2026-10-13T23:00:00Z', name, reportSysName: 'ActOfReconciliationByQuarter' }], f, f.sections[0], '2026-10');
  assert.equal(d.name, name); assert.equal(d.date, '2026-10-13T23:00:00Z');
});
test('FBS lists reject truncation and expose actual related documents', () => {
  const f = c.folders[9];
  const [d] = c.normalizeList({ result: [{ id: '44', departure_date: '2026-10-15', related_docs: { act_of_acceptance: { id: '55' }, act_of_excess: null } }] }, f, f.sections[0], '2026-10');
  assert.equal(d.document_type.code, 'act_of_acceptance');
  assert.throws(() => c.normalizeList({ result: Array(999).fill({}) }, f, f.sections[0], '2026-10'), /上限/);
});
test('billing and ERP documents use distinct generation protocols', () => {
  const erp = c.downloadPlan(doc(), '77');
  assert.match(erp.ask.path, /erpmp-reports/); assert.equal(erp.ask.body.document_id, 123);
  const billing = c.downloadPlan(doc({ document_type: { code: 'RealizationReportGeneralBillingByExternalId' } }), '77');
  assert.match(billing.ask.path, /self-reports/); assert.equal(billing.ask.body.report_id, 123);
  assert.match(billing.status.path, /report_type=RealizationReportGeneralBillingByExternalId/);
  const direct = c.downloadPlan(doc({ document_type: { code: 'ReschedulingDeliveryServiceCommonReportAfterAugust' } }), '77');
  assert.equal(direct.ask, undefined); assert.match(direct.request.path, /reinvoices\/sellers\/77\/report\?/);
  assert.throws(() => c.downloadPlan(doc({ document_type: { code: 'Unknown' } }), '77'), /尚未适配/);
});
test('generation polling is bounded and does not silently accept errors', async () => {
  const plan = c.downloadPlan(doc(), '77'); let calls = 0;
  await c.prepare(plan, async () => ++calls === 2 ? { status: 'Pending' } : { status: 'Ready' }, async () => {});
  assert.equal(calls, 3);
  await assert.rejects(c.prepare(plan, async () => ({ status: 'Error' }), async () => {}), /生成失败/);
  let total = 0;
  await assert.rejects(c.prepare(plan, async () => { total++; return { status: 'Pending' }; }, async () => {}), /稍后重试/);
  assert.equal(total, 41);
});
test('file paths cannot escape the chosen directory and disposition retains original names', () => {
  const path = c.pathFor('77', '2026-10', { name: '../../目录' }, '../子目录', doc(), '../原件.pdf');
  assert.ok(path.split('/').every(p => p !== '..' && !p.includes('\\')));
  assert.equal(c.responseFilename("attachment; filename*=UTF-8''%E5%8E%9F%E4%BB%B6.xlsx", 'fallback'), '原件.xlsx');
  assert.equal(c.responseFilename('attachment; filename="Отчет.xlsx"', 'fallback'), 'Отчет.xlsx');
});

const transportSource = await fs.readFile(new URL('../ozon-erp-collector-plugin/finance-documents-transport.js', import.meta.url), 'utf8');
function transport(fetch, cookie = 'sc_company_id=77') {
  const document = { cookie, title: 'Seller', querySelectorAll: () => Array.from({ length: 10 }, () => ({ textContent: '目录' })) };
  const ctx = { document, location: { origin: 'https://seller.ozon.ru', pathname: '/app/finances/documents' }, fetch,
    URL, AbortController, setTimeout, clearTimeout, crypto: webcrypto, Uint8Array, Blob, atob, btoa };
  vm.runInNewContext(transportSource + ';globalThis.request = sellerRequest;', ctx);
  return { request: ctx.request, document };
}
test('transport keeps credentials in browser, handles empty ask, and rejects HTML masquerading as an original', async () => {
  let options;
  const t = transport(async (_url, opts) => { options = opts; return new Response(null, { status: 204 }); });
  const result = await t.request({ company: '77', request: { path: '/api/site/erpmp-reports/api/reports/ask', method: 'POST', body: {} } });
  assert.equal(result.ok, true); assert.equal(options.credentials, 'include'); assert.equal(options.headers['x-o3-company-id'], '77');
  const html = transport(async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal((await html.request({ company: '77', request: { path: '/api/file' }, binary: true })).ok, false);
});
test('transport rejects absent and conflicting identity and a switch during the request', async () => {
  let calls = 0;
  const absent = transport(async () => { calls++; }, '');
  assert.equal((await absent.request({})).ok, false);
  const conflict = transport(async () => { calls++; }, 'sc_company_id=77; sc_company_id=88');
  assert.equal((await conflict.request({})).ok, false);
  const mismatch = transport(async () => { calls++; });
  assert.equal((await mismatch.request({ company: '88', request: { path: '/api/file' } })).ok, false);
  assert.equal(calls, 0);
  const changed = transport(async () => { changed.document.cookie = 'sc_company_id=88'; return new Response('{}'); });
  assert.match((await changed.request({ company: '77', request: { path: '/api/file' } })).error, /切换/);
});
test('transport validates file magic and returns checksum only after the download completes', async () => {
  const t = transport(async () => new Response('%PDF-1.7\noriginal', { headers: { 'content-type': 'application/pdf' } }));
  const result = await t.request({ company: '77', request: { path: '/api/file' }, binary: true });
  assert.equal(result.ok, true); assert.equal(result.sha256.length, 64); assert.equal(atob(result.base64), '%PDF-1.7\noriginal');
  const foreign = await t.request({ company: '77', request: { path: 'https://example.com/api/file' }, binary: true });
  assert.equal(foreign.ok, false);
});
test('FBS file-content response is decoded and validated through the same transport', async () => {
  const t = transport(async () => Response.json({ result: { file_content: btoa('%PDF-1.7\nfbs'), content_type: 'application/pdf', file_name: 'act.pdf' } }));
  const plan = c.downloadPlan(doc({ data_source: 'FBS', document_type: { code: 'act_of_acceptance' } }), '77');
  const result = await t.request({ company: '77', request: plan.request, binary: true });
  assert.equal(result.ok, true); assert.equal(result.filename, 'act.pdf'); assert.equal(atob(result.base64), '%PDF-1.7\nfbs');
});

test('download page scans all sections, saves originals plus manifest, retries failure, and skips completed files', async () => {
  const elements = new Map(), downloads = [], requests = [];
  function element() { return { value: '', textContent: '', children: [], disabled: false,
    append(child) { this.children.push(child); if (!this.value && child.value) this.value = child.value; },
    replaceChildren() { this.children = []; this.value = ''; } }; }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  let failDownload = true;
  const browser = transport(async (url, options) => {
    const path = new URL(url).pathname; requests.push(path);
    if (path.endsWith('/download')) {
      if (failDownload) { failDownload = false; return new Response('failure', { status: 503 }); }
      return new Response('%PDF-1.7\noriginal', { headers: { 'content-type': 'application/pdf' } });
    }
    if (path.endsWith('/ask')) return new Response(null, { status: 204 });
    if (path.endsWith('/status')) return Response.json({ status: 'Ready' });
    if (path.endsWith('/upd')) return Response.json({ documents: [doc()] });
    if (path.endsWith('/reports/list')) return Response.json({ reports: [] });
    if (path.includes('reconciliation/') || path.includes('/fines/')) return Response.json([]);
    if (path.endsWith('/carriage/list')) return Response.json({ result: [] });
    return Response.json({ documents: [] });
  });
  const files = new Map(), writes = [];
  const folderHandle = (prefix = '') => ({ name: '本地财务文件',
    getDirectoryHandle: async name => folderHandle(prefix + name + '/'),
    getFileHandle: async (name, options = {}) => {
      const key = prefix + name;
      if (!files.has(key) && !options.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return { getFile: async () => files.get(key), createWritable: async () => {
        let pending; return { write: async blob => { pending = blob; }, close: async () => { files.set(key, pending); writes.push(key); }, abort: async () => {} };
      } };
    } });
  const context = vm.createContext({ document, OzonFinanceDocuments: c, Date, Blob, URL, Uint8Array, atob, crypto: webcrypto,
    showDirectoryPicker: async () => folderHandle(),
    setTimeout, clearTimeout, chrome: {
      tabs: { query: async () => [{ id: 4, title: 'Ozon Seller' }] },
      scripting: { executeScript: async ({ args }) => [{ result: await browser.request(args[0]) }] },
      downloads: { download: async value => { downloads.push(value); return downloads.length; }, search: async () => [{ state: 'complete' }] }
    } });
  vm.runInContext(ui, context);
  await new Promise(r => setImmediate(r));
  elements.get('month').value = '2026-10';
  document.getElementById('language').value = 'ru';
  await elements.get('scan').onclick();
  assert.equal(elements.get('folders').children.length, 15);
  assert.match(elements.get('status').textContent, /1 个文件，0 个子目录/);
  await elements.get('download').onclick();
  assert.match(elements.get('status').textContent, /新保存 0 个，失败 1 个/);
  assert.equal(downloads.length, 1); // Failure exports a manifest without marking the original saved.
  await elements.get('download').onclick();
  assert.match(elements.get('status').textContent, /新保存 1 个，失败 0 个/, elements.get('results').textContent);
  assert.match(downloads[1].filename, /77\/2026-10\/含附加服务的通用传输文件/);
  await elements.get('download').onclick();
  assert.equal(requests.filter(p => p.endsWith('/download')).length, 2);
  assert.match(elements.get('status').textContent, /新保存 0 个，失败 0 个/);
  await elements.get('choose-folder').onclick();
  await elements.get('download').onclick();
  const original = [...files.keys()].find(p => p.endsWith('.pdf'));
  assert.ok(original);
  await elements.get('choose-folder').onclick();
  await elements.get('download').onclick();
  assert.equal(writes.filter(p => p === original).length, 1); // Identical original is reused.
  files.set(original, new Blob(['user modified original']));
  await elements.get('choose-folder').onclick();
  await elements.get('download').onclick();
  assert.match(elements.get('results').textContent, /同名但内容不同/);
  assert.equal(await files.get(original).text(), 'user modified original');
});

'use strict';
const core = globalThis.OzonFinanceDocuments, archive = globalThis.OzonFinanceArchive;
const el = id => document.getElementById(id);
let directory, plan, busy = false, stopped = false, identifying = false, identityRevision = 0, tabsReady = false;
const sourceTab = Number(new URLSearchParams(location.search).get('sellerTab'));
const sourceErp = Number(new URLSearchParams(location.search).get('erpTab'));
el('language').value = 'en';
const picked = new Set(), folderChecks = [], monthChecks = [];
el('year').value = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 4);
function invalidate() { plan = null; el('months').replaceChildren(); el('download').disabled = true; el('status').textContent = ''; el('month-results').hidden = true; }
function setBusy(value) {
  busy = value;
  for (const id of ['check', 'refresh', 'erp-tab', 'seller-tab', 'year', 'language', 'choose-folder', 'select-all', 'select-ten', 'select-none', 'identify', 'only-missing', 'overwrite']) el(id).disabled = value;
  for (const input of [...monthChecks, ...folderChecks]) input.disabled = value;
  el('stop').disabled = !value; el('stop').hidden = !value; el('download').disabled = value || !plan; render();
}
function updateSelectionCount() { el('selection-count').textContent = `已选 ${picked.size} 个月`; }
function selectMonths(count) {
  picked.clear(); monthChecks.forEach((input, i) => { input.checked = i < count; if (input.checked) picked.add(i + 1); }); updateSelectionCount(); invalidate(); if (tabsReady) { identityRevision++; identify(); }
}
for (let m = 1; m <= 12; m++) {
  const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
  input.onchange = () => { if (input.checked) picked.add(m); else picked.delete(m); updateSelectionCount(); identityRevision++; invalidate(); identify(); };
  label.append(input, `${m}月`); monthChecks.push(input); el('month-picker').append(label);
}
for (const folder of core.folders) {
  const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
  input.onchange = () => { const count = folderChecks.filter(c => c.checked).length; el('folder-summary').textContent = `官方目录 · ${count === core.folders.length ? '全部 ' : '已选 '}${count} 类`;  };
  input.folderId = folder.id; folderChecks.push(input); label.append(input, folder.name); el('folders').append(label);
}
selectMonths(10);

async function execute(tabId, func, input) {
  if (stopped) throw new Error('已停止');
  const [response] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: [input] });
  if (!response?.result?.ok) throw new Error(response?.result?.error || '页面未响应，请刷新后重试');
  return response.result;
}
const seller = async (request, binary = false) => {
  const value = await execute(plan.seller_tab, globalThis.OzonFinanceSellerRequest, { company: plan.context.shop.ozon_company_id, request, binary });
  return request && !binary ? value.data : value;
};
async function verifyBinding() {
  const value = await execute(plan.erp_tab, erpContextRequest, plan.query);
  if (value.data.binding_token !== plan.context.binding_token) throw new Error('ERP企业、店铺或月份主体绑定已变化，已停止归档，请重新检查');
}
async function refreshTabs() {
  identityRevision++; invalidate(); showIdentity('核对中…');
  for (const [id, urls] of [['seller-tab', ['https://seller.ozon.ru/*']], ['erp-tab', ['https://erp.hjt888.xyz/*', 'http://localhost:8788/*', 'http://127.0.0.1:8788/*']]]) {
    const previous = Number(el(id).value);
    const tabs = await chrome.tabs.query({ url: urls }); el(id).replaceChildren();
    for (const tab of tabs) { const option = document.createElement('option'); option.value = tab.id; option.textContent = `${tab.title || '页面'}（${tab.id}）`; option.dataset.title = option.textContent; el(id).append(option); }
    const preferred = previous || (id === 'seller-tab' ? sourceTab : sourceErp);
    if (tabs.some(tab => tab.id === preferred)) el(id).value = String(preferred);
    else if (preferred) { const option = document.createElement('option'); option.value = ''; option.textContent = '原页面已关闭，请重新选择'; el(id).append(option); el(id).value = ''; }
  }
  tabsReady = true;
  await identify();
  if (!plan) el('status').textContent = '';
}
function showIdentity(text, state = 'pending') {
  el('identity').textContent = text; el('identity').dataset.state = state;
}
function selectedMonths() {
  const year = el('year').value;
  if (!/^20\d{2}$/.test(year)) throw new Error('请选择有效年份');
  return [...picked].sort((a, b) => a - b).map(m => `${year}-${String(m).padStart(2, '0')}`);
}
async function readIdentity() {
  const erpTab = Number(el('erp-tab').value), sellerTab = Number(el('seller-tab').value);
  if (!sellerTab) throw new Error('未找到 Ozon 后台，请打开财务 → 文件页面后刷新页面列表');
  const identity = await execute(sellerTab, globalThis.OzonFinanceSellerRequest, {});
  if (!erpTab) throw new Error(`已识别 Ozon ID：${identity.company}；请先打开并登录 ERP，再刷新页面列表以匹配店铺名称`);
  const months = selectedMonths();
  if (!months.length) throw new Error(`已识别 Ozon ID：${identity.company}；请选择至少一个月份以核对店铺归属`);
  const query = { ozon_company_id: identity.company, months: months.join(',') };
  const context = (await execute(erpTab, erpContextRequest, query)).data;
  if (String(context.shop?.ozon_company_id) !== identity.company || context.bindings.length !== months.length) throw new Error('Ozon 当前店铺 ID 与 ERP 返回的店铺不一致，已停止，请核对店铺绑定');
  await execute(sellerTab, globalThis.OzonFinanceSellerRequest, { company: identity.company });
  return { identity, context, query, erpTab, sellerTab };
}
function displayMatch(value) {
  const { context, identity } = value;
  const errors = context.bindings.filter(binding => binding.error);
  showIdentity(errors.length ? '店铺已核对 · 部分月份主体待核对' : '已核对', errors.length ? 'pending' : 'matched');
  el('seller-tab').selectedOptions[0].textContent = `${context.shop.name} · Ozon ID：${identity.company}`;
}
async function identify() {
  if (busy || identifying) return;
  stopped = false; identifying = true; const revision = ++identityRevision;
  const option = el('seller-tab').selectedOptions[0];
  if (option?.dataset.title) option.textContent = option.dataset.title;
  showIdentity('核对中…');
  try {
    const value = await readIdentity();
    if (revision !== identityRevision) return;
    if (plan && (plan.context.binding_token !== value.context.binding_token || plan.seller_tab !== value.sellerTab || plan.erp_tab !== value.erpTab)) invalidate();
    displayMatch(value);
  } catch (error) {
    if (revision !== identityRevision) return;
    invalidate(); showIdentity('尚未匹配：' + error.message, 'error');
  } finally { identifying = false; if (revision !== identityRevision) identify(); }
}
function render() {
  el('months').replaceChildren(); el('month-results').hidden = !plan?.rows.length;
  const labels = { complete: '已归档 · 校验通过', partial: '有缺失', missing: '未归档', blocked: '主体归属待核对' };
  for (const row of plan?.rows || []) {
    const tr = document.createElement('tr'), td = document.createElement('td'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = row.selected; input.disabled = busy || Boolean(row.error); input.onchange = () => { row.selected = input.checked; };
    td.append(input); tr.append(td);
    for (const text of [row.binding.month, row.binding.company?.name || '待绑定',
      row.error || `${labels[row.local.status]}${row.local.error ? ' · ' + row.local.error : ''}${row.local.needs_relocate ? '，可复用并归入主体目录' : ''}${row.result ? ' · ' + row.result : ''}`]) {
      const cell = document.createElement('td'); cell.textContent = text; tr.append(cell);
    }
    el('months').append(tr);
  }
}
async function check() {
  if (busy) return;
  identityRevision++; invalidate(); stopped = false; setBusy(true);
  try {
    if (!directory) throw new Error('请先选择电脑归档文件夹，插件需要读取清单和实际原件才能判断已有月份');
    const matched = await readIdentity();
    const { identity, context, query, erpTab, sellerTab } = matched;
    if (identity.directoryNames.length !== core.folders.length) throw new Error('Ozon官方目录数量发生变化，需要更新适配后才能保证完整');
    displayMatch(matched);
    plan = { context, query, erp_tab: erpTab, seller_tab: sellerTab, language: el('language').value, source_directories: identity.directoryNames, rows: [] };
    for (const binding of context.bindings) {
      if (stopped) break;
      el('status').textContent = `正在检查本地归档：${binding.month}`;
      const row = { binding, selected: false };
      if (binding.error) { row.error = binding.error; row.local = { status: 'blocked' }; }
      else {
        try { row.local = await archive.inspect(directory, context, binding, plan.language); row.selected = row.local.status !== 'complete' || row.local.needs_relocate || el('overwrite').checked; }
        catch (error) { row.error = '本地清单检查失败：' + error.message; row.local = { status: 'blocked' }; }
      }
      plan.rows.push(row); render();
    }
    const existing = plan.rows.filter(r => r.local.status === 'complete').map(r => r.binding.month);
    el('status').textContent = `${stopped ? '检查已停止' : '检查完成'}：已有 ${existing.length} 个月，已勾选 ${plan.rows.filter(r => r.selected).length} 个月待下载。`;
  } catch (error) { el('status').textContent = error.message; if (directory && !plan) showIdentity('尚未匹配：' + error.message, 'error'); }
  finally { setBusy(false); }
}
async function runDownload() {
  const rows = plan.rows.filter(r => r.selected && !r.error), overwrite = el('overwrite').checked;
  if (!rows.length) throw new Error('没有勾选需要归档的月份');
  let downloaded = 0, reused = 0, failed = 0;
  for (const row of rows) {
    if (stopped) break;
    await verifyBinding(); await seller();
    row.local = await archive.inspect(directory, plan.context, row.binding, plan.language);
    const manifest = archive.createMonth(plan.context, row.binding, plan.language); manifest.binding_verified = false;
    manifest.source_directories = plan.source_directories;
    const reusable = new Map(row.local.verified.map(v => [archive.sectionKey(v.item) + '/' + core.documentKey(v.doc), v.doc]));
    if (!overwrite && row.local.status === 'complete' && !row.local.needs_relocate) { row.result = '已有，已跳过下载'; render(); continue; }
    let monthFailed = 0;
    for (const folder of core.folders) {
      for (const section of folder.sections) {
        if (stopped) break;
        const selected = folderChecks.find(c => c.folderId === folder.id).checked;
        const item = { folder, section, selected, documents: [] }; manifest.sections.push(item);
        if (selected) await archive.ensureDirectory(directory, [manifest.base_path, core.safeName(folder.name), section[0] ? core.safeName(section[0]) : ''].filter(Boolean).join('/'));
        el('status').textContent = `读取 ${row.binding.month} / ${folder.name} / ${section[0]}`;
        try { item.documents = core.normalizeList(await seller(core.listRequest(folder, section, plan.context.shop.ozon_company_id, row.binding.month)), folder, section, row.binding.month); }
        catch (error) { item.error = error.message; monthFailed++; if (/切换|已停止/.test(error.message)) throw error; }
        if (!selected || item.error) continue;
        for (const doc of item.documents) {
          if (stopped) break;
          try {
            const old = !overwrite && reusable.get(archive.sectionKey(item) + '/' + core.documentKey(doc));
            let blob, filename, sha;
            if (old) { blob = await archive.readFile(directory, old.path); sha = await archive.digest(blob); if (sha !== old.sha256) throw new Error('本地原件在检查后已变化，请重新检查'); filename = old.download_name || old.file_name || old.path.split('/').at(-1); }
            else {
              const request = core.downloadPlan(doc, plan.context.shop.ozon_company_id, plan.language);
              el('status').textContent = `下载 ${row.binding.month} / ${folder.name} / ${doc.name}`;
              await core.prepare(request, seller);
              const file = await seller(request.request, true); sha = file.sha256;
              blob = new Blob([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))], { type: file.type });
              filename = file.filename || core.responseFilename(file.disposition, request.filename);
            }
            doc.path = archive.filePath(manifest, item, doc, filename);
            await archive.writeFile(directory, doc.path, blob, overwrite);
            Object.assign(doc, { saved: true, download_name: filename, sha256: sha, bytes: blob.size });
            if (old) reused++; else downloaded++;
            await archive.checkpoint(directory, manifest);
          } catch (error) { doc.error = error.message; failed++; monthFailed++; if (/切换|已停止/.test(error.message)) throw error; }
          el('results').textContent += `${row.binding.month} / ${folder.name} / ${doc.name || doc.id}：${doc.saved ? '已归档' : doc.error}\n`;
        }
      }
      if (stopped) break;
    }
    manifest.read_completed = !stopped;
    if (!stopped) { await verifyBinding(); manifest.binding_verified = true; }
    await archive.checkpoint(directory, manifest);
    row.result = `${manifest.complete ? '归档完成' : '保留为未完成'}，${monthFailed}项异常`;
    row.local = await archive.inspect(directory, plan.context, row.binding, plan.language); render();
  }
  el('status').textContent = `${stopped ? '已停止' : '归档结束'}：下载 ${downloaded} 份，复用 ${reused} 份，文件失败 ${failed} 份；每月结果和索引已保存。`;
}
async function download() {
  if (busy || !plan || !directory) return;
  stopped = false; setBusy(true); el('status').textContent = '正在准备归档并复核ERP主体归属…';
  try {
    if (globalThis.navigator?.locks) await navigator.locks.request('ozon-finance-local-archive', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一归档页面正在写入，请等待该任务完成'); await runDownload();
    }); else await runDownload();
  } catch (error) { invalidate(); showIdentity('归档已停止，请重新识别店铺并检查月份：' + error.message, 'error'); el('status').textContent = error.message; }
  finally { setBusy(false); }
}
el('choose-folder').onclick = async () => {
  try { const selected = await showDirectoryPicker({ mode: 'readwrite' }); directory = selected; el('destination').textContent = selected.name; invalidate(); }
  catch (error) { if (error.name !== 'AbortError') el('status').textContent = '不能读取本地文件夹，请使用支持文件夹选择的Chrome或亿狗浏览器：' + error.message; }
};
for (const id of ['erp-tab', 'seller-tab', 'year', 'language']) el(id).onchange = () => { identityRevision++; invalidate(); showIdentity('核对中…'); identify(); };
el('identify').onclick = identify;
window.addEventListener('focus', identify);
setInterval(() => { if (!document.hidden) identify(); }, 20000);
el('refresh').onclick = () => refreshTabs().catch(e => { el('status').textContent = e.message; });
el('select-none').onclick = () => selectMonths(0);
el('select-all').onclick = () => selectMonths(12); el('select-ten').onclick = () => selectMonths(10);
for (const id of ['only-missing', 'overwrite']) el(id).onchange = () => {
  for (const row of plan?.rows || []) row.selected = !row.error && (el('overwrite').checked || row.local.status !== 'complete' || row.local.needs_relocate); render();
};
el('check').onclick = check; el('download').onclick = download;
el('stop').onclick = () => { stopped = true; el('status').textContent = '正在停止，已归档原件会保留，可重新检查后继续。'; };
refreshTabs().catch(e => { el('status').textContent = e.message; });

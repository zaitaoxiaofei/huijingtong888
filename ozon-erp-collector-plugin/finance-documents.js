'use strict';
const core = globalThis.OzonFinanceDocuments;
const el = id => document.getElementById(id);
let catalog = null, directory = null, running = false, stopped = false;
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1));
el('month').value = lastMonth.toISOString().slice(0, 7);

// Executed in the selected Seller tab. Credentials stay in the browser.
const sellerRequest = globalThis.OzonFinanceSellerRequest;
async function call(tabId, company, request, binary = false) {
  if (stopped) throw new Error('已停止');
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: sellerRequest, args: [{ company, request, binary }] });
  const value = result[0]?.result;
  if (!value?.ok) throw new Error(value?.error || '后台页面没有响应，请刷新 Ozon 页面后重试');
  return binary || !request ? value : value.data;
}
function setBusy(value) {
  running = value;
  for (const id of ['scan', 'refresh', 'seller-tab', 'month', 'language', 'choose-folder']) el(id).disabled = value;
  el('download').disabled = value || !catalog;
  el('export').disabled = value || !catalog;
  el('stop').disabled = !value;
}
function render() {
  el('folders').replaceChildren();
  for (const item of catalog?.sections || []) {
    const tr = document.createElement('tr'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = item.selected; check.disabled = running || Boolean(item.error);
    check.onchange = () => { item.selected = check.checked; };
    const td = document.createElement('td'); td.append(check); tr.append(td);
    for (const value of [item.folder.name + (item.section[0] ? ' / ' + item.section[0] : ''), item.error ? '未知' : item.documents.length,
      item.error || (item.documents.length ? `${item.documents.filter(d => d.saved).length} 已保存，${item.documents.filter(d => d.error).length} 失败` : '本月未列出文件')]) {
      const cell = document.createElement('td'); cell.textContent = value; tr.append(cell);
    }
    el('folders').append(tr);
  }
  el('results').textContent = (catalog?.sections || []).flatMap(s => s.documents.map(d => `${s.folder.name}/${s.section[0]} · ${d.date} · ${d.name} · ${d.saved ? '已保存' : d.error || '待下载'}`)).join('\n');
}
async function refreshTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
  el('seller-tab').replaceChildren();
  for (const tab of tabs) { const opt = document.createElement('option'); opt.value = tab.id; opt.textContent = `${tab.title || 'Ozon Seller'}（页面 ${tab.id}）`; el('seller-tab').append(opt); }
  if (!tabs.length) el('status').textContent = '未找到 Ozon 后台页面，请先登录 seller.ozon.ru，再刷新页面列表。';
}
async function scan() {
  catalog = null; stopped = false; setBusy(true); render();
  try {
    const tabId = Number(el('seller-tab').value), month = el('month').value; core.monthRange(month);
    if (!tabId) throw new Error('请先打开 Ozon 店铺后台，再刷新页面列表');
    const id = await call(tabId);
    if (id.directoryNames.length !== core.folders.length) throw new Error('Ozon 财务目录数量发生变化，请核对新目录后更新采集适配，避免漏件');
    catalog = { company: id.company, month, language: el('language').value, tabId, source_directories: id.directoryNames,
      collected_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), collected_timezone: 'Asia/Shanghai', month_basis: 'Ozon 文件列表日期', sections: [] };
    el('identity').textContent = `已识别店铺 ID：${id.company} · ${month} · 月份按文件列表日期`;
    for (const folder of core.folders) { for (const section of folder.sections) {
      el('status').textContent = `正在读取：${folder.name} ${section[0]}`;
      const item = { folder, section, documents: [], selected: true }; catalog.sections.push(item);
      try { item.documents = core.normalizeList(await call(tabId, id.company, core.listRequest(folder, section, id.company, month)), folder, section, month); }
      catch (error) { item.error = error.message; item.selected = false; }
      render(); if (stopped) break;
    } if (stopped) break; }
    const failures = catalog.sections.filter(s => s.error).length;
    el('status').textContent = `${stopped ? '目录读取已停止' : '目录读取结束'}：${catalog.sections.reduce((n, s) => n + s.documents.length, 0)} 个文件，${failures} 个子目录未能读取。`;
  } catch (error) { el('status').textContent = error.message; }
  finally { setBusy(false); render(); }
}
async function save(path, blob) {
  if (directory) {
    let parent = directory; const parts = path.split('/');
    for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
    let existing;
    try { existing = await parent.getFileHandle(parts.at(-1)); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    if (existing) {
      const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer()))].join(',');
      if (await hash(await existing.getFile()) === await hash(blob)) return;
      throw new Error('保存位置存在同名但内容不同的文件，已保留原文件；请选择其他文件夹后重试');
    }
    const handle = await parent.getFileHandle(parts.at(-1), { create: true }), writer = await handle.createWritable();
    try { await writer.write(blob); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: 'Ozon财务原件/' + path, conflictAction: 'uniquify', saveAs: false });
    const start = Date.now();
    while (Date.now() - start < 120000) {
      const [entry] = await chrome.downloads.search({ id });
      if (entry?.state === 'complete') return;
      if (!entry || entry.state === 'interrupted') throw new Error('浏览器下载中断，请重试');
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('浏览器保存超时，请检查下载列表');
  } finally { URL.revokeObjectURL(url); }
}
function manifestBlob() {
  const { tabId, ...data } = catalog;
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}
async function download() {
  if (!catalog || running) return;
  stopped = false; setBusy(true); render();
  let saved = 0, failed = 0;
  try {
    await call(catalog.tabId, catalog.company);
    for (const item of catalog.sections.filter(s => s.selected && !s.error)) {
      for (const d of item.documents) {
        if (stopped) break;
        if (d.saved) continue;
        el('status').textContent = `正在下载：${item.folder.name} / ${d.name} · 已保存 ${saved}，失败 ${failed}`;
        try {
          const plan = core.downloadPlan(d, catalog.company, catalog.language);
          await core.prepare(plan, req => call(catalog.tabId, catalog.company, req));
          const file = await call(catalog.tabId, catalog.company, plan.request, true);
          const blob = new Blob([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))], { type: file.type });
          d.download_name = file.filename || core.responseFilename(file.disposition, plan.filename);
          d.path = core.pathFor(catalog.company, catalog.month, item.folder, item.section[0], d, d.download_name);
          await save(d.path, blob);
          Object.assign(d, { saved: true, sha256: file.sha256, bytes: file.size }); delete d.error; saved++;
        } catch (error) { d.error = error.message; failed++; if (/店铺.*切换|已停止/.test(error.message)) stopped = true; }
        render();
      }
      if (stopped) break;
    }
    await save(`${catalog.company}/${catalog.month}/采集清单_${Date.now()}.json`, manifestBlob());
    el('status').textContent = `${stopped ? '已停止' : '本轮下载结束'}：新保存 ${saved} 个，失败 ${failed} 个。可再次点击下载，仅重试未保存文件。`;
  } catch (error) { el('status').textContent = error.message; }
  finally { setBusy(false); render(); }
}
el('refresh').onclick = () => refreshTabs().catch(e => { el('status').textContent = e.message; });
el('open-seller').onclick = () => chrome.tabs.create({ url: 'https://seller.ozon.ru/app/finances/documents' });
el('scan').onclick = scan; el('download').onclick = download;
el('stop').onclick = () => { stopped = true; el('status').textContent = '正在停止，当前保存完成后退出。'; };
el('choose-folder').onclick = async () => {
  try {
    directory = await showDirectoryPicker({ mode: 'readwrite' }); el('destination').textContent = directory.name;
    for (const item of catalog?.sections || []) for (const d of item.documents) d.saved = false;
    render();
  }
  catch (error) { if (error.name !== 'AbortError') el('status').textContent = '此浏览器不能选择文件夹，将保存到浏览器下载目录。'; }
};
for (const id of ['seller-tab', 'month', 'language']) el(id).onchange = () => {
  catalog = null; setBusy(false); render(); el('status').textContent = '设置已改变，请重新识别店铺并读取目录。';
};
el('export').onclick = () => save(`${catalog.company}/${catalog.month}/采集清单_${Date.now()}.json`, manifestBlob()).catch(e => { el('status').textContent = e.message; });
refreshTabs().catch(e => { el('status').textContent = e.message; });

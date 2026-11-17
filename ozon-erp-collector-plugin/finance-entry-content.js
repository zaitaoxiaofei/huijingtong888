(function () {
  'use strict';
  if (window.__ozonFinanceEntryLoaded) return;
  window.__ozonFinanceEntryLoaded = true;
  let host, status, signature = '', lastCheck = 0, checking = false, revision = 0;
  function isDocuments() { return /^\/app\/finances\/documents(?:\/|$)/.test(location.pathname); }
  function currentId() { return [...document.cookie.matchAll(/(?:^|;\s*)sc_company_id=(\d+)(?=;|$)/g)].map(m => m[1]).join(','); }
  function mount() {
    host = document.createElement('div'); host.id = 'baodan-finance-entry';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;right:24px;bottom:24px;z-index:2147483000;font:14px/1.5 Arial,"PingFang SC",sans-serif;color:#172033}.card{width:300px;padding:18px;background:#fff;border:1px solid #dbe5f5;border-radius:12px;box-shadow:0 8px 30px #183a6826}strong{font-size:16px}p{margin:10px 0;overflow-wrap:anywhere;color:#667085}p[data-state=matched]{color:#177245}button{font:inherit;background:#155acb;color:#fff;border:0;border-radius:6px;padding:9px 14px;cursor:pointer;width:100%}small{display:block;color:#667085;margin-top:8px}';
    const card = document.createElement('section'); card.className = 'card'; card.setAttribute('aria-label', '爆单ERP财务原件归档');
    const title = document.createElement('strong'); title.textContent = '财务原件归档';
    status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const open = document.createElement('button'); open.type = 'button'; open.textContent = '选择月份并下载原件';
    open.onclick = async () => {
      try { const result = await chrome.runtime.sendMessage({ type: 'OZON_FINANCE_OPEN' }); if (!result?.ok) throw new Error(result?.error || '无法打开归档'); }
      catch (error) { status.dataset.state = 'pending'; status.textContent = '请刷新 Ozon 页面后重试：' + error.message; }
    };
    const tip = document.createElement('small'); tip.textContent = '按店铺 ID 匹配 ERP 店铺名称；原件默认英语。';
    card.append(title, status, open, tip); root.append(style, card); document.documentElement.append(host);
  }
  async function update() {
    if (!isDocuments()) { host?.remove(); host = null; signature = ''; revision++; return; }
    if (!host) mount();
    const id = currentId();
    if (id !== signature) { signature = id; lastCheck = 0; revision++; status.dataset.state = 'pending'; status.textContent = '店铺已变化，正在重新匹配…'; }
    if (checking || (lastCheck && Date.now() - lastCheck < 20000)) return;
    checking = true; const requestRevision = revision; lastCheck = Date.now();
    status.dataset.state = 'pending'; status.textContent = '正在识别当前店铺并匹配 ERP…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'OZON_FINANCE_MATCH' });
      if (requestRevision !== revision || !host || currentId() !== id) return;
      status.dataset.state = result?.ok ? 'matched' : 'pending';
      status.textContent = result?.ok ? `已匹配 ERP 店铺：${result.shopName} · Ozon ID：${result.company}` : '尚未匹配：' + (result?.error || '请确认 ERP 已登录后重试');
    } catch { if (host && requestRevision === revision) status.textContent = '插件连接已更新，请刷新此 Ozon 页面后重新识别。'; }
    finally { checking = false; }
  }
  window.addEventListener('focus', () => { lastCheck = 0; update(); });
  setInterval(() => { if (!document.hidden) update(); }, 1000);
  update();
})();

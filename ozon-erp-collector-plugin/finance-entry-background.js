'use strict';
// Only the extension's isolated Seller content script can request this read-only match.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['OZON_FINANCE_MATCH', 'OZON_FINANCE_OPEN'].includes(message?.type)) return;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      !/^https:\/\/seller\.ozon\.ru\/app\/finances\/documents(?:[/?#]|$)/.test(sender.url || '') || !sender.tab?.id) {
    respond({ ok: false, error: '请从 Ozon 财务文件页面打开归档' }); return false;
  }
  const sellerTab = sender.tab.id;
  async function match() {
    const [seller] = await chrome.scripting.executeScript({ target: { tabId: sellerTab }, world: 'MAIN', func: globalThis.OzonFinanceSellerRequest, args: [{}] });
    if (!seller?.result?.ok) throw new Error(seller?.result?.error || 'Ozon 页面尚未响应，请刷新后重试');
    const id = seller.result.company;
    const tabs = await chrome.tabs.query({ url: ['https://erp.hjt888.xyz/*', 'http://localhost:8788/*', 'http://127.0.0.1:8788/*'] });
    if (!tabs.length) throw new Error(`Ozon ID：${id}；请先打开并登录 ERP，以匹配店铺名称`);
    const month = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
    const matches = []; let lastError;
    for (const tab of tabs) {
      try {
        const [erp] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: globalThis.OzonFinanceErpContextRequest, args: [{ ozon_company_id: id, months: month }] });
        if (!erp?.result?.ok) throw new Error(erp?.result?.error || 'ERP 页面尚未响应');
        const context = erp.result.data;
        if (String(context.shop?.ozon_company_id) !== id) throw new Error('ERP 返回的店铺 ID 与当前 Ozon 店铺不一致，请核对绑定');
        matches.push({ erpTab: tab.id, context });
      } catch (error) { lastError = error; }
    }
    if (!matches.length) throw new Error(`Ozon ID：${id}；${lastError?.message || '尚未匹配 ERP 店铺，请登录后重试'}`);
    if (new Set(matches.map(m => `${m.context.tenant_id}/${m.context.shop.id}`)).size !== 1) throw new Error(`Ozon ID：${id}；检测到多个 ERP 企业，请打开归档后选择正确的 ERP 页面`);
    // Re-read after ERP requests so a shop switch never displays an obsolete match.
    const [verified] = await chrome.scripting.executeScript({ target: { tabId: sellerTab }, world: 'MAIN', func: globalThis.OzonFinanceSellerRequest, args: [{ company: id }] });
    if (!verified?.result?.ok) throw new Error(verified?.result?.error || '当前店铺已变化，请重新识别');
    const chosen = matches[0];
    return { ok: true, company: id, shopName: chosen.context.shop.name, erpTab: chosen.erpTab };
  }
  async function run() {
    if (message.type === 'OZON_FINANCE_MATCH') return match();
    // The archive page validates this source tab again; URL parameters grant no authority.
    let erpTab = '';
    try { erpTab = '&erpTab=' + (await match()).erpTab; } catch {}
    await chrome.tabs.create({ url: chrome.runtime.getURL('finance-archive.html') + '?sellerTab=' + sellerTab + erpTab });
    return { ok: true };
  }
  run().then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

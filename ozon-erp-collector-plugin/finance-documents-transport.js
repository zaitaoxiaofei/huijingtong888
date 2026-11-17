'use strict';
async function sellerRequest(input) {
  try {
    if (location.origin !== 'https://seller.ozon.ru') throw new Error('所选页面已离开 Ozon Seller，请重新选择后台页面');
    const readId = () => {
      const ids = [...document.cookie.matchAll(/(?:^|;\s*)sc_company_id=(\d+)(?=;|$)/g)].map(m => m[1]);
      if (new Set(ids).size !== 1) throw new Error('当前店铺 ID 未能确定，请在 Ozon 后台选择店铺后重试');
      return ids[0];
    };
    const company = readId();
    if (input.company && input.company !== company) throw new Error('Ozon 当前店铺已切换，请重新读取目录');
    if (!input.request) {
      if (!location.pathname.startsWith('/app/finances/documents')) throw new Error('请选择 Ozon 财务 → 文件页面；可点击“打开 Ozon 财务文件”后刷新列表');
      const directoryNames = [...document.querySelectorAll('[role="listbox"] > li')].map(n => n.textContent.trim());
      if (!directoryNames.length) throw new Error('财务目录尚未加载，请等待 Ozon 页面加载完成后重试');
      return { ok: true, company, title: document.title, directoryNames };
    }
    const req = input.request, url = new URL(req.path, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) throw new Error('文件接口地址无效');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url.href, { method: req.method || 'GET', credentials: 'include', signal: controller.signal,
        headers: { 'x-o3-company-id': company, 'x-o3-app-name': 'seller-ui', 'content-type': 'application/json' },
        ...(req.body ? { body: JSON.stringify(req.body) } : {}) });
      if (!response.ok) throw new Error(`Ozon 请求失败（HTTP ${response.status}），请检查登录状态或稍后重试`);
      if (readId() !== company) throw new Error('读取期间店铺发生切换，已停止保存，请重新读取目录');
      if (!input.binary) {
        const text = await response.text();
        if (readId() !== company) throw new Error('读取期间店铺发生切换，请重新读取目录');
        return { ok: true, data: text ? JSON.parse(text) : {} };
      }
      let blob, serverName;
      if (req.base64_result) {
        const data = (await response.json()).result;
        if (!data?.file_content || data.file_content.length > 56 * 1024 * 1024) throw new Error('Ozon 尚未提供发运原件或原件超过限制，请在原目录核对');
        blob = new Blob([Uint8Array.from(atob(data.file_content), c => c.charCodeAt(0))], { type: data.content_type || 'application/pdf' });
        serverName = data.file_name;
      } else blob = await response.blob();
      if (!blob.size || blob.size > 40 * 1024 * 1024) throw new Error('原件为空或超过单文件 40MB 限制，请在 Ozon 原目录下载');
      if (/json|text\/html/.test(blob.type)) throw new Error('Ozon 返回了提示页面，尚未取得原件');
      const buffer = await blob.arrayBuffer(), bytes = new Uint8Array(buffer);
      const pdf = bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70;
      const zip = bytes[0] === 80 && bytes[1] === 75;
      if (!pdf && !zip) throw new Error('文件不是已支持的 PDF、XLSX 或 ZIP 原件，请在原目录核对');
      if (readId() !== company) throw new Error('下载期间店铺发生切换，已停止保存');
      let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { ok: true, base64: btoa(binary), type: blob.type, size: blob.size,
        sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(b => b.toString(16).padStart(2, '0')).join(''),
        filename: serverName, disposition: response.headers.get('content-disposition') || '' };
    } finally { clearTimeout(timer); }
  } catch (error) { return { ok: false, error: error.message }; }
}
globalThis.OzonFinanceSellerRequest = sellerRequest;

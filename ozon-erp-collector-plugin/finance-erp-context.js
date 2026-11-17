'use strict';
// Authentication remains inside the selected ERP tab.
async function erpContextRequest(input) {
  try {
    const allowed = location.origin === 'https://erp.hjt888.xyz' || ['http://localhost:8788', 'http://127.0.0.1:8788'].includes(location.origin);
    if (!allowed) throw new Error('所选ERP页面来源不受支持，请重新选择已登录页面');
    const token = localStorage.getItem('authToken');
    if (!token) throw new Error('ERP登录已失效，请先重新登录');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/finance-center/document-archive-context?' + new URLSearchParams(input), {
        credentials: 'include', headers: { Authorization: 'Bearer ' + token }, signal: controller.signal });
      if (response.status === 404) throw new Error('ERP后台尚未安装主体归档接口，请先发布配套后台更新；也可使用下方单月下载入口');
      if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('ERP尚未提供归档归属接口，请先发布后台更新并确认登录');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '无法读取ERP主体归属（HTTP ' + response.status + '），请检查财务权限或后台版本');
      if (localStorage.getItem('authToken') !== token) throw new Error('ERP登录或企业已切换，请重新检查归属');
      if (!data.binding_token || !Array.isArray(data.bindings)) throw new Error('ERP归属接口格式不匹配，请更新后台后重试');
      return { ok: true, data };
    } finally { clearTimeout(timer); }
  } catch (error) { return { ok: false, error: error.message }; }
}
globalThis.OzonFinanceErpContextRequest = erpContextRequest;

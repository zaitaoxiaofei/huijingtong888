'use strict';
// Serialized into the selected ERP tab. The bearer token never leaves that tab.
async function financeSystemRequest(input) {
 try {
  if (!['https://erp.hjt888.xyz','http://localhost:8788','http://127.0.0.1:8788'].includes(location.origin)) throw new Error('请选择受支持的 ERP 页面');
  const token = localStorage.getItem('authToken'); if (!token) throw new Error('ERP 登录已失效，请重新登录后再同步');
  async function request(path, options = {}) {
   const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
   try {
    const response = await fetch(path, { ...options, credentials: 'include', signal: controller.signal,
     headers: { Authorization: 'Bearer ' + token, ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
    if (localStorage.getItem('authToken') !== token) throw new Error('ERP 登录或企业已切换，请重新检查后同步');
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('ERP 同步接口未就绪，请确认后台版本及登录状态');
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '系统同步失败（HTTP ' + response.status + '）'); return data;
   } finally { clearTimeout(timer); }
  }
  const context = await request('/api/finance-center/document-archive-context?' + new URLSearchParams(input.query));
  const binding = context.bindings.find(b => b.month === input.month);
  if (context.binding_token !== input.binding_token || context.tenant_id !== input.tenant_id || context.shop.id !== input.shop_id || !binding || binding.error || binding.company.id !== input.company_id) throw new Error('企业、店铺或月份主体绑定已变化，请重新检查后同步');
  const payload = { action: 'lookup', company_id: input.company_id, shop_id: input.shop_id, month: input.month, archive_source: input.source };
  const found = await request('/api/finance-center/document-import', { method: 'POST', body: JSON.stringify(payload) });
  if (found.document || !input.file) return { ok: true, data: found };
  if (input.file.base64.length > 28 * 1024 * 1024) throw new Error('系统单份原件上限为 20MB，本地原件已保留，请手动处理');
  const bytes = Uint8Array.from(atob(input.file.base64), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('系统单份原件上限为 20MB，本地原件已保留');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
  if (hash !== input.source.sha256) throw new Error('本地原件已变化，请重新检查');
  const form = new FormData(); form.append('file', new Blob([bytes], { type: input.file.type }), input.file.name);
  const uploaded = await request('/api/finance-center/voucher-attachments', { method: 'POST', body: form });
  if (!uploaded.ok || !uploaded.url) throw new Error('原件上传未完成，请重试');
  const result = await request('/api/finance-center/document-import', { method: 'POST', body: JSON.stringify({ ...payload, action: 'preview', upload_type: 'auto', attachment_url: uploaded.url }) });
  return { ok: true, data: result };
 } catch (error) { return { ok: false, error: error.name === 'AbortError' ? '同步请求超时，请点击同步重试，已有文件会自动检测' : error.message }; }
}
globalThis.OzonFinanceSystemRequest = financeSystemRequest;
(function(root) {
 async function syncMonth(options) {
  const { directory, plan, row, execute, verifySeller, onProgress, stopped, folderIds } = options;
  const archive = root.OzonFinanceArchive, local = await archive.inspect(directory, plan.context, row.binding, plan.language);
  const result = { synced: 0, existing: 0, errors: 0, pending: 0, support: 0 };
  if (!local.manifest) return result;
  const verified = new Set(local.verified.map(v => v.doc));
  for (const item of local.manifest.sections || []) for (const doc of item.documents || []) {
   if (folderIds.includes(item.folder.id) && !verified.has(doc)) { doc.system_sync_error = '本地原件缺失或校验未通过，请先重新下载'; result.errors++; options.onFileResult?.(doc); }
  }
  if (result.errors) await archive.checkpoint(directory, local.manifest);
  for (const { item, doc } of local.verified) {
   if (stopped()) break;
   if (!folderIds.includes(item.folder.id)) continue;
   onProgress(`同步 ${row.binding.month} / ${doc.name || doc.id}`);
   try {
    if (doc.bytes > 20 * 1024 * 1024) throw new Error('原件超过系统20MB上限，本地文件已保留');
    const blob = await archive.readFile(directory, doc.path);
    if (blob.size > 20 * 1024 * 1024) throw new Error('原件超过系统20MB上限，本地文件已保留');
    if (await archive.digest(blob) !== doc.sha256) throw new Error('本地原件已变化，请重新检查');
    await verifySeller();
    const input = { query: plan.query, binding_token: plan.context.binding_token, tenant_id: plan.context.tenant_id,
     company_id: row.binding.company.id, shop_id: plan.context.shop.id, month: row.binding.month,
     source: { ozon_company_id: plan.context.shop.ozon_company_id, months: plan.query.months, binding_token: plan.context.binding_token,
      folder_id: item.folder.id, section: item.section[0], document_id: String(doc.id), document_type: doc.document_type?.code || '',
      list_date: String(doc.date || ''), language: plan.language, sha256: doc.sha256 } };
    let value = (await execute(plan.erp_tab, root.OzonFinanceSystemRequest, input)).data;
    if (!value.document) {
     const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
     for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
     input.file = { base64: btoa(binary), type: blob.type || 'application/octet-stream', name: doc.download_name || doc.file_name || doc.path.split('/').at(-1) };
     if (stopped()) break;
     await verifySeller(); value = (await execute(plan.erp_tab, root.OzonFinanceSystemRequest, input)).data;
    }
    if (!value.document?.id || !['preview','confirmed','error'].includes(value.document.parse_status)) throw new Error('系统未返回原件归档结果，请确认后台版本');
    doc.system = { document_id: value.document.id, parse_status: value.document.parse_status, month: value.document.month_key,
     attachment_url: value.document.attachment_url, sha256: doc.sha256, kind: value.document.payload_json?.kind, warnings: (value.document.payload_json?.warnings || []).slice(0,5) };
    if (value.document.month_key !== row.binding.month) doc.system.note = `原件已归档在 ${value.document.month_key}，未改动业务月份`;
    delete doc.system_sync_error;
    if (value.duplicate) result.existing++; else result.synced++;
    if (value.document.parse_status === 'error') result.pending++;
    if (value.document.payload_json?.kind === 'support') result.support++;
   } catch (error) {
    result.errors++; doc.system_sync_error = error.message;
    if (/切换|已变化|登录|企业|主体绑定/.test(error.message)) { await archive.checkpoint(directory, local.manifest); throw error; }
   }
   await archive.checkpoint(directory, local.manifest);
   options.onFileResult?.(doc);
  }
  return result;
 }
 root.OzonFinanceSystemSync = { syncMonth };
})(globalThis);

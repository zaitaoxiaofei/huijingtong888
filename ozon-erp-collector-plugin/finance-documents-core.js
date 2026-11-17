/* Official Seller document transport. No accounting classification or ledger writes. */
(function (root) {
  'use strict';
  const BASE = '/api/site/self-gateway/finance/documents/';
  const folders = [
    ['updWithAdditionalServices', '含附加服务的通用传输文件', [['', BASE + 'upd']]],
    ['realizationReports', '销售报告', [['结算单据', BASE + 'realization/closing'], ['参考信息', BASE + 'realization/reference']]],
    ['b2bSales', '向法人销售', [['销售登记册', BASE + 'b2b_sales'], ['用于提交联邦税务局的文件', '/api/site/edm/upd/reports/list']]],
    ['agentReports', '合作伙伴报告', [['报告', BASE + 'agent-reports/reports'], ['发票', BASE + 'agent-reports/reinvoices']]],
    ['analyticalReports', '分析报告', [['', BASE + 'realization_report_commission_description']]],
    ['compensationsAndOtherCharges', '赔偿及其它应计项目', [['', BASE + 'compensation']]],
    ['securityPayments', '保证金与罚款', [['', '/api/site/seller-finance/fines/documents']]],
    ['invoices', '扣款与待付账单', [['扣款', '/api/site/seller-finance/netting/documents'], ['付款账单', BASE + 'invoices']]],
    ['reconciliationActs', '对账单', [['平台出具', '/api/site/api/v1/reconciliation/list-acts'], ['已申请', '/api/site/api/v1/reconciliation/by-seller-request/{company}/list']]],
    ['actsFBS', 'FBS发运', [['', '/api/carriage-service/carriage/list']]]
  ].map(([id, name, sections]) => ({ id, name, sections }));

  function monthRange(month) {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('请选择有效月份（YYYY-MM）');
    const [year, m] = month.split('-').map(Number);
    return { from: month + '-01', to: month + '-' + new Date(Date.UTC(year, m, 0)).getUTCDate() };
  }
  function safeName(value) {
    return String(value || '未命名').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
      .replace(/^\.+|[. ]+$/g, '_').slice(0, 160) || '未命名';
  }
  function identity() {
    const ids = [...document.cookie.matchAll(/(?:^|;\s*)sc_company_id=(\d+)(?=;|$)/g)].map(m => m[1]);
    if (new Set(ids).size !== 1) throw new Error('当前 Ozon 店铺 ID 未能确定，请在 Seller 后台重新选择店铺后重试');
    return ids[0];
  }
  function documentKey(d) {
    return [d.id, d.document_type?.code, d.data_source, d.file_extension, d.attachment_id || ''].join('|');
  }
  function responseFilename(disposition, fallback) {
    const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
    const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition || '');
    try { return decodeURIComponent(extended?.[1] || plain?.[1] || plain?.[2]?.trim() || fallback); }
    catch { return fallback; }
  }
  function pathFor(company, month, folder, section, d, filename) {
    return [company, month, folder.name, section, `${safeName(d.id)}_${safeName(d.document_type?.code)}_${safeName(filename)}`]
      .filter(Boolean).map(safeName).join('/');
  }
  function listRequest(folder, section, company, month) {
    const { from, to } = monthRange(month);
    const path = section[1].replace('{company}', company);
    if (folder.id === 'actsFBS') return { path, method: 'POST', body: { filter: { company_id: company, date_from: from, date_to: to }, limit: '999' } };
    if (path.endsWith('/reports/list') || path.includes('/by-seller-request/')) return { path };
    const params = path.includes('seller-finance/') || path.endsWith('list-acts') ? { date_from: from, date_to: to } : { from, to };
    if (path.endsWith('list-acts')) params.language = 'en';
    return { path: path + '?' + new URLSearchParams(params) };
  }
  function normalizeList(data, folder, section, month) {
    let rows;
    if (folder.id === 'actsFBS') {
      if (!Array.isArray(data.result)) throw new Error('FBS 文件目录结构变化，请在 Ozon 页面核对');
      if (data.result.length >= 999) throw new Error('FBS 发运达到接口上限，不能确认目录完整，请缩小期间后在 Ozon 导出');
      rows = data.result.flatMap(r => Object.entries(r.related_docs || {}).filter(([, v]) => v).map(([type, value]) => ({
        id: r.id, date: r.departure_date, name: type, document_type: { code: type }, file_extension: 'pdf', data_source: 'FBS', carriage: value
      })));
    } else if (section[1].endsWith('/reports/list')) {
      if (!Array.isArray(data.reports)) throw new Error('法人税务文件目录结构变化');
      rows = data.reports.flatMap(r => (r.attachments || []).map(a => ({ id: r.request_id, attachment_id: a.id,
        date: r.request_completion_date || r.create_date, name: a.name, file_name: a.name,
        document_type: { code: 'EdmAttachment' }, data_source: 'EDM', status: r.status })));
    } else if (folder.id === 'reconciliationActs') {
      if (!Array.isArray(data)) throw new Error('对账单目录结构变化');
      rows = data.map(r => ({ ...r, id: r.actId || r.act_id || r.id, date: r.createdAt || r.created_at,
        name: r.name, document_type: { code: r.reportSysName || r.report_sys_name || 'RequestedReconciliation' },
        file_name: (r.name || 'Reconciliation') + '.pdf', file_extension: 'pdf',
        data_source: section[0] === '平台出具' ? 'Reports' : 'RequestedReconciliation' }));
    } else {
      rows = Array.isArray(data) ? data : data.documents;
      if (!Array.isArray(rows)) throw new Error('文件目录结构变化，请在 Ozon 页面核对');
    }
    const found = [], seen = new Set();
    function visit(row, parent) {
      const d = { ...row, date: row.date || parent?.date };
      if (Array.isArray(d.children) && d.children.length) { for (const child of d.children) visit(child, d); return; }
      if (!d.date || !/^\d{4}-\d{2}-\d{2}/.test(d.date)) throw new Error('文件缺少有效日期，不能确认月份归属');
      if (!d.date.startsWith(month)) return;
      if (typeof d.document_type === 'string') d.document_type = { code: d.document_type };
      if (!d.id || !d.document_type?.code) throw new Error('文件缺少编号或类型，不能安全下载');
      const key = documentKey(d);
      if (!seen.has(key)) { seen.add(key); found.push(d); }
    }
    rows.forEach(r => visit(r));
    return found;
  }

  // Codes using Ozon's ask/status/download protocol, verified against the Seller page implementation.
  const askCodes = new Set([
    'MarketplaceDocumentExecutionJobAct', 'MarketplaceDocumentExecutionJobActOt', 'DocumentConsigInvoice',
    'DocumentRealizationReportCommissionDescription', 'DocumentRealizationReportCommissionMutualSettlement',
    'MarketplaceDocumentCurrencyReport', 'ApplicationToReportMarketplaceDocumentCurrency',
    'DocumentRealizationReportCommission', 'DocumentRealizationReportCommission052021',
    'ReportCurrencyCrossborderPayDynamic', 'KrossborderPayfromMarketplaceDocumentDynamic',
    'ReschedulingDeliveryServiceCommonReportBeforeAugust', 'DocumentAccountPaymentRequest',
    'ActOfReconciliationByQuarter', 'MarketplaceInterGroupSellerOffsetWithServiceProvider',
    'RealizationReportGeneralBilling', 'RealizationReportGeneralBillingByExternalId',
    'RealizationReportByPostingBilling', 'RealizationReportByPostingBillingByExternalId',
    'RealizationReportTraceableGoodsBilling', 'RealizationReportTraceableGoodsBillingByExternalId',
    'RealizationReportByInstanceBilling', 'RealizationReportByInstanceBillingByExternalId', 'AgentReinvoices'
  ]);
  const serviceRoutes = {
    RfbsGlobalReinvoicedServicesReport: 'rfbs-global-reinvoiced-services', RfbsDeliveryChargesReport: 'rfbs-delivery-charges',
    ReinvoicedServiceReport: 'reinvoiced-service', RfbsReinvoicedServiceReports: 'rfbs-reinvoiced-services',
    FboFbsReinvoicedServiceReports: 'fbo-fbs-reinvoices-service', AcquiringReinvoicedServicesReport: 'acquiring-reinvoiced-services',
    ReinvoicedVatReport: 'reinvoiced-vat', StarsMembershipReinvoicedServicesReport: 'stars-membership-reinvoiced-services',
    AcquiringReinvoicedServicesSummaryReport: 'acquiring-reinvoiced-services-summary'
  };
  function downloadPlan(d, company, language = 'ru') {
    if (!/^\d+$/.test(String(company)) || !['ru', 'en'].includes(language)) throw new Error('店铺或语言无效');
    const code = d.document_type?.code, id = encodeURIComponent(d.id);
    const filename = d.file_name || `${code}_${d.number || d.id}_${String(d.date).slice(0, 10)}.${d.file_extension || 'pdf'}`;
    if (d.data_source === 'FBS' && ['act_of_acceptance', 'act_of_mismatch', 'act_of_excess'].includes(code)) {
      return { filename, request: { path: code === 'act_of_mismatch' ? '/api/carriage-service/carriage/mismatch-act/get' : '/api/carriage-service/carriage/document/get',
        method: 'POST', base64_result: true, body: { company_id: company, carriage_id: d.id, ...(code === 'act_of_mismatch' ? {} : { doc_type: [code] }) } } };
    }
    if (askCodes.has(code)) {
      const billing = code.startsWith('RealizationReport') || code === 'AgentReinvoices';
      const base = billing ? '/api/site/self-reports/api/reports/' : '/api/site/erpmp-reports/api/reports/';
      const query = new URLSearchParams({ [billing ? 'report_type' : 'report_sys_name']: code, language });
      return { filename, ask: { path: base + 'ask', method: 'POST', body: billing
        ? { report_id: d.id, report_type: code, language, filename }
        : { document_id: d.id, report_sys_name: code, language } },
        status: { path: `${base}${id}/status?${query}` }, request: { path: `${base}${id}/download?${query}&file_name=${encodeURIComponent(filename)}` } };
    }
    const prefix = '/api/site/self-gateway/api/reports/' + company;
    let path;
    if (code === 'RealizationReport') path = `${prefix}/realization/download?year=${d.date.slice(0, 4)}&month=${d.date.slice(5, 7)}&language=${language}`;
    else if (serviceRoutes[code]) path = `${prefix}/agent-services/${serviceRoutes[code]}/download?reportNumber=${id}&language=${language}`;
    else if (['CoinvestmentDetailsReport', 'CoinvestmentDetailsReportByExternalId'].includes(code)) path = `/api/site/self-realization-report/api/reports/${company}/coinvestment/details/download?reportId=${id}&type=${code}&language=${language}`;
    else if (['DocumentMarketplaceSellerCompensationByTypeDoc', 'DocumentMarketplaceSellerCompensationByTypeDocTypeIDCurr', 'DocumentMarketplaceSellerCompensationByTypeDocKzt'].includes(code)) path = `/api/site/compensation/api/reports/${company}/${id}/download?documentType=${code}&language=${language === 'ru' ? 'Russian' : 'English'}`;
    else if (['ReschedulingDeliveryServiceCommonReportAfterAugust', 'MarketplaceRedistributionOfDeliveryServices'].includes(code)) path = `/api/site/api/v1/reinvoices/sellers/${company}/${code === 'MarketplaceRedistributionOfDeliveryServices' ? 'report-lk' : 'report'}?metazonDocumentId=${id}&language=${language}`;
    else if (code === 'MarketplaceDocumentAgentReportSeller') path = `/api/site/agent-seller-reports/api/reports/agent-seller-report/${company}/${id}/download?language=${language}`;
    else if (/^DocumentInternalSetOffBalanceCurr/.test(code)) path = `/api/site/api/v1/internal-setoff-non-res/sellers/${company}/setoff-document?metazonDocumentId=${id}&language=${language}`;
    else if (code === 'DocumentAgentServiceStarsMembership') path = `/api/site/stars-membership/api/reports/${company}/printed-form/${id}/xlsx?language=${language}`;
    else if (code === 'DocumentB2BSales') path = `/api/site/api/v1/sellers/${company}/reports/${id}/register-of-sales-legal?language=${language}`;
    else if (code === 'EdmAttachment' && d.status === 'Complete') path = `/api/site/edm/upd/attachments?report_id=${id}&attachment_id=${encodeURIComponent(d.attachment_id)}`;
    else throw new Error(`该文件下载方式尚未适配：${code}，请在 Ozon 原目录下载`);
    return { filename, request: { path } };
  }
  async function prepare(plan, request, sleep = ms => new Promise(r => setTimeout(r, ms))) {
    if (!plan.ask) return;
    await request(plan.ask);
    for (let i = 0; i < 40; i++) {
      const data = await request(plan.status);
      if (data.status === 'Ready') return;
      if (!['Pending', 'Generating'].includes(data.status)) throw new Error('Ozon 文件生成失败：' + String(data.status));
      await sleep(1500);
    }
    throw new Error('Ozon 文件仍在生成，请稍后重试此文件');
  }
  root.OzonFinanceDocuments = { folders, monthRange, safeName, identity, documentKey, responseFilename, pathFor, listRequest, normalizeList, downloadPlan, prepare };
})(globalThis);

import { financeDocumentArchiveContext } from './finance-document-archive-context.js';
const folders = new Map([
 ['updWithAdditionalServices','含附加服务的通用传输文件'],['realizationReports','销售报告'],['b2bSales','向法人销售'],
 ['agentReports','合作伙伴报告'],['analyticalReports','分析报告'],['compensationsAndOtherCharges','赔偿及其它应计项目'],
 ['securityPayments','保证金与罚款'],['invoices','扣款与待付账单'],['reconciliationActs','对账单'],['actsFBS','FBS发运']
]);
const fail = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };
const text = (value, max, label) => { if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) fail(`同步来源的${label}无效，请在插件重新检查月份后重试`); return value; };
export function createArchiveSourceValidator({ readContext = financeDocumentArchiveContext } = {}) {
 return async function validate(input, ctx, sha256) {
  const source = input.archive_source;
  if (!source) return null;
  if (input.upload_type && input.upload_type !== 'auto') fail('插件原件请选择自动解析，不可同时指定人工费用或配套分类');
  if (!/^[a-f0-9]{64}$/.test(source.sha256 || '') || sha256 && source.sha256 !== sha256) fail('同步原件校验和不一致，请重新检查本地文件');
  if (!folders.has(source.folder_id) || !['en','ru'].includes(source.language)) fail('同步原件的官方目录或语言无效，请更新插件后重新检查');
  const id = text(String(source.document_id ?? ''), 160, '单据编号'); if (!id) fail('同步原件缺少官方单据编号');
  const section = text(source.section || '', 160, '子目录'), type = text(source.document_type || '', 180, '文件类型');
  const date = text(source.list_date || '', 80, '列表日期');
  const context = await readContext({ ozon_company_id: source.ozon_company_id, months: source.months }, ctx.s);
  const binding = context.bindings.find(b => b.month === input.month);
  if (context.tenant_id !== ctx.tenantId || context.shop.id !== Number(input.shop_id) || !binding || binding.error || binding.company.id !== ctx.companyId || context.binding_token !== source.binding_token) fail('企业、店铺或月份主体归属已变化，请在插件重新检查后再同步');
  return { platform: 'ozon', ozon_company_id: context.shop.ozon_company_id, list_month: input.month,
   folder_id: source.folder_id, folder_name: folders.get(source.folder_id), section, document_id: id, document_type: type,
   list_date: date, language: source.language, sha256: source.sha256, received_at: new Date().toISOString() };
 };
}
export const validateArchiveSource = createArchiveSourceValidator();

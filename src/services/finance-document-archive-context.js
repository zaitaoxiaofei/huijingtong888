import { createHash } from 'node:crypto';
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from './business-task-tenant.js';

const queryMysql = async (...args) => (await import('../mysql-pool.js')).mysqlQuery(...args);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export function archiveMonths(value) {
  const months = [...new Set(Array.isArray(value) ? value : String(value || '').split(','))].sort();
  if (!months.length || months.length > 24 || months.some(m => !/^20\d{2}-(0[1-9]|1[0-2])$/.test(m))) fail('请选择1至24个有效月份（months，格式YYYY-MM）');
  return months;
}
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
export function createFinanceDocumentArchiveContext({ query = queryMysql, authorize = authorizeBusinessTaskSession } = {}) {
  return async function read(input, session) {
    const actor = await authorize(session);
    assertBusinessTaskPermission(actor, 'finance');
    const tenantId = Number(actor.tenant?.id), legacy = actor.tenant?.slug === 'default' ? 1 : 0;
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) fail('当前登录会话缺少企业归属，请重新登录', 403);
    const months = archiveMonths(input.months), seller = String(input.ozon_company_id || '');
    if (!/^\d{1,20}$/.test(seller)) fail('请先在Ozon财务文件页面识别店铺ID（ozon_company_id）');
    const shops = await query(`SELECT id,name,ozon_client_id FROM shops
      WHERE TRIM(ozon_client_id)=? AND status!='deleted'
      AND (tenant_id=? OR (?=1 AND tenant_id IS NULL))`, [seller, tenantId, legacy]);
    if (shops.length !== 1) fail(shops.length ? '当前企业多个店铺使用同一Ozon ID，请在店铺管理核对Client-Id后重试' : '当前Ozon店铺未绑定到当前企业，请在店铺管理核对Client-Id（ozon_client_id）', 409);
    const shop = shops[0];
    const rows = await query(`SELECT a.company_id,a.effective_from,a.effective_to,c.name AS company_name,c.tax_number
      FROM finance_shop_company_assignments a JOIN finance_companies c ON c.id=a.company_id AND c.status!='deleted'
      WHERE a.shop_id=? AND (a.tenant_id=? OR (?=1 AND a.tenant_id IS NULL))
      AND (c.tenant_id=? OR (?=1 AND c.tenant_id IS NULL))
      AND a.effective_from<=LAST_DAY(CONCAT(?,'-01')) AND (a.effective_to IS NULL OR a.effective_to>=CONCAT(?,'-01'))`,
    [shop.id, tenantId, legacy, tenantId, legacy, months.at(-1), months[0]]);
    const bindings = months.map(month => {
      const from = month + '-01', [y, m] = month.split('-').map(Number), to = month + '-' + new Date(Date.UTC(y, m, 0)).getUTCDate();
      const candidates = rows.filter(r => day(r.effective_from) <= to && (!r.effective_to || day(r.effective_to) >= from));
      if (candidates.length !== 1 || day(candidates[0].effective_from) > from || (candidates[0].effective_to && day(candidates[0].effective_to) < to)) {
        return { month, error: `${month}的公司主体绑定缺失、不覆盖整月或存在重叠，请在财务设置→公司与店铺归属中核对生效日期（effective_from/effective_to）` };
      }
      const row = candidates[0];
      return { month, company: { id: Number(row.company_id), name: row.company_name, tax_number: row.tax_number || '' } };
    });
    const result = { tenant_id: tenantId, shop: { id: Number(shop.id), name: shop.name, ozon_company_id: seller }, bindings };
    return { ...result, binding_token: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
  };
}
export const financeDocumentArchiveContext = createFinanceDocumentArchiveContext();

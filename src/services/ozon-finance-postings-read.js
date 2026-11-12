import { mysqlQuery } from '../mysql-pool.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { isEnterpriseAdmin } from '../shared/permissions.js';
import { fetchOzonPostingFinance } from '../ozonClient.js';

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const apiKey = shop => String(shop.ozon_api_key || shop.api_key || shop.api_key_hint || '');

export async function readOzonPostingFinanceMysql(body, session, { signal } = {}) {
  const shopId = Number(body?.shop_id);
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || !Array.isArray(body?.order_ids)
    || !body.order_ids.length || body.order_ids.length > 200) throw fail('请选择店铺及 1 至 200 个本地订单后核对费用', 400);
  const ids = [...new Set(body.order_ids.map(Number))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw fail('本地订单编号无效，请重新选择订单', 400);
  if (body.write || body.apply_profit || body.applyProfit) throw fail('此接口仅用于只读核对，不能写入账本或重算利润', 400);
  let initial, orders;
  const guard = async () => {
    if (signal?.aborted) throw signal.reason || fail('订单费用查询已取消', 499);
    const currentSession = await authorizeBusinessTaskSession(session);
    if (!isEnterpriseAdmin(currentSession)) throw fail('仅本企业负责人或管理员可以核对订单费用', 403);
    const [shop] = await mysqlQuery(`SELECT * FROM shops WHERE id=? AND status='active'
      AND (tenant_id=? OR (?=1 AND tenant_id IS NULL))`, [shopId, currentSession.tenant.id, Number(currentSession.tenant.slug === 'default')]);
    if (!shop) throw fail('店铺不存在、已停用或不属于当前企业', 404);
    if (shop.platform && shop.platform !== 'ozon') throw fail('所选店铺不属于 Ozon，不能读取 Ozon 订单费用', 409);
    if (initial && (String(shop.ozon_client_id) !== String(initial.ozon_client_id) || apiKey(shop) !== apiKey(initial))) throw fail('店铺授权在费用读取期间发生变化，请检查店铺配置后重新核对', 409);
    const current = await mysqlQuery(`SELECT id,posting_number FROM orders WHERE shop_id=? AND id IN (${ids.map(() => '?').join(',')})`, [shopId, ...ids]);
    if (current.length !== ids.length) throw fail('部分订单不存在或不属于当前店铺，请重新选择订单', 404);
    if (current.some(order => typeof order.posting_number !== 'string' || !order.posting_number.trim())) throw fail('部分订单缺少 Ozon 货件号，请先同步订单详情', 409);
    if (orders && current.some(order => !orders.some(old => Number(old.id) === Number(order.id) && old.posting_number === order.posting_number))) throw fail('订单归属或货件号在费用读取期间发生变化，请重新选择订单', 409);
    initial ||= shop;orders ||= current;
    return shop;
  };
  const shop = await guard();
  const result = await fetchOzonPostingFinance(shop, { postingNumbers: orders.map(order => order.posting_number), beforeRequest: guard, signal });
  await guard();
  return { ...result, shop_id: shopId, rows: result.rows.map(row => ({ ...row,
    order_ids: orders.filter(order => order.posting_number === row.posting_number).map(order => Number(order.id)) })) };
}

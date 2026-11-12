import { normalizeOzonAccrualTypes } from './ozon-finance-accruals.js';

export const OZON_FINANCE_POSTINGS_ENDPOINT = '/v1/finance/accrual/postings';
const TYPES = '/v1/finance/accrual/types';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, statusCode = 502) => Object.assign(new Error(message), { code: 'OZON_FINANCE_POSTINGS_INVALID', statusCode });
const check = signal => { if (signal?.aborted) throw signal.reason || fail('订单费用查询已取消', 499); };
function integer(value, label) {
  if ((typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^\d+$/.test(value))) return String(value);
  throw fail(`Ozon 订单费用的 ${label} 缺失、格式异常或超出可验证精度，请稍后核对接口响应`);
}
function money(value, label) {
  if (!record(value) || typeof value.amount !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.amount)
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) throw fail(`Ozon 订单费用的 ${label} 金额或币种格式已变化，未将未知金额当作零`);
  return { amount: value.amount, currency: value.currency };
}
function accrual(row, types) {
  if (!record(row) || typeof row.accrual_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.accrual_date)
    || !Number.isFinite(Date.parse(row.accrual_date + 'T00:00:00Z'))
    || new Date(row.accrual_date + 'T00:00:00Z').toISOString().slice(0, 10) !== row.accrual_date) throw fail('Ozon 订单费用日期缺失或格式异常');
  if (row.quantity != null && !Number.isSafeInteger(row.quantity)) throw fail('Ozon 订单费用数量格式异常');
  const typeId = integer(row.type_id, '计提类型编号(type_id)');
  return { accrual_date: row.accrual_date, type_id: typeId, type_name: types.get(typeId)?.name || null,
    sku: row.sku == null ? null : integer(row.sku, '商品SKU(sku)'), quantity: row.quantity ?? null,
    accrued: money(row.accrued, '计提金额(accrued)'), seller_price: row.seller_price == null ? null : money(row.seller_price, '卖家价格(seller_price)') };
}

// The official report has no accrual_id. Preserve repeated rows and original
// decimal strings; never manufacture ledger identities or infer whole-order totals.
export async function fetchOzonPostingAccruals(shop, { postingNumbers, request, beforeRequest, signal } = {}) {
  if (!Array.isArray(postingNumbers) || postingNumbers.some(value => typeof value !== 'string' || !value.trim())) throw fail('请选择有效的货件号', 400);
  const numbers = [...new Set(postingNumbers.map(value => value.trim()))];
  if (!numbers.length || numbers.length > 200) throw fail('订单费用每次只读查询 1 至 200 个货件', 400);
  if (typeof request !== 'function' || (beforeRequest !== undefined && typeof beforeRequest !== 'function')) throw fail('订单费用查询缺少有效请求器或授权检查', 400);
  const guard = async () => { check(signal);const current = await beforeRequest?.(shop);check(signal);return current || shop; };
  const read = async (path, body) => {
    const current = await guard();
    const result = await request(path, body, { method: 'POST', signal, shop: current, beforeRequest: guard });
    await guard();return result;
  };
  const types = normalizeOzonAccrualTypes(await read(TYPES, {}));
  if (!types.size) throw fail('Ozon 财务类型字典为空，无法确认订单费用类型');
  const response = await read(OZON_FINANCE_POSTINGS_ENDPOINT, { posting_numbers: numbers });
  if (!record(response) || !Array.isArray(response.posting_accruals)) throw fail('Ozon 订单费用响应缺少 posting_accruals 数组');
  const requested = new Set(numbers), returned = new Map();
  for (const posting of response.posting_accruals) {
    check(signal);
    if (!record(posting) || !requested.has(posting.posting_number) || returned.has(posting.posting_number)
      || !Array.isArray(posting.accruals)) throw fail('Ozon 返回未请求、重复货件或缺失的费用明细，停止核对');
    returned.set(posting.posting_number, posting.accruals.map(row => accrual(row, types)));
  }
  await guard();
  const rows = numbers.map(posting_number => ({ posting_number,
    status: !returned.has(posting_number) ? 'not_returned' : returned.get(posting_number).length ? 'returned' : 'returned_empty',
    accruals: returned.get(posting_number) ?? null }));
  return { source_endpoint: OZON_FINANCE_POSTINGS_ENDPOINT, read_only: true, requests: 2, rows,
    missing_posting_numbers: numbers.filter(number => !returned.has(number)),
    unknown_type_count: rows.flatMap(row => row.accruals || []).filter(row => !row.type_name).length,
    coverage_note: '仅显示所选货件的接口返回；母单及未关联费用仍需按日账单核对，不能据此认定整单财务已齐全。' };
}

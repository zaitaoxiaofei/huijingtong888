const fields = [
  'retailAmount', 'forPay', 'ppvzSalesCommission', 'acquiringFee', 'deliveryService',
  'paidStorage', 'paidAcceptance', 'penalty', 'deduction', 'additionalPayment',
  'cashbackAmount', 'cashbackDiscount', 'cashbackCommissionChange', 'rebillLogisticCost'
];

const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const round = value => Math.round(value * 100) / 100;
const identifier = (value, allowZero = false) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const id = String(value ?? '');
  return (/^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n) || (allowZero && id === '0') ? id : null;
};
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function normalizeWbSettlementRow(row) {
  const reportId = identifier(row.reportId);
  const rowId = identifier(row.rrdId);
  if (!reportId || !rowId) throw fail('WB 账单缺少有效的报表编号或流水编号。', 502);
  const payload = { currency: String(row.currency || '').toUpperCase(), date: String(row.rrDate || ''),
    type: String(row.docTypeName || ''), operation: String(row.sellerOperName || '') };
  for (const field of fields) payload[field] = number(row[field]);
  return { reportId, rowId, orderId: identifier(row.orderId), payload };
}

export async function summarizeWbSettlement(records, costCny, fxForDay = async () => null) {
  const lines = records.map(row => ({
    report_id: String(row.report_id), row_id: String(row.row_id),
    ...(typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json)
  }));
  const totals = new Map();
  const fxDays = new Map();
  let hasSale = false;
  let convertedNet = 0;
  let completeFx = true;
  let needsReview = false;
  for (const line of lines) {
    const sign = /^(Продажа|Sale)$/iu.test(line.type) ? 1 : /^(Возврат|Return)$/iu.test(line.type) ? -1 : 0;
    if (sign === 1 && line.forPay != null) hasSale = true;
    if ((line.forPay && !sign) || (sign && line.forPay == null) || !/^[A-Z]{3}$/.test(line.currency)) needsReview = true;
    // These report columns may represent either charges or credits. Keep the evidence
    // visible and require reconciliation before showing a definitive net result.
    if (line.deduction || line.additionalPayment || line.rebillLogisticCost ||
      line.cashbackAmount || line.cashbackDiscount || line.cashbackCommissionChange) needsReview = true;
    const aggregate = totals.get(line.currency) || Object.fromEntries(fields.map(field => [field, 0]));
    for (const field of fields) {
      const value = line[field] ?? 0;
      aggregate[field] += ['forPay', 'retailAmount', 'ppvzSalesCommission', 'acquiringFee'].includes(field) && sign
        ? sign * Math.abs(value) : value;
    }
    totals.set(line.currency, aggregate);
    const lineNet = (sign ? sign * Math.abs(line.forPay ?? 0) : 0)
      - (line.deliveryService ?? 0) - (line.paidStorage ?? 0) - (line.paidAcceptance ?? 0) - (line.penalty ?? 0);
    if (line.currency === 'CNY') convertedNet += lineNet;
    else if (lineNet !== 0) {
      if (line.currency === 'RUB' && /^\d{4}-\d{2}-\d{2}$/.test(line.date) && !fxDays.has(line.date)) {
        fxDays.set(line.date, await fxForDay(line.date));
      }
      const fx = line.currency === 'RUB' ? fxDays.get(line.date) : null;
      if (Number(fx?.rate) > 0) {
        convertedNet += lineNet / Number(fx.rate);
        line.fx_rate = fx.rate;
        line.fx_source_date = fx.source_date;
      } else completeFx = false;
    }
  }
  const amounts = [...totals].map(([currency, totals]) => {
    const subtotal = totals.forPay - totals.deliveryService - totals.paidStorage - totals.paidAcceptance - totals.penalty;
    return { currency, ...Object.fromEntries(fields.map(field => [field, round(totals[field])])),
      net_settlement: hasSale && !needsReview ? round(subtotal) : null };
  });
  const netCny = hasSale && !needsReview && completeFx ? round(convertedNet) : null;
  return { lines, amounts, net_settlement_cny: netCny, actual_profit_cny: netCny == null || costCny == null ? null : round(netCny - costCny),
    state: !lines.length ? 'pending' : needsReview ? 'needs_review' : !completeFx ? 'needs_fx' : 'reported' };
}

export async function pullWbSettlementPage({ account, request, transaction, body }) {
  const from = String(body.date_from || ''), to = String(body.date_to || '');
  const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!day(from) || !day(to) || to < from || Date.parse(to) - Date.parse(from) > 30 * 86400000) {
    throw fail('请选择不超过 31 天的 WB 账单日期范围。');
  }
  const cursor = identifier(body.cursor ?? 0, true);
  if (!cursor) throw fail('WB 账单分页流水号无效，请重新开始同步。');
  const limit = 1000;
  const result = await request(account, 'finance', '/api/finance/v1/sales-reports/detailed', {
    method: 'POST', body: { dateFrom: from, dateTo: `${to}T23:59:59`, limit, rrdId: JSON.rawJSON(cursor), period: 'weekly',
      fields: ['reportId','rrdId','orderId','currency','rrDate','docTypeName','sellerOperName', ...fields] }
  });
  if (result && !Array.isArray(result) && Object.keys(result).length === 0) {
    return { fetched: 0, linked_candidates: 0, next_cursor: null };
  }
  if (!Array.isArray(result)) throw fail('WB 账单响应格式无效，请稍后再试。', 502);
  const rows = result.map(normalizeWbSettlementRow);
  const last = rows.at(-1)?.rowId;
  if (rows.length && BigInt(last) <= BigInt(cursor)) throw fail('WB 账单分页未推进，已停止同步。', 502);
  const matched = rows.filter(row => row.orderId);
  if (matched.length) {
    await transaction(async db => {
      for (let offset = 0; offset < matched.length; offset += 100) {
        const chunk = matched.slice(offset, offset + 100);
        await db.execute(`INSERT INTO wb_order_settlement_lines
          (tenant_id,shop_id,report_id,row_id,wb_order_id,payload_json)
          VALUES ${chunk.map(() => '(?,?,?,?,?,?)').join(',')}
          ON DUPLICATE KEY UPDATE wb_order_id=VALUES(wb_order_id),payload_json=VALUES(payload_json)`,
        chunk.flatMap(row => [account.tenant_id, account.shop_id, row.reportId, row.rowId, row.orderId, JSON.stringify(row.payload)]));
      }
    });
  }
  return { fetched: rows.length, linked_candidates: matched.length, next_cursor: last || null };
}

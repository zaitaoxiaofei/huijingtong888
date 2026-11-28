export function wbProfitView(snapshot) {
  const value = snapshot?.estimated_profit_cny;
  const known = value != null && value !== '' && Number.isFinite(Number(value));
  return {
    amount: known ? Number(value) : null,
    known,
    status: known ? '' : snapshot ? '待补齐参数' : '未重算',
    provisional: known && snapshot.provisional === true
  };
}

export function wbProfitRecalculationTargets(rows) {
  if (!rows.length) throw new Error('当前没有可重算的 WB 订单。');
  if (rows.some(row => row.platform !== 'wb')) throw new Error('请单独选择 WB 订单重算利润，不要混选其他平台订单。');
  const ids = [...new Set(rows.map(row => Number(row.id)))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('订单编号无效，请刷新订单列表后重试。');
  if (ids.length > 100) throw new Error('单次最多重算 100 条 WB 订单，请分批选择。');
  return ids;
}

export function wbProfitRecalculationMessage(result) {
  const rows = result?.results || [];
  const saved = rows.filter(row => row.status === 'saved').length;
  const pending = rows.filter(row => row.status !== 'saved');
  const reasons = pending.slice(0, 3).map(row => {
    const fields = (row.missing_inputs || []).map(field => typeof field === 'string' ? field : field.label).filter(Boolean);
    return `订单 ${row.order_id}：${row.error || (fields.length ? `缺少${fields.join('、')}` : '请进入利润明细补齐参数')}`;
  });
  return {
    kind: pending.length || !saved ? 'warning' : 'success',
    message: [`已保存 ${saved} 单利润`, ...(pending.length ? [`${pending.length} 单待补齐参数`, ...reasons, '请进入对应订单的「查看明细」配置后重算。'] : [])].join('；')
  };
}

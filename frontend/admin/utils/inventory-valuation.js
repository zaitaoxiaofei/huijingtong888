function knownNumber(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

export function inventoryValuationExplanation(row) {
  const local = knownNumber(row.physical_stock), fbp = knownNumber(row.fbp_stock_known), cost = knownNumber(row.avg_unit_cost);
  const quantity = value => value == null ? '未读取' : String(value);
  return `货值 =（本地实物 ${quantity(local)} + FBP 实物 ${quantity(fbp)}）× 平均采购成本 ${cost == null ? '未填写' : `¥${cost.toFixed(2)}`}。采用当前实物数量，不采用历史采购数量或可用库存；缺失数据不按 0 计算。`;
}

export function inventoryValuation(row) {
  const local = knownNumber(row.physical_stock), fbp = knownNumber(row.fbp_stock_known);
  const cost = knownNumber(row.avg_unit_cost);
  const value = quantity => quantity == null ? null : quantity === 0 ? 0 : cost == null || cost < 0 ? null : quantity * cost;
  const localValue = value(local), fbpValue = value(fbp);
  const missing = [];
  if (local == null) missing.push('本地库存未读取');
  if (fbp == null) missing.push('FBP 库存未完整同步');
  if ((local !== 0 || fbp !== 0) && (cost == null || cost < 0)) missing.push('采购成本未填写');
  return { local: localValue, fbp: fbpValue,
    total: localValue == null || fbpValue == null ? null : localValue + fbpValue,
    reason: missing.join('；') };
}

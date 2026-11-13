const fields = {
  package_weight_g: '包裹重量（克）', length_cm: '包裹长（厘米）', width_cm: '包裹宽（厘米）', height_cm: '包裹高（厘米）',
  purchase_cost: '采购单价', domestic_shipping: '国内运费', purchase_quantity: '采购数量', handling_fee: '处理费',
  logistics_rule_id: '物流运价规则', shipping_method: '物流渠道', return_rate: '退货率',
  withdrawal_fee_rate: '提现费率', payment_fee_rate: '收单费率', advertising_rate: '广告费率', exchange_rate: '参考汇率'
};
export function productProfitParameterChanges(before = {}, after = {}) {
  return Object.entries(fields).flatMap(([key, label]) => {
    if (!Object.hasOwn(after, key)) return [];
    const numeric = key !== 'shipping_method';
    const previous = numeric ? Number(before[key] || 0) : String(before[key] || '');
    const next = numeric ? Number(after[key] || 0) : String(after[key] || '');
    return previous === next ? [] : [{ key, label, before: previous, after: next }];
  });
}
export function recommendProfitRecalculation(changes = []) {
  return changes.some(change => ['logistics_rule_id', 'shipping_method'].includes(change.key)) ? 'future' : 'existing';
}

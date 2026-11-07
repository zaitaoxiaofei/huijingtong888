export const inventoryAdjustmentReasons = [
  { code: 'damage', label: '库存损耗／损坏', direction: 'decrease' },
  { code: 'sample', label: '样品领用／样品损耗', direction: 'decrease' },
  { code: 'loss', label: '货物丢失', direction: 'decrease' },
  { code: 'missing_purchase', label: '已有现货，缺采购记录', direction: 'increase' },
  { code: 'history_error', label: '历史库存记错', direction: 'any' },
  { code: 'count_confirmed', label: '清点确认，数量一致', direction: 'same' },
  { code: 'other', label: '其他原因', direction: 'any' }
];

export function validateInventoryAdjustment(code, note, delta) {
  const reason = inventoryAdjustmentReasons.find(item => item.code === code);
  if (!reason) throw new Error('请选择更新本地库存的调整原因（reason_code）');
  if (reason.direction === 'decrease' && delta >= 0) throw new Error('损耗、样品或丢失仅用于实际数量减少，请核对实际数量和调整原因');
  if (reason.direction === 'increase' && delta < 0) throw new Error('补采购记录不能解释库存减少，请选择实际减少原因');
  if (reason.direction === 'same' && delta !== 0) throw new Error('数量有差异，请选择调整原因，不能选择数量一致');
  if (code === 'other' && !String(note || '').trim()) throw new Error('选择其他原因时，请填写补充说明（reason_note）');
  return `${reason.label}${String(note || '').trim() ? `：${String(note).trim()}` : ''}`;
}

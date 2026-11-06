import { buildOrderProfitDetail } from '../../../orders/utils/order-profit-detail.js';

// Use the same structured, version-aware snapshot as the desktop detail.
// Missing snapshots must not become a new estimate from current item data.
export function mobileOrderProfitDetail(payload) {
  const snapshot = payload?.profit_detail_snapshot;
  const rows = snapshot?.detailRows ?? snapshot?.rows;
  if (!snapshot?.summary || !Array.isArray(rows) || !rows.length) return null;
  return buildOrderProfitDetail(payload.order, payload.items, payload.finance, snapshot);
}

export function profitAmountText(value, signed = false) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '未记录';
  const amount = Number(value);
  return `CNY ${signed && amount > 0 ? '+' : ''}${amount.toFixed(2)}`;
}

export function profitRowValue(row, column) {
  const text = row?.[`${column}Text`];
  if (text) return text;
  const value = row?.[column];
  if (value === null || value === undefined || value === '') return column === 'estimated' ? '未记录' : '--';
  return profitAmountText(value, column === 'diff');
}

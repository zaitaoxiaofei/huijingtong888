// Aftersale observations are independent of the original posting lifecycle.
// MoneyReturned proves a refund, never a physical receipt or completed disposal.
const states = Object.freeze({
  MoneyReturned: { status: 'refunded', label: '已退款', refund: 'returned', goods: 'unknown', rank: 5 },
  UtilizedByOzon: { status: 'disposed', label: '退货已销毁', refund: 'unknown', goods: 'disposed', rank: 6 },
  UtilizingByOzon: { status: 'disposing', label: '退货待销毁', refund: 'unknown', goods: 'disposing', rank: 4 },
  ArrivedAtWarehouse: { status: 'returned_to_warehouse', label: '已退至海外仓', refund: 'unknown', goods: 'warehouse', rank: 3 },
  PartialCompensationReturnedByOzon: { status: 'partial_compensation', label: '已签收／部分补偿', refund: 'partial', goods: 'unknown', rank: 2 },
  Solved: { status: 'closed_without_return', label: '售后已答复', refund: 'unknown', goods: 'unknown', rank: 0 },
  Cancelled: { status: 'request_cancelled', label: '退货申请已取消', refund: 'unknown', goods: 'unknown', rank: 0 }
});
export function ozonReturnState(record = {}) {
  const officialState = String(record.state?.state ?? record.official_state ?? '').trim();
  const known = states[officialState];
  return { official_state: officialState, ...(known || { status: 'possible_return', label: '可能退货，待人工确认', refund: 'unknown', goods: 'unknown', rank: 1 }), needs_review: !known };
}
export function summarizeOzonReturns(records = []) {
  const observations = records.map(record => ({ ...record, ...ozonReturnState(record) }));
  if (!observations.length) return null;
  observations.sort((a,b) => b.rank-a.rank || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const first = observations[0];
  return { status: first.status, label: first.label, needs_review: observations.some(r=>r.needs_review),
    refund_confirmed: observations.some(r=>r.refund==='returned'),
    partial_compensation: observations.some(r=>r.refund==='partial'),
    goods: observations.find(r=>r.goods!=='unknown')?.goods || 'unknown',
    return_ids: [...new Set(observations.map(r=>String(r.return_id)))],
    official_states: [...new Set(observations.map(r=>r.official_state))],
    // Request creation and observation time must not be reported as refund completion.
    refund_completed_at: null, observations };
}

export function ozonReturnFilterSql(scope, kind='aftersale', orderAlias='o') {
  if(!Number.isSafeInteger(scope?.id)||scope.id<=0||!/^\w+$/.test(orderAlias))throw new Error('Invalid return tenant scope');
  const known="'MoneyReturned','UtilizedByOzon','UtilizingByOzon','ArrivedAtWarehouse','PartialCompensationReturnedByOzon','Solved','Cancelled'";
  const condition=kind==='possible_return'?`r.official_state NOT IN (${known})`:`r.official_state NOT IN ('Solved','Cancelled')`;
  return `EXISTS (SELECT 1 FROM ozon_return_observations r WHERE r.tenant_id=${scope.id} AND r.order_id=${orderAlias}.id AND r.shop_id=${orderAlias}.shop_id AND BINARY r.posting_number=BINARY ${orderAlias}.posting_number AND ${condition})`;
}

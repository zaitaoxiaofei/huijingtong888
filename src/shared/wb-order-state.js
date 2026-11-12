// WB's seller state and WB/carrier state are independent. Submission to delivery
// is not evidence of physical acceptance, and a cancellation is not a stock return.
export function wbOrderState(supplierStatus, wbStatus) {
  if (['canceled', 'canceled_by_client', 'declined_by_client', 'canceled_by_carrier', 'defect'].includes(wbStatus)
    || ['cancel', 'cancel_carrier'].includes(supplierStatus)) return { status: 'cancelled', label: '已取消', stage: 'cancelled' };
  if (wbStatus === 'sold') return { status: 'delivered', label: '已签收', stage: 'delivered' };
  if (['sorted', 'accepted_by_carrier', 'ready_for_pickup', 'postponed_delivery'].includes(wbStatus)) {
    return { status: 'delivering', label: wbStatus === 'ready_for_pickup' ? '待买家取件' : '运输中', stage: wbStatus };
  }
  if (wbStatus === 'sent_to_carrier') return { status: 'delivering', label: '送往承运商', stage: 'sent_to_carrier' };
  if (supplierStatus === 'complete') return { status: 'awaiting_deliver', label: '待揽收', stage: 'handover_submitted' };
  if (supplierStatus === 'confirm') return { status: 'awaiting_deliver', label: '待交接', stage: 'awaiting_deliver' };
  if (supplierStatus === 'new') return { status: 'awaiting_packaging', label: '待备货', stage: 'pending_stock' };
  return { status: 'wb_unknown', label: '状态待核对', stage: 'wb_unknown' };
}

export function wbOrderCapabilities(row = {}) {
  const active = !['cancelled', 'delivered', 'wb_unknown'].includes(wbOrderState(row.wb_supplier_status, row.wb_status).status);
  return {
    prepare: active && row.wb_supplier_status === 'new',
    print: active && ['confirm', 'complete'].includes(row.wb_supplier_status),
    handover: active && row.wb_supplier_status === 'confirm' && Boolean(row.wb_supply_id),
    splitPrepare: false
  };
}

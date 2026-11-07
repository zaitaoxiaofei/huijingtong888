// Manual business marks hold unfinished orders until the operator selects no mark.
export function hasManualOrderMark(order = {}) {
  return Boolean(String(order.mark_type || '').trim());
}

export function orderHasDispatchHold(order = {}) {
  if (!hasManualOrderMark(order) || order.delivered_at || Number(order.cancelled_after_ship) > 0
    || order.ogl_dispatch?.dispatched || order.ogl_dispatch?.dispatched_at) return false;
  const state = [order.order_status ?? order.platform_status ?? order.status,
    order.order_tracking_stage ?? order.tracking_stage,
    order.order_logistics_status ?? order.logistics_status].map(value => String(value || '').toLowerCase()).join(' ');
  return !/cancel|return|reject|not_accepted|unclaimed|arbitration|dispute/.test(state)
    && !/(^|\s)(delivering|delivered|posting_delivered|posting_received|posting_in_transit|posting_in_customs|posting_sorting|posting_on_way[^\s]*|posting_in_courier_service|posting_in_pickup_point|posting_received_by_buyer|driver_pickup|posting_driver_pick_up|shipped|sent|transferring|on_way|pickup|sorting|customs)(\s|$)/.test(state);
}

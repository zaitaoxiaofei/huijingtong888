export const PROCUREMENT_CANCELLATION_CAUSES = {
  replacement: '售后处理／其他商品替代',
  already_handled: '本次无需采购／需求有误',
  supplier_out_of_stock: '没货／厂家断货',
  no_shipment: '不发货',
  other: '其他原因'
};

// These are purchasing decisions, never evidence of stock or order fulfillment.
export function activeDemandCancellations(events = []) {
  const active = new Map();
  for (const event of [...events].sort((a, b) => Number(a.id) - Number(b.id))) {
    const detail = typeof event.detail_json === 'string' ? JSON.parse(event.detail_json) : event.detail_json || {};
    for (const source of detail.sources || []) {
      const key = `${Number(event.product_id)}:${Number(source.order_item_id)}`;
      if (detail.operation === 'restore') active.delete(key);
      else active.set(key, { ...source, product_id: Number(event.product_id), event_id: Number(event.id), cause: detail.cause,
        note: detail.note, created_at: event.created_at, person_name: event.person_name || '', person_id: event.person_id });
    }
  }
  return active;
}

export function cancelledOrderPurchase(order, productId, active) {
  const cancellation = active.get(`${Number(productId)}:${Number(order.order_item_id)}`);
  const quantity = cancellation && (order.needs_fulfillment == null || Boolean(order.needs_fulfillment))
    ? Math.min(Math.max(0, Number(order.shortage_quantity) || 0), Math.max(0, Number(cancellation.quantity) || 0)) : 0;
  return { cancellation: cancellation || null, cancelled_purchase_quantity: quantity,
    actionable_shortage_quantity: Math.max(0, Number(order.shortage_quantity) || 0) - quantity };
}

export function applyDemandCancellations(workflow, orders, productId, active) {
  const cancelled = orders.filter(row => row.needs_fulfillment).reduce((sum, row) => sum + cancelledOrderPurchase(row, productId, active).cancelled_purchase_quantity, 0);
  if (!cancelled) return workflow;
  const plan = { ...workflow.supply_plan }, amount = Math.min(cancelled, Number(plan.required_fbs) || 0);
  plan.raw_required_fbs = plan.required_fbs;
  plan.cancelled_fbs = amount;
  plan.unresolved_fbs = amount;
  if (plan.required_fbs != null) plan.required_fbs = Math.max(0, plan.required_fbs - amount);
  if (plan.required_purchase != null) plan.required_purchase = Math.max(0, plan.required_purchase - amount);
  return { ...workflow, supply_plan: plan,
    purchase_quantity: workflow.purchase_quantity == null ? null : Math.max(0, workflow.purchase_quantity - amount),
    purchase_partial: !plan.known && plan.fbs_known && plan.required_fbs > 0,
    demands: workflow.demands.map(demand => demand.key === 'real_order' ? { ...demand, purchase_quantity: plan.required_fbs,
      required_purchase_quantity: plan.required_fbs, cancelled_purchase_quantity: amount,
      submitted_quantity: Math.min(demand.submitted_quantity || 0, plan.required_fbs || 0),
      status: plan.required_fbs > 0 ? 'danger' : 'warning', process_status: 'purchase_cancelled' } : demand),
    review_reasons: [...workflow.review_reasons, `已取消本次采购 ${amount} 件；已转订单人工处理，不再进入待采购；原因及备注保留在处理记录中`],
    overall: workflow.overall === 'success' ? 'warning' : workflow.overall,
    stock_status: workflow.stock_status === 'success' ? 'warning' : workflow.stock_status,
    local_stock_status: workflow.local_stock_status === 'success' ? 'warning' : workflow.local_stock_status };
}

// Keep factual shortages, but remove reviewed sources from purchasing queues.
export function applyOrderProcurementCancellations(coverage, events = []) {
  const active = activeDemandCancellations(events);
  for (const order of coverage.values()) {
    order.cancelled_purchase_quantity = 0;
    order.actionable_shortage_quantity = 0;
    for (const item of order.items || []) {
      const decision = cancelledOrderPurchase({...item, needs_fulfillment: order.needs_fulfillment}, item.product_id, active);
      Object.assign(item, decision);
      order.cancelled_purchase_quantity += decision.cancelled_purchase_quantity;
      order.actionable_shortage_quantity += decision.actionable_shortage_quantity;
    }
    order.procurement_manually_handled = order.cancelled_purchase_quantity > 0;
  }
  return coverage;
}

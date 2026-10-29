// One physical-unit policy for the diagram, order badges and purchasing queue.
export const INVENTORY_DEMAND_TYPES = [
  { key: 'real_order', label: 'FBS真实订单需求', priority: 1 },
  { key: 'local_safety', label: '本地安全保障需求', priority: 2 },
  { key: 'fbp_stock', label: 'FBP备货缺口需求', priority: 3 }
];
const known = value => value != null && value !== '' && Number.isFinite(Number(value));
const qty = value => Math.max(0, Math.ceil(Number(value) || 0));
export function procurementDemandType(request = {}) {
  if (request.request_reason_code === 'flow_real_order') return 'real_order';
  if (request.request_reason_code === 'flow_fbp_stock' || request.request_reason_code === 'fbp_stock_shortage' || request.source_type === 'fbp') return 'fbp_stock';
  return request.demand_type === 'real_order' || (request.demand_type !== 'warehouse_request' && request.source_order_item_id) ? 'real_order' : 'local_safety';
}
export function inventoryWorkflow(ledger = {}, { applications, forecast, requests = [] } = {}) {
  const flow = ledger.flow_summary || {};
  applications ??= flow.applications;
  const complete = !flow.unavailable && [ledger.physical_estimate, ledger.open_order_demand, ledger.fbp_reserved, flow.safety].every(known) && Number(ledger.physical_estimate) >= 0;
  const physical = qty(ledger.physical_estimate), orders = qty(ledger.open_order_demand), locked = qty(ledger.fbp_reserved), safety = qty(flow.safety);
  const incoming = qty(ledger.incoming_quantity), assigned = qty(ledger.current_incoming);
  const orderGap = Math.max(0, orders - Math.max(0, physical - locked));
  const orderBuy = known(ledger.current_shortage) ? qty(ledger.current_shortage) : Math.max(0, orderGap - assigned);
  const safetyGap = Math.max(0, safety - Math.max(0, physical - locked - orders));
  const unassigned = Math.max(0, incoming - assigned);
  const safetyBuy = Math.max(0, safetyGap - unassigned);
  const free = Math.max(0, physical - orders - locked - safety);
  // Drafts and predictions do not reserve supply or create a purchase obligation.
  // Warehouse approval closes the quantity decision; approved stock is already in locked.
  const submitted = (applications || []).filter(row => row.status === 'pending_review');
  const requested = submitted.reduce((sum, row) => sum + qty(row.requested_quantity), 0);
  const fbpGap = Math.max(0, requested - free);
  const fbpBuy = Math.max(0, fbpGap - Math.max(0, unassigned - safetyGap));
  const applicationKnown = Array.isArray(applications) && flow.applications_pending !== true;
  const make = (type, physicalGap, purchase, ready = complete) => ({ ...type,
    physical_gap: ready ? physicalGap : null, purchase_quantity: ready ? purchase : null,
    status: !ready ? 'unknown' : purchase > 0 ? 'danger' : physicalGap > 0 ? 'warning' : 'success',
    requests: requests.filter(r => procurementDemandType(r) === type.key),
    submitted_quantity: Math.max(0,...requests.filter(r => procurementDemandType(r) === type.key && ['submitted','pending'].includes(r.status)).map(r=>qty(r.quantity)))
  });
  const demands = [make(INVENTORY_DEMAND_TYPES[0], orderGap, orderBuy), make(INVENTORY_DEMAND_TYPES[1], safetyGap, safetyBuy), make(INVENTORY_DEMAND_TYPES[2], fbpGap, fbpBuy, complete && applicationKnown)];
  // Supply colour describes quantities; application progress is a separate signal.
  for(const demand of demands)if(demand.submitted_quantity>0)demand.process_status='request_submitted';
  if(submitted.length)demands[2].process_status='pending_review';
  else if((applications||[]).some(r=>r.status==='draft'))demands[2].process_status='draft';
  const stock_status=['danger','warning','unknown','success'].find(status=>demands.some(d=>d.status===status));
  const opportunities = (forecast?.skus || []).filter(row => qty(row.suggested_qty) > 0);
  if (!requested && !submitted.length && opportunities.length && demands[2].status === 'success') demands[2].advisory_status = opportunities.some(row => Number(row.available) > 0) ? 'warning' : 'opportunity';
  const overall = ['danger','warning','unknown','opportunity','success'].find(status => demands.some(d => d.status === status));
  return { demands, overall, stock_status, physical:complete?physical:null, order_demand:complete?orders:null, safety:complete?safety:null, locked:complete?locked:null, free: complete ? free : null, requested, opportunities,
    purchase_quantity: complete && applicationKnown ? orderBuy + safetyBuy + fbpBuy : null,
    local_days: flow.local_days, fbp_days: flow.fbp_days, incoming,
    incoming_note: incoming ? '在途不能立即发货；请核对到货时间，晚于交付期限的批次不能保障本次发货' : '',
    requests, calculated_at: new Date().toISOString() };
}

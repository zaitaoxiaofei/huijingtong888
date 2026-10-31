import { inventoryLocalEvidence } from './inventory-local-evidence.js';
import { inventorySupplyPlan,inventoryPurchaseQuantity } from './inventory-supply-plan.js';
import { fbpSupplyState, fbpLocalSupplyNeed } from './fbp-supply-state.js';
// One physical-unit policy for the diagram, order badges and purchasing queue.
export const INVENTORY_DEMAND_TYPES = [
  { key: 'real_order', label: 'FBS真实订单需求', priority: 1 },
  { key: 'local_safety', label: '本地安全保障需求', priority: 2 },
  { key: 'fbp_stock', label: 'FBP正式备货申请', priority: 3 },
  { key: 'fbp_forecast', label: 'FBP预测预警建议', priority: 4 }
];
const known = value => value != null && value !== '' && Number.isFinite(Number(value));
const qty = value => Math.max(0, Math.ceil(Number(value) || 0));
export function procurementDemandType(request = {}) {
  if (request.request_reason_code === 'flow_fbp_forecast') return 'fbp_forecast';
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
  const fbp = fbpSupplyState(forecast, ledger.fbp_inventory);
  const fbpNeed = fbpLocalSupplyNeed(applications, fbp);
  const fbpGap = Math.max(0, fbpNeed - free);
  const fbpBuy = Math.max(0, fbpGap - Math.max(0, unassigned - safetyGap));
  const applicationKnown = Array.isArray(applications) && flow.applications_pending !== true;
  const make = (type, physicalGap, purchase, ready = complete) => ({ ...type,
    physical_gap: ready ? physicalGap : null, purchase_quantity: ready ? purchase : null,
    status: !ready ? 'unknown' : purchase > 0 ? 'danger' : physicalGap > 0 ? 'warning' : 'success',
    requests: requests.filter(r => procurementDemandType(r) === type.key),
    submitted_quantity: Math.max(0,...requests.filter(r => procurementDemandType(r) === type.key && ['submitted','pending'].includes(r.status)).map(r=>qty(r.quantity)))
  });
  const demands = [make(INVENTORY_DEMAND_TYPES[0], orderGap, orderBuy), make(INVENTORY_DEMAND_TYPES[1], safetyGap, safetyBuy), make(INVENTORY_DEMAND_TYPES[2], fbpGap, fbpBuy, complete && applicationKnown),make(INVENTORY_DEMAND_TYPES[3],0,0,false)];
  const supply_plan=inventorySupplyPlan(ledger,applications,forecast);
  if(supply_plan.known){
    const required=[supply_plan.required_fbs,0,supply_plan.required_fbp,0];
    const optional=[0,supply_plan.optional_local,0,supply_plan.optional_fbp??0];
    for(let i=0;i<demands.length;i++){
      demands[i].required_purchase_quantity=required[i];demands[i].optional_purchase_quantity=optional[i];
      demands[i].purchase_quantity=required[i]+optional[i];
      if(i===1)demands[i].physical_gap=supply_plan.local_physical_gap;
      if(i===2)demands[i].physical_gap=supply_plan.required_fbp_physical_gap;
      if(i===3)demands[i].physical_gap=supply_plan.forecast_fbp_physical_gap;
      demands[i].status=required[i]>0?'danger':optional[i]>0?'warning':'success';
    }
  }else{
    for(const [index,quantity] of [[0,supply_plan.required_fbs],[1,supply_plan.optional_local],[2,supply_plan.required_fbp],[3,supply_plan.optional_fbp]]){
      demands[index].purchase_quantity=quantity;
      demands[index].required_purchase_quantity=index===0||index===2?quantity:0;
      demands[index].optional_purchase_quantity=index===1||index===3?quantity:0;
      demands[index].status=quantity==null?'unknown':quantity>0?(index===0||index===2?'danger':'warning'):'success';
    }
  }
  const local_stock_status = ['danger','warning','unknown','success'].find(status=>demands.slice(0,2).some(d=>d.status===status));
  demands[3].replenishment_quantity=supply_plan.fbp_forecast_quantity??(fbp.known?Math.max(0,fbpNeed-requested):null);
  demands[3].status=!fbp.known?'unknown':supply_plan.optional_fbp!=null?supply_plan.optional_fbp>0?'warning':'success':fbp.replenish_quantity>0?'warning':'success';
  if(!fbp.known)demands[3].purchase_quantity=null;
  demands[3].fbp_stock_status=fbp.status;
  demands[2].replenishment_quantity = requested;
  demands[2].fbp_stock_status = fbp.status;

  // Supply colour describes quantities; application progress is a separate signal.
  for(const demand of demands)if(demand.submitted_quantity>0)demand.process_status='request_submitted';
  if(submitted.length)demands[2].process_status='pending_review';
  else if((applications||[]).some(r=>r.status==='draft'))demands[2].process_status='draft';
  const statusDemands=fbp.known?demands:demands.slice(0,3);
  const stock_status=['danger','warning','unknown','success'].find(status=>statusDemands.some(d=>d.status===status));
  const opportunities = (forecast?.skus || []).filter(row => qty(row.suggested_qty) > 0);
  if (!requested && !submitted.length && opportunities.length && demands[3].status === 'unknown') demands[3].advisory_status = opportunities.some(row => Number(row.available) > 0) ? 'warning' : 'opportunity';
  const overall = ['danger','warning','unknown','opportunity','success'].find(status => statusDemands.some(d => d.status === status));
  const review_reasons = [];
  if (!known(ledger.physical_estimate)) review_reasons.push('缺少本地账面库存，请核对实物');
  else if (Number(ledger.physical_estimate) < 0) review_reasons.push('本地账面库存为负，请盘点并更新实物');
  if (!known(flow.safety)) review_reasons.push('本地保障规则或消耗数据待核对');
  if (!applicationKnown) review_reasons.push('FBP申请数据尚未完整读取');
  return { local_evidence: inventoryLocalEvidence(ledger), review_reasons, physical_recorded: known(ledger.physical_estimate) ? Number(ledger.physical_estimate) : null, safety_target: known(flow.safety) ? qty(flow.safety) : null, demands, overall, stock_status, local_stock_status, fbp, supply_plan, physical:complete?physical:null, order_demand:complete?orders:null, safety:complete?safety:null, locked:complete?locked:null, free: complete ? free : null, requested, opportunities,
    purchase_quantity: inventoryPurchaseQuantity(supply_plan),purchase_partial:!supply_plan.known&&supply_plan.fbs_known&&supply_plan.required_fbs>0,
    local_days: flow.local_days, fbp_days: flow.fbp_days, incoming,
    incoming_note: incoming ? '在途不能立即发货；请核对到货时间，晚于交付期限的批次不能保障本次发货' : '',
    requests, calculated_at: new Date().toISOString() };
}

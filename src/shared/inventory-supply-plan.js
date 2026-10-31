import {fbpSupplyState,fbpLocalSupplyNeed} from './fbp-supply-state.js';
const known=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const qty=v=>Math.max(0,Math.ceil(Number(v)||0));

// One physical-unit pool. Existing warehouse locks remain protected; submitted
// FBP applications precede optional safety targets. Inbound is spent only once.
export function inventorySupplyPlan(ledger={},applications,forecast){
 const orderReview=(ledger.orders||[]).some(row=>row.needs_fulfillment&&row.quantity_needs_review);
 const flow=ledger.flow_summary||{},ready=!orderReview&&!flow.unavailable&&[ledger.physical_estimate,ledger.open_order_demand,ledger.fbp_reserved,flow.safety].every(known)&&Number(ledger.physical_estimate)>=0;
 const applicationsKnown=Array.isArray(applications)&&flow.applications_pending!==true;
 const fbp=fbpSupplyState(forecast,ledger.fbp_inventory);
 const requested=applicationsKnown?applications.filter(a=>a.status==='pending_review').reduce((sum,a)=>sum+qty(a.requested_quantity),0):null;
 const evidence={order_quantity:known(ledger.open_order_demand)?qty(ledger.open_order_demand):null,locked_quantity:known(ledger.fbp_reserved)?qty(ledger.fbp_reserved):null,submitted_fbp_quantity:requested};
 // The order coverage reader has already allocated stock and inbound once.
 // Historical negative ledger balances must not add debt to this real-order gap
 // or prevent a buyer recording an actual purchase for an uncovered order.
 const fbsEvidence=!orderReview&&known(ledger.current_shortage)&&known(ledger.open_order_demand)&&Number(ledger.current_shortage)>=0&&Number(ledger.current_shortage)<=Number(ledger.open_order_demand);
 const confirmedFbs=fbsEvidence?qty(ledger.current_shortage):null;
 const noFbp=requested===0&&known(ledger.fbp_reserved)&&Number(ledger.fbp_reserved)===0;
 const predicted=fbp.known&&applicationsKnown?Math.max(0,fbpLocalSupplyNeed(applications,fbp)-requested):null;
 const empty={...evidence,known:false,fbs_known:fbsEvidence,required_purchase:confirmedFbs>0?confirmedFbs:noFbp&&confirmedFbs===0?0:null,optional_purchase:null,
  required_fbs:confirmedFbs,required_fbp:noFbp?0:null,optional_local:known(flow.safety)&&Number(flow.safety)===0?0:null,optional_fbp:predicted===0?0:null,
  fbp_forecast_known:fbp.known,fbp_forecast_quantity:predicted,required_fbp_physical_gap:noFbp?0:null,forecast_fbp_physical_gap:null,
  fbs_waiting_incoming:known(ledger.current_incoming)?qty(ledger.current_incoming):null};
 if(!ready)return empty;
 const physical=qty(ledger.physical_estimate),orders=qty(ledger.open_order_demand),locked=qty(ledger.fbp_reserved),incoming=qty(ledger.incoming_quantity);
 const orderGap=Math.max(0,orders-Math.max(0,physical-locked));
 const orderIncoming=Math.min(incoming,orderGap,qty(ledger.current_incoming));
 const requiredFbs=known(ledger.current_shortage)?qty(ledger.current_shortage):Math.max(0,orderGap-orderIncoming);
 if(!applicationsKnown)return{...empty,fbs_known:true,required_fbs:requiredFbs,required_purchase:requiredFbs>0?requiredFbs:null};
 let physicalLeft=Math.max(0,physical-locked-orders),incomingLeft=Math.max(0,incoming-orderIncoming);
 const cover=need=>{const stock=Math.min(physicalLeft,need);physicalLeft-=stock;const transit=Math.min(incomingLeft,need-stock);incomingLeft-=transit;return{purchase:Math.max(0,need-stock-transit),physical_gap:Math.max(0,need-stock),stock,incoming:transit};};
 const requiredFbp=cover(requested+Math.max(0,locked-physical));
 const local=cover(qty(flow.safety));
 const optionalFbp=predicted===null?null:cover(predicted);
 return{...evidence,known:true,fbs_known:true,required_purchase:requiredFbs+requiredFbp.purchase,optional_purchase:local.purchase+(optionalFbp?.purchase||0),required_fbs:requiredFbs,required_fbp:requiredFbp.purchase,
  optional_local:local.purchase,optional_fbp:optionalFbp?.purchase??null,fbp_forecast_known:fbp.known,fbp_forecast_quantity:predicted,required_fbp_physical_gap:requiredFbp.physical_gap,forecast_fbp_physical_gap:optionalFbp?.physical_gap??null,
  fbs_waiting_incoming:orderIncoming,fbp_waiting_incoming:requiredFbp.incoming,fbp_ready_stock:requiredFbp.stock,
  fbs_physical_gap:orderGap,local_ready_stock:local.stock,local_waiting_incoming:local.incoming,
  forecast_ready_stock:optionalFbp?.stock??null,forecast_waiting_incoming:optionalFbp?.incoming??null,
  local_physical_gap:local.physical_gap,fbp_physical_gap:requiredFbp.physical_gap+(optionalFbp?.physical_gap||0),
  submitted_fbp_quantity:requested,unbacked_fbp_locks:Math.max(0,locked-physical)};
}

export function inventoryPurchaseQuantity(plan={}){
 if(plan.known)return Number(plan.required_purchase||0)+Number(plan.optional_purchase||0);
 return plan.fbs_known&&plan.required_fbs>0?Number(plan.required_fbs):null;
}
export const inventoryPurchaseReady=plan=>inventoryPurchaseQuantity(plan)>0;

import {fbpSupplyState,fbpLocalSupplyNeed} from './fbp-supply-state.js';
const known=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const qty=v=>Math.max(0,Math.ceil(Number(v)||0));

// One physical-unit pool. Existing warehouse locks remain protected; submitted
// FBP applications precede optional safety targets. Inbound is spent only once.
export function inventorySupplyPlan(ledger={},applications,forecast){
 const flow=ledger.flow_summary||{},ready=!flow.unavailable&&[ledger.physical_estimate,ledger.open_order_demand,ledger.fbp_reserved,flow.safety].every(known)&&Number(ledger.physical_estimate)>=0;
 const applicationsKnown=Array.isArray(applications)&&flow.applications_pending!==true;
 const fbp=fbpSupplyState(forecast,ledger.fbp_inventory);
 const requested=applicationsKnown?applications.filter(a=>a.status==='pending_review').reduce((sum,a)=>sum+qty(a.requested_quantity),0):null;
 const evidence={order_quantity:known(ledger.open_order_demand)?qty(ledger.open_order_demand):null,locked_quantity:known(ledger.fbp_reserved)?qty(ledger.fbp_reserved):null,submitted_fbp_quantity:requested};
 const empty={...evidence,known:false,required_purchase:null,optional_purchase:null,required_fbs:null,required_fbp:null,optional_local:null,optional_fbp:null,fbp_forecast_known:fbp.known,fbp_forecast_quantity:null,required_fbp_physical_gap:null,forecast_fbp_physical_gap:null};
 if(!ready)return empty;
 const physical=qty(ledger.physical_estimate),orders=qty(ledger.open_order_demand),locked=qty(ledger.fbp_reserved),incoming=qty(ledger.incoming_quantity);
 const orderGap=Math.max(0,orders-Math.max(0,physical-locked));
 const orderIncoming=Math.min(incoming,orderGap,qty(ledger.current_incoming));
 const requiredFbs=known(ledger.current_shortage)?qty(ledger.current_shortage):Math.max(0,orderGap-orderIncoming);
 if(!applicationsKnown)return{...empty,required_fbs:requiredFbs};
 let physicalLeft=Math.max(0,physical-locked-orders),incomingLeft=Math.max(0,incoming-orderIncoming);
 const cover=need=>{const stock=Math.min(physicalLeft,need);physicalLeft-=stock;const transit=Math.min(incomingLeft,need-stock);incomingLeft-=transit;return{purchase:Math.max(0,need-stock-transit),physical_gap:Math.max(0,need-stock),stock,incoming:transit};};
 const requiredFbp=cover(requested+Math.max(0,locked-physical));
 const local=cover(qty(flow.safety));
 const predicted=fbp.known?Math.max(0,fbpLocalSupplyNeed(applications,fbp)-requested):null;
 const optionalFbp=predicted===null?null:cover(predicted);
 return{...evidence,known:true,required_purchase:requiredFbs+requiredFbp.purchase,optional_purchase:local.purchase+(optionalFbp?.purchase||0),required_fbs:requiredFbs,required_fbp:requiredFbp.purchase,
  optional_local:local.purchase,optional_fbp:optionalFbp?.purchase??null,fbp_forecast_known:fbp.known,fbp_forecast_quantity:predicted,required_fbp_physical_gap:requiredFbp.physical_gap,forecast_fbp_physical_gap:optionalFbp?.physical_gap??null,
  fbs_waiting_incoming:orderIncoming,fbp_waiting_incoming:requiredFbp.incoming,fbp_ready_stock:requiredFbp.stock,
  local_physical_gap:local.physical_gap,fbp_physical_gap:requiredFbp.physical_gap+(optionalFbp?.physical_gap||0),
  submitted_fbp_quantity:requested,unbacked_fbp_locks:Math.max(0,locked-physical)};
}

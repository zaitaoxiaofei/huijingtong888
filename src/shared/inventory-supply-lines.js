import {inventoryProcurementStatus} from './inventory-procurement-status.js';
// Presentation of the canonical supply plan; never allocate stock a second time.
export function inventorySupplyLines(workflow={}){
 const p=workflow.supply_plan||{},fbp=workflow.fbp||{},demands=workflow.demands||[];
 const lines=[
  {key:'orders',label:'FBS订单',target:p.order_quantity,partial:!p.known&&p.fbs_known,quantity:!p.known&&p.fbs_known?p.required_fbs:p.fbs_physical_gap??demands[0]?.physical_gap,purchase:p.required_fbs,incoming:p.fbs_waiting_incoming,stock:p.known&&p.order_quantity!=null&&p.fbs_physical_gap!=null?Math.max(0,p.order_quantity-p.fbs_physical_gap):null,required:true},
  {key:'safety',label:'本地保障',target:workflow.safety_target,quantity:p.local_physical_gap,purchase:p.optional_local,incoming:p.local_waiting_incoming,stock:p.local_ready_stock},
  {key:'fbp',label:'FBP正式申请',pending:p.submitted_fbp_quantity,inTransit:p.fbp_in_transit_quantity??fbp.in_transit,locked:p.approved_fbp_quantity??p.locked_quantity,quantity:p.formal_fbp_quantity??(p.submitted_fbp_quantity!=null&&p.locked_quantity!=null?p.submitted_fbp_quantity+p.locked_quantity:null),purchase:p.required_fbp,stock:p.fbp_ready_stock,incoming:p.fbp_waiting_incoming,unbacked:p.unbacked_fbp_locks,required:true},
  {key:'forecast',label:'FBP预测缺口',quantity:fbp.known?fbp.shortage:null,purchase:p.optional_fbp,stock:p.forecast_ready_stock,incoming:p.forecast_waiting_incoming,
   replenishment:fbp.known?fbp.replenish_quantity:null,unsubmitted:p.fbp_forecast_quantity??demands[3]?.replenishment_quantity}
 ];
 return lines.map(line=>({...line,status:inventoryProcurementStatus(workflow,line.key)}));
}

// Explicit facts for operators. Keep targets, coverage and purchasing gaps
// separate; unknown allocation must never become an invented zero.
export function inventorySupplyLineFacts(line){
 const fact=(label,value,kind='coverage')=>({label,value:value??null,kind});
 const coverage=[fact('现货覆盖',line.stock),fact('在途覆盖',line.incoming),fact(line.required?'仍需采购':line.key==='safety'?'可选补货':'可选采购',line.purchase,'purchase')];
 if(line.key==='orders')return[fact('订单需求',line.target,'target'),...coverage];
 if(line.key==='safety')return[fact('保障目标',line.target,'target'),...coverage];
 if(line.key==='fbp')return[fact('申请数量',line.quantity,'target'),fact('发仓在途',line.inTransit),...(line.pending>0?[fact('待审核',line.pending)]:[]),...(line.locked>0?[fact('已审批待发',line.locked,'locked')]:[]),...coverage];
 return[fact('官方仓缺口',line.quantity,'target'),fact('未申请建议',line.unsubmitted),...coverage];
}

import {inventoryProcurementStatus} from './inventory-procurement-status.js';
// Presentation of the canonical supply plan; never allocate stock a second time.
export function inventorySupplyLines(workflow={}){
 const p=workflow.supply_plan||{},fbp=workflow.fbp||{},demands=workflow.demands||[];
 const lines=[
  {key:'orders',label:'FBS订单',target:p.order_quantity,partial:!p.known&&p.fbs_known,quantity:!p.known&&p.fbs_known?p.required_fbs:p.fbs_physical_gap??demands[0]?.physical_gap,purchase:p.required_fbs,incoming:p.fbs_waiting_incoming,required:true},
  {key:'safety',label:'本地保障',target:workflow.safety_target,quantity:p.local_physical_gap,purchase:p.optional_local,incoming:p.local_waiting_incoming},
  {key:'fbp',label:'FBP正式申请',quantity:p.submitted_fbp_quantity==null?null:p.submitted_fbp_quantity+(p.unbacked_fbp_locks||0),purchase:p.required_fbp,stock:p.fbp_ready_stock,incoming:p.fbp_waiting_incoming,unbacked:p.unbacked_fbp_locks,required:true},
  {key:'forecast',label:'FBP预测缺口',quantity:fbp.known?fbp.shortage:null,purchase:p.optional_fbp,stock:p.forecast_ready_stock,incoming:p.forecast_waiting_incoming,
   replenishment:fbp.known?fbp.replenish_quantity:null,unsubmitted:p.fbp_forecast_quantity??demands[3]?.replenishment_quantity}
 ];
 return lines.map(line=>({...line,status:inventoryProcurementStatus(workflow,line.key)}));
}

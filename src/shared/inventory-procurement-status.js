// Procurement coverage colours, independent of physical dispatch readiness.
export function inventoryProcurementStatus(workflow={},key){
 key=({real_order:'orders',local_safety:'safety',fbp_stock:'fbp',fbp_forecast:'forecast'})[key]||key;
 const p=workflow.supply_plan||{},fbp=workflow.fbp||{};
 const status=(value,required)=>value==null?'info':value>0?(required?'danger':'warning'):'success';
 if(key==='orders')return status(p.required_fbs,true);
 if(key==='safety')return status(p.optional_local??(workflow.safety_target===0?0:null),false);
 if(key==='fbp'){
  if(p.submitted_fbp_quantity===0&&!(p.unbacked_fbp_locks>0))return'info';
  return status(p.required_fbp,true);
 }
 if(key==='forecast'){
  if(!fbp.known)return'info';
  if(fbp.replenish_quantity===0||p.fbp_forecast_quantity===0)return'success';
  return p.optional_fbp==null?'warning':status(p.optional_fbp,false);
 }
 return'info';
}

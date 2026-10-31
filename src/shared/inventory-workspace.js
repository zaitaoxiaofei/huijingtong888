export function inventoryWorkspacePage(all,params={}){
 const plan=r=>r.workflow?.supply_plan||{},number=v=>Number(v)||0;
 const inScope=all.filter(r=>(params.scope!=='orders'||number(plan(r).order_quantity??r.workflow?.order_demand)>0)&&(!params.product_id||Number(r.product_id)===Number(params.product_id)));
 const matches=(r,key)=>key==='required'?(number(plan(r).required_purchase)>0||(!plan(r).known&&((!plan(r).fbs_known&&number(plan(r).order_quantity??r.workflow?.order_demand)>0)||(plan(r).required_fbp==null&&[plan(r).submitted_fbp_quantity??r.workflow?.requested,plan(r).locked_quantity??r.workflow?.locked].some(v=>number(v)>0))))):key==='advisory'?plan(r).known&&number(plan(r).required_purchase)===0&&(number(plan(r).optional_purchase)>0||number(plan(r).fbp_forecast_quantity)>0):key==='incoming'?number(r.workflow?.incoming)>0:key==='review'?(!plan(r).known||plan(r).fbp_forecast_known===false):true;
 const meta=Object.fromEntries(['all','required','advisory','incoming','review'].map(key=>[key,inScope.filter(r=>matches(r,key)).length]));
 const rank=r=>number(plan(r).required_fbs)>0||(!plan(r).known&&number(plan(r).order_quantity??r.workflow?.order_demand)>0)?0:number(plan(r).required_fbp)>0||(!plan(r).known&&number(plan(r).submitted_fbp_quantity??r.workflow?.requested)>0)?1:!plan(r).known?2:number(r.workflow?.incoming)>0?3:number(plan(r).optional_purchase)>0?4:5;
 const rows=inScope.filter(r=>matches(r,params.task)).sort((a,b)=>rank(a)-rank(b)||number(plan(b).order_quantity??b.workflow?.order_demand)-number(plan(a).order_quantity??a.workflow?.order_demand)||Number(a.product_id)-Number(b.product_id));
 const page=Math.max(1,Math.trunc(Number(params.page)||1)),pageSize=Math.min(100,Math.max(1,Math.trunc(Number(params.pageSize)||20)));
 return{rows:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,meta};
}

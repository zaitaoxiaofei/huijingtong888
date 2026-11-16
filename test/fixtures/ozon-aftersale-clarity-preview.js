import {startPagedWorkspacePreview} from './paged-workspace-preview.js';
import {summarizeOzonReturns} from '../../src/shared/ozon-return-state.js';
export async function startOzonAftersaleClarityPreview({host='127.0.0.1'}={}){
 const examples=[['Utilized','雨眉 TENET T7 银色款','cancelled'],['Utilized','扶手箱 TENET T4 普通款','cancelled'],['Utilizing','门槛条 TENET 普通款','cancelled'],['OnWay','门槛条贴纸套装','cancelled'],['CheckingStatus','钥匙壳售后核查示例','delivered'],['OnSellerClarification','汽车头枕与腰靠示例','delivered'],['MoneyReturned','钥匙壳已退款示例','delivered'],['FutureOfficialState','未识别状态演示','delivered']];
 const orders=examples.map(([state,name,status],n)=>({id:n+1,posting_number:`演示订单-${n+1}`,shop_id:1,shop_name:'演示店铺',status,ordered_at:'2026-10-13T09:00:00Z',revenue:80,item_count:1,estimated_profit:20,product_names:name,product_ids:String(n+1),skus:`SKU-${n+1}`,sku_quantities:`SKU-${n+1}:1`,sku_names:`SKU-${n+1}:${name}`,sku_product_ids:`SKU-${n+1}:${n+1}`,sku_inventory_numbers:`SKU-${n+1}:1-${n+1}`,sku_inventory_names:`SKU-${n+1}:${name}`,sku_stock_summaries:`SKU-${n+1}:0:0:5`,fulfillment_type_key:'fbs',fulfillment_type_label:'FBS',logistics_carrier_label:'OGL',aftersale:summarizeOzonReturns([{return_id:`演示申请-${n+1}`,source_endpoint:'/v2/returns/rfbs/list',state:{state,state_name:state==='Utilized'?'Утилизирован':state},product:{sku:`SKU-${n+1}`,name},created_at:'2026-11-13T08:00:00Z',observed_at:'2026-11-16T05:00:00Z'}])}));
 const calls=[];
 const server=await startPagedWorkspacePreview({host,stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders'){
   const status=url.searchParams.get('status')||'all',stage=url.searchParams.get('aftersaleStatus')||'all';
   const rows=orders.filter(row=>['all','aftersale'].includes(status)&&(stage==='all'||row.aftersale.observations.some(r=>stage==='seller_action'?r.action_owner==='seller':r.group===stage)));
   calls.push({status,stage});send({rows,total:rows.length,page:1,pageSize:20,counts:{all:orders.length,aftersale:orders.length}});return true;
  }
  if(url.pathname==='/api/orders/inventory-availability'){send({rows:[]});return true;}
  if(url.pathname==='/api/shops'){send([{id:1,name:'演示店铺'}]);return true;}
  if(/^\/api\/orders\/\d+$/.test(url.pathname)){send({order:orders.find(row=>row.id===Number(url.pathname.split('/').at(-1))),items:[],finance:[]});return true;}
  return false;
 }});return {server,calls,orders};
}

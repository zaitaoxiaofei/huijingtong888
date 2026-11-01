import {startPagedWorkspacePreview} from './paged-workspace-preview.js';
export async function startOrderPageInteractionsPreview(){
 const calls=[];
 const orders=Array.from({length:40},(_,i)=>({id:i+1,posting_number:'PAGE-ORDER-'+(i+1),shop_id:1,shop_name:'验证店铺',status:'awaiting_packaging',ordered_at:'2026-11-01T01:00:00Z',revenue:50,item_count:1,product_names:'验证订单商品',skus:'SKU-'+i,sku_quantities:'SKU-'+i+':1',fulfillment_type_key:'fbs',fulfillment_type_label:'FBS',logistics_carrier_label:'OGL'}));
 orders[21]={...orders[21],fulfillment_type_key:'fbp',fulfillment_type_label:'FBP',warehouse_name:'CEL FBP'};
 orders[22]={...orders[22],item_count:2};
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders'){const page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('pageSize')||20);send({rows:orders.slice((page-1)*size,page*size),total:40,page,pageSize:size,counts:{all:40,awaiting_packaging:40}});return true;}
  if(url.pathname==='/api/orders/ship'){
   let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const data=JSON.parse(body||'{}');calls.push(data);send({ok:true,updated_orders:[]});});return true;
  }
  return false;
 }});return{server,calls};
}

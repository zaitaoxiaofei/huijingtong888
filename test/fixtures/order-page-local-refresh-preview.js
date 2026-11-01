import {startPagedWorkspacePreview} from './paged-workspace-preview.js';
export async function startOrderLocalRefreshPreview({inlineInventory=false}={}){
 const calls=[];let stock=5;
 const base=(id,product)=>({id,posting_number:'REFRESH-'+id,shop_id:1,shop_name:'验证店铺',status:'awaiting_deliver',ordered_at:'2026-11-01T01:00:00Z',revenue:50,item_count:1,estimated_profit:7,product_names:'库存 '+product,product_ids:String(product),skus:'SKU-'+id,sku_quantities:`SKU-${id}:1`,sku_names:`SKU-${id}:验证商品`,sku_images:`SKU-${id}:/api/products/${id}/image`,sku_product_ids:`SKU-${id}:${product}`,sku_inventory_numbers:`SKU-${id}:1-${product}`,sku_inventory_names:`SKU-${id}:库存 ${product}`,sku_stock_summaries:`SKU-${id}:0:0:5`,fulfillment_type_key:'fbs',fulfillment_type_label:'FBS',logistics_carrier_label:'OGL'});
 const orders=[base(1,80),base(2,8),base(3,9)];
 orders[0].inventory_picking_items=[{sku:'SKU-1',parent_product_id:80,product_id:8,product_name:'共享配件',inventory_number:'1-8',per_set_quantity:2,required_quantity:2,stock_unit:'件'}];
 const facts=id=>({product_id:id===3?9:8,physical_stock:id===3?9:stock,available_stock:id===3?8:stock-2});
 const ledger=()=>({product:{id:8,name:'共享配件',inventory_number:'1-8',stock_unit:'件'},revision:'test-revision',local_stock:stock,physical_estimate:stock,available_estimate:stock-2,open_order_demand:2,fbp_reserved:0,fulfillment_summary:{fbs:{order_count:2}},orders:[],batches:[]});
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  const ledgerPath=url.pathname.replace('/api/inventory/ledger','/api/procurement/ledger');
  calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:req.method});
  if(url.pathname==='/api/orders')return send({rows:inlineInventory&&url.searchParams.get('includeInventoryAvailability')==='1'?orders.map(row=>({...row,inventory_availability:[facts(row.id)]})):orders,total:3,page:1,pageSize:20,counts:{all:3,awaiting_deliver:3}}),true;
  if(url.pathname==='/api/orders/inventory-availability'){
   if(url.searchParams.get('includeRows')==='1')return send({rows:orders.slice(0,2).map(row=>({order_id:row.id,order:{...row,inventory_availability:[facts(row.id)],procurement_coverage:null}}))}),true;
   return send({rows:orders.map(row=>({order_id:row.id,inventory_availability:[facts(row.id)]}))}),true;
  }
  if(/^\/api\/orders\/\d+$/.test(url.pathname))return send({order:orders[0],items:[],finance:[]}),true;
  if(ledgerPath==='/api/procurement/ledger'&&req.method==='GET')return send(ledger()),true;
  if(ledgerPath==='/api/procurement/ledger/preview')return send({physical_before:5,physical_after:20,available_before:3,available_after:18,open_order_demand:2,fbp_reserved:0,stocktake_delta:15,reason:'历史库存记错'}),true;
  if(ledgerPath==='/api/procurement/ledger'&&req.method==='POST'){stock=20;return send({ok:true}),true;}
  if(url.pathname==='/api/inventory-workflow/feedback')return send({ok:true}),true;
  return false;
 }});return{server,calls};
}

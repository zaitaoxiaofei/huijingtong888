import {inventoryWorkflow} from '../../src/shared/inventory-workflow.js';
export const demoUser={id:1,personId:1,name:'演示仓库',roles:['packing','operations','procurement'],tenant:{id:2,slug:'demo',role:'owner'}};
const defs=[{id:101,name:'门槛条 JETOUR X70 Plus 不锈钢 4个',number:'2-203',physical:6,orders:10,safety:5,incoming:0,shortage:4,application:20,target:30,fbp:6},
{id:102,name:'雨刮垫 通用 黑色 普通款 1个',number:'8-1',physical:40,orders:4,safety:12,incoming:18,shortage:0,application:4,target:30,fbp:0},
{id:103,name:'钥匙套 JELAND J6 黑色 硅胶 1个',number:'1-153',physical:12,orders:0,safety:8,incoming:0,shortage:0,application:0,target:10,fbp:2}];
export const demoLedgers=new Map(),demoForecasts=new Map();
export const demoRows=defs.map(d=>{
 const sku=`SKU-${d.id}`,official={incomplete:false,present:d.fbp,available:d.fbp,reserved:0,synced_at:'2026-10-30 02:00:00',rows:[{shop_id:20,shop_name:'演示店铺 M',ozon_sku:sku,per_set_quantity:1,present:d.fbp,available:d.fbp,reserved:0,mapping_id:d.id,root_product_id:d.id}]};
 const forecast={stock_incomplete:false,skus:[{...official.rows[0],fbp_target:d.target,in_transit:0,committed_qty:0,suggested_qty:d.target-d.fbp,category:'潜力品'}, {...official.rows[0],shop_id:21,shop_name:'演示店铺 Z',ozon_sku:sku+'-2',mapping_id:d.id+100,per_set_quantity:2,available:0,fbp_target:0,in_transit:0,committed_qty:0,suggested_qty:10,category:'常规品'}]};
 official.rows.push({...forecast.skus[1],present:0,reserved:0});
 const applications=d.application?[{order_id:d.id,order_no:`FBP-DEMO-${d.id}`,item_id:d.id,shop_id:20,shop_name:'演示店铺 M',ozon_sku:sku,status:'pending_review',requested_quantity:d.application,per_set_quantity:1,locked_quantity:0,applicant_name:'演示运营小李',submitted_at:'2026-10-30 01:00:00'}]:[];
 const ledger={product:{id:d.id,name:d.name,inventory_number:d.number},revision:'demo-'+d.id,physical_estimate:d.physical,local_stock:d.physical,open_order_demand:d.orders,fbp_reserved:0,available_estimate:Math.max(0,d.physical-d.orders),incoming_quantity:d.incoming,current_incoming:0,current_shortage:d.shortage,last_stocktake_at:'2026-10-29 03:00:00',fbp_inventory:official,orders:[],batches:[],purchases:[],actions:[],movements:[],flow_summary:{safety:d.safety,free:Math.max(0,d.physical-d.orders-d.safety),local_days:9,fbp_days:16,applications,orders:[]}};
 demoLedgers.set(d.id,ledger);demoForecasts.set(d.id,forecast);
 const workflow={...inventoryWorkflow(ledger,{applications,forecast}),applications,requests:[{id:d.id,quantity:d.safety,status:'submitted',request_reason_code:'flow_local_safety',applicant_name:'演示仓库小王',created_at:'2026-10-29 02:00:00'}]};
 return{product_id:d.id,product_name:d.name,inventory_number:d.number,workflow,pending_batches:d.incoming?[{id:301,product_id:d.id,order_no:'PO-DEMO-102',quantity:18,purchased_at:'2026-10-26 02:00:00'}]:[],feedbacks:[]};
});
export const demoOpportunities=demoRows.map(r=>({product_id:r.product_id,inventory_id:r.inventory_number,product_name:r.product_name,shop_id:20,shop_name:'演示店铺 M',ozon_sku:`SKU-${r.product_id}`,mapping_id:r.product_id,offer_id:'DEMO-'+r.product_id,image_url:`/api/products/${r.product_id}/image`,recent_30d_qty:36,recent_7d_qty:12,dynamic_daily_sales:1.2,suggested_qty:20,local_available:r.workflow.free,fbp_available:r.workflow.fbp.available,reason:'近三周销量增长，建议关注FBP补货周期',priority:'high',priority_text:'潜力商品',score:82,suggested_action:'purchase',suggested_action_text:'建议备货'}));

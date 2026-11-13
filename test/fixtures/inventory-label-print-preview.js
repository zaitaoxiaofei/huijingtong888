import { startPagedWorkspacePreview } from './paged-workspace-preview.js';
import { demoLedgers, demoUser } from './inventory-role-workspace.js';
export const labelProducts = [
 { id:267,inventory_number:'2-6-7',name:'门槛条 VOLGA K40 红色 LOGO定制款 ABS塑料 激光 4个',total_sales_quantity:3,total_sales_amount:159,total_purchase_quantity:10,total_purchase_amount:410,manual_outbound_quantity:2,avg_unit_cost:41,component_count:0,stock_unit:'个',owner_name:'核动力牛马',bound_sku_count:1 },
 { id:268,inventory_number:'2-20-8',name:'门槛条 HYUNDAI Tucson 银色/黑色 4+4 不锈钢/皮革 激光 1个 套装',avg_unit_cost:40,component_count:2,stock_unit:'套',bound_sku_count:1 },
 { id:269,inventory_number:'10-1-2',name:'钥匙手绳 通用 紫色 普通款 皮革 1个',avg_unit_cost:4.5,is_accessory:1,component_count:0,stock_unit:'个',bound_sku_count:0 },
 { id:270,inventory_number:'99-1-1',name:'包装耗材 气泡袋 1个',avg_unit_cost:0.5,is_consumable:1,component_count:0,stock_unit:'个',bound_sku_count:0 }
];
export async function startLabelPrintPreview() {
const rows = labelProducts;
const calls = [];
const server = await startPagedWorkspacePreview({ stableDeps:true, host: '::1', user:{...demoUser,tenant:{...demoUser.tenant,id:1,slug:'default'}}, apiHandler(req,res,url,send){
 calls.push({ method:req.method,path:url.pathname });
 if(url.pathname==='/api/products'){send({rows,total:rows.length});return true;}
 if(url.pathname==='/api/inventory-workflow'&&url.searchParams.get('view')==='local'){send({rows:rows.map((row,i)=>({product_id:row.id,physical_stock:20,workflow_free:15,fbp_stock_known:i===1?null:0}))});return true;}
 if(url.pathname==='/api/people'){send([{id:1,name:'负责人',active:1}]);return true;}
 if(url.pathname==='/api/inventory/ledger'||url.pathname==='/api/procurement/ledger'){
   send({...demoLedgers.get(101),product:rows[0]});return true;
 }
 if(url.pathname==='/api/products/267/edit-history'){
   send({current:rows[0],rows:[],total:0,number_aliases:[],name_aliases:[],page:1});return true;
 }
 if(url.pathname==='/api/products/267'){
   send({...rows[0],core_product_name:'门槛条',product_type:'main',selection_status:'listed',composition_items:[]});return true;
 }
 return false;
}});
return { server, calls };
}

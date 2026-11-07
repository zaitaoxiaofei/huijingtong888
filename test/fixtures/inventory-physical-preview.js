import {startPagedWorkspacePreview} from './paged-workspace-preview.js';
import {demoRows,demoLedgers} from './inventory-role-workspace.js';
import {inventoryWorkflow} from '../../src/shared/inventory-workflow.js';
export async function startPhysicalPurchasePreview(){
const ledger={...demoLedgers.get(101),physical_estimate:-3,local_stock:-15,open_order_deducted:12,open_order_demand:12,current_shortage:12,stocktake_evidence:{created_at:'2026-10-30 10:36:01',result_json:{physical_after:0}}};
const state={...inventoryWorkflow(ledger,{forecast:{stock_incomplete:true,skus:[{shop_id:20,ozon_sku:'ONE',per_set_quantity:1,available:null,fbp_target:20}]}}),product_id:101,calculated_at:new Date().toISOString(),affected_bundles:[{id:200,name:'门槛条配件套装',inventory_number:'2-200',per_set_quantity:2,has_open_demand:true}]};
const rows=[{...demoRows[0],workflow:state},demoRows[2]];
const parts=[{id:101,product_id:101,name:'门槛条实物配件 A',inventory_number:'2-101',stock_unit:'件',per_set_quantity:2,quantity:20,suggested_amount:60,suggested_shipping_amount:6},{id:103,product_id:103,name:'钥匙套实物配件 B',inventory_number:'2-103',stock_unit:'件',per_set_quantity:1,quantity:10,suggested_amount:40,suggested_shipping_amount:4}];
let reviewed=false,syncs=0;const calls=[];
const source={id:500,product_id:200,product_name:'原套装',quantity:10,status:'pending_arrival',purchased_at:'2026-10-29 08:00:00',updated_at:'2026-10-30 08:00:00',buyer_name:'采购张三',components:parts,is_bundle:true,review_required:true,physical_quantity:null,affected_bundles:[{id:200,name:'原套装',inventory_number:'2-200'}]};
const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
 if(url.pathname==='/api/procurement/ledger'){send(demoLedgers.get(101));return true;}
 if(req.method==='POST'){
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);calls.push({path:url.pathname,body});
   if(url.pathname==='/api/inventory-flow/sync'){syncs++;send({task_id:'sync-'+syncs,running:false,result:syncs===1?{ok:false,results:[{ok:false,shop_name:'M店',message:'测试网络失败'}]}:{ok:true}});}
   else if(url.pathname==='/api/inventory-workflow/purchase-bundle'){reviewed=true;send({ok:true,created:body.items,physical_changed:false});}else send({ok:true});});return true;
 }
 if(url.pathname==='/api/inventory-workflow/purchase-bundle'){send({batch:{...source,amount:100,shipping_amount:10},product:{id:200,name:'原套装'},components:parts,revision:'test-revision'});return true;}
 if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){send({rows:url.searchParams.get('summary_only')?[]:reviewed?[{...source,id:501,product_id:101,product_name:parts[0].name,is_bundle:false,review_required:false,quantity:7,physical_quantity:7,components:[{...parts[0],quantity:7}],source_bundle_batch:{id:500,product_id:200}}]:[source],total:1,summary:{open:1,arrived:0,open_quantity:reviewed?7:0,open_unknown_batches:reviewed?0:1}});return true;}
 if(url.pathname==='/api/inventory-workflow'&&url.searchParams.get('view')==='status'){send({rows:rows.map(r=>({...r.workflow,product_id:r.product_id}))});return true;}
 if(url.pathname==='/api/inventory-workflow'&&url.searchParams.get('view')==='components'){send({rows:[{product_id:200,product:{id:200},is_bundle:true,components:parts,affected_bundles:[]}]});return true;}
 if(url.pathname==='/api/inventory-workflow/alerts'){send({rows,total:2,meta:{required:1,advisory:1},snapshot:{available:true,calculated_at:'2026-10-31T01:00:00Z'}});return true;}
 if(url.pathname==='/api/people'){send([{id:1,name:'采购张三',active:1}]);return true;}
 if(url.pathname==='/api/products'){send({rows:[{id:200,name:'测试套装',inventory_number:'2-200'}],total:1});return true;}
 return false;
}});
return {server,calls};
}

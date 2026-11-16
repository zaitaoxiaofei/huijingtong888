import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import {demoUser,demoLedgers,demoRows} from './inventory-role-workspace.js';
import {inventoryCapitalReviewMatches} from '../../src/shared/inventory-capital-review.js';
import {localCapitalTotals} from '../../src/services/inventory-capital-local.js';
export async function startCapitalReviewPreview(){
 const rows=Array.from({length:25},(_,i)=>({row_id:101+i,product_id:101+i,product_name:i===0?'零成本雨刮垫（演示）':i===1?'账面负库存钥匙壳（演示）':`历史流水门槛条（演示${i+1}）`,inventory_number:`DEMO-${i+1}`,code:`SKU-${i+1}`,physical_quantity:i===1?-2:10,quantity:i===1?null:8,unit_cost:i===0?0:5,inventory_value:i===1?null:i===0?0:40,cost_missing:i===0,unclassified_movements:i>1?3:0,availability_unknown:i===1,order_quantity:1,locked_quantity:0,safety_quantity:1,cost_basis:'product_cost',updated_at:'2026-11-16T07:00:00Z'}));
 const fbpRows=[{row_id:901,product_id:null,shop_id:20,shop_name:'演示店铺',online_product_id:700,ozon_sku:'DEMO-FBP-SKU',quantity:7,unit_cost:0,inventory_value:0,cost_missing:true,unclassified_movements:0}];
 const summary={categories:{local:localCapitalTotals(rows),fbp:{quantity:7,value:0,item_count:1,missing_cost_count:1,unmapped_count:1},transit:{quantity:0,value:0,item_count:0}},inventory_total_value:null};
 const entry=`import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import View from '/frontend/admin/views/finance/InventoryCapitalView.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const app=createApp({render:()=>h('div',[h('p','仅演示数据 · 库存核实筛选预览'),h(RouterView)])});app.use(createPinia());useAuthStore().user=${JSON.stringify(demoUser)};setAuthToken('capital-preview');const router=createRouter({history:createWebHashHistory(),routes:[{path:'/finance/inventory-capital',component:View}]});app.use(router).use(ElementPlus);window.layoutErrors=[];app.config.errorHandler=e=>window.layoutErrors.push(e.message);await router.isReady();app.mount('#app');`;
 const server=await createServer({configFile:false,root:process.cwd(),publicDir:false,cacheDir:'/private/tmp/capital-review-vite-cache',logLevel:'error',server:{host:'::1',port:8788,strictPort:true},plugins:[vue(),{name:'capital-review-fixture',resolveId:id=>id==='/preview.js'?id:null,load:id=>id==='/preview.js'?entry:null,configureServer(server){server.middlewares.use((req,res,next)=>{
 const url=new URL(req.url,'http://localhost'),send=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
 if(url.pathname==='/admin.html'){res.setHeader('content-type','text/html');res.end('<html><meta charset="utf-8"><style>#app{height:calc(100vh - 48px);overflow:auto}</style><body style="padding:24px;background:#f5f7fa"><div id="app"></div><script type="module" src="/preview.js"></script></body></html>');return;}
 if(!url.pathname.startsWith('/api/'))return next();
 if(req.method!=='GET'){res.statusCode=405;return send({error:'预览不写业务数据'});}
 if(url.pathname==='/api/products'){return send({rows:[{id:103,name:'已有库存商品（演示）',inventory_number:'DEMO-3'}]});}
 if(/^\/api\/products\/\d+$/.test(url.pathname)){return send({id:Number(url.pathname.split('/').at(-1)),name:'库存资料编辑（演示）',code:'DEMO',package_weight_g:100,length_cm:10,width_cm:10,height_cm:2,purchase_cost:5,images:[],structured_naming:{core_name:'钥匙壳',vehicle_brand:'TENET',vehicle_model:'T7'}});}
 if(['/api/people','/api/logistics-rules'].includes(url.pathname))return send([]);
 if(url.pathname==='/api/suppliers')return send({rows:[]});
 if(url.pathname.endsWith('/image')){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#ced7e5"/></svg>');return;}
 if(url.pathname==='/api/finance-center/inventory-capital-details'){
 const kind=url.searchParams.get('kind')||'local',review=url.searchParams.get('review')||'all',query=url.searchParams.get('query')||'',page=Number(url.searchParams.get('page')||1);
 const filtered=(kind==='local'?rows:kind==='fbp'?fbpRows:[]).filter(r=>inventoryCapitalReviewMatches(r,review)&&(!query||[r.product_name,r.inventory_number].join(' ').includes(query))),totals=localCapitalTotals(filtered);
 return send({kind,rows:filtered.slice((page-1)*20,page*20),total:filtered.length,filtered_quantity:totals.quantity,filtered_value:totals.value,summary,snapshot_at:'2026-11-16T07:00:00Z'});}
 if(url.pathname==='/api/procurement/ledger'||url.pathname==='/api/inventory/ledger'){const id=Number(url.searchParams.get('product_id'));const ledger=structuredClone(demoLedgers.get(103));ledger.orders=[{order_item_id:1,order_id:1,posting_number:'演示-历史订单100件',entered_transport:1,needs_fulfillment:0,quantity:100,missing_record_quantity:80,missing_purchase_quantity:80,missing_receipt_quantity:0,missing_amount:false,coverage_trace:[]}];ledger.historical_missing=80;ledger.missing_purchase=80;ledger.shipped_quantity=100;ledger.purchase_quantity=20;ledger.applications=[];ledger.requested=0;ledger.transfers=[];ledger.product.id=id;ledger.product.name=rows.find(r=>r.product_id===id)?.product_name;return send(ledger);}
 if(url.pathname==='/api/inventory-workflow/details'&&url.searchParams.get('node')==='composition')return send({rows:[],product:{component_count:0}});
 if(url.pathname.startsWith('/api/inventory-workflow/'))return send({workflow:demoRows[2].workflow});
 return send({rows:[],total:0});
 });}}]});await server.listen();return server;
}

import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real mobile components with synthetic API data. Never connects to production.
export async function startMobileDialogPreview(){
 const calls=[],user={id:1,personId:1,name:'手机测试员',username:'mobile-fixture',roles:['admin'],tenant:{id:2,name:'手机测试企业',role:'owner'}};
 const products=Array.from({length:50},(_,i)=>({id:i+1,name:`库存商品 ${i+1} · 长名称 TENET T4L 黑色 普通款 配件测试`,inventory_number:`1-${i+1}`,component_count:i===2?2:0,is_accessory:i%2,stock_unit:'件'}));
 const entry=`import {createApp} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import Layout from '/frontend/admin/layouts/MobileLayout.vue';import Account from '/frontend/admin/views/mobile/MobileAccountView.vue';import Detail from '/frontend/admin/views/mobile/MobileOrderDetailView.vue';import Procurement from '/frontend/admin/views/mobile/MobileProcurementView.vue';import Inventory from '/frontend/admin/views/mobile/MobileInventoryView.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const app=createApp(Layout),pinia=createPinia();app.use(pinia);const auth=useAuthStore();auth.user=${JSON.stringify(user)};setAuthToken('mobile-ui-fixture');const router=createRouter({history:createWebHashHistory(),routes:[{path:'/mobile',redirect:'/mobile/account'},{path:'/mobile/account',component:Account,meta:{title:'我的账号'}},{path:'/mobile/orders/:id',component:Detail,meta:{title:'订单详情'}},{path:'/mobile/procurement',component:Procurement,meta:{title:'采购'}},{path:'/mobile/inventory',component:Inventory,meta:{title:'库存'}}]});app.use(router).use(ElementPlus);window.mobileUiErrors=[];app.config.errorHandler=e=>window.mobileUiErrors.push(e.message);await router.isReady();app.mount('#adminApp');`;
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'erp-mobile-dialog-ui-'));
 const server=await createServer({configFile:false,root:process.cwd(),publicDir:false,cacheDir,logLevel:'error',server:{host:'127.0.0.1',port:8788,strictPort:true},plugins:[vue(),{name:'mobile-ui-fixture',resolveId(id){if(id==='/__mobile_ui.js')return id;},load(id){if(id==='/__mobile_ui.js')return entry;},configureServer(server){server.middlewares.use((req,res,next)=>{
  const url=new URL(req.url,'http://localhost');const send=(data,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(url.pathname==='/admin.html'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><div id="adminApp"></div><script type="module" src="/__mobile_ui.js"></script></body></html>');}
  if(!url.pathname.startsWith('/api/'))return next();calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:req.method});
  if(url.pathname.endsWith('/image')){res.setHeader('content-type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#8a9bad"/></svg>');}
  if(url.pathname==='/api/auth/me')return send(user);
  if(req.method!=='GET')return send({error:'演示提交失败，表单应保留供重试'},503);
  if(url.pathname==='/api/people')return send([{id:1,name:'测试采购员',active:1}]);
  if(url.pathname==='/api/products'){let rows=products;const q=url.searchParams.get('query');if(q==='no-match')rows=[];if(q==='1-7')rows=products.filter(p=>p.id===7);const page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('pageSize')||20);return send({rows:rows.slice((page-1)*size,page*size),total:rows.length});}
  if(/^\/api\/orders\/\d+$/.test(url.pathname))return send({order:{id:1,posting_number:'TEST-ORDER-1',shop_name:'测试店铺',status:'awaiting_deliver'},items:[{id:1,online_product_id:7,ozon_sku:'5809791750',ozon_name:'测试订单商品 · TENET T4L 250cm 长名称'}]});
  if(url.pathname.endsWith('/procurement-preview'))return send({products:[]});
  if(url.pathname==='/api/inventory/ledger')return send({revision:'fixture',physical_estimate:12,local_stock:12,open_order_demand:2,fbp_reserved:0,orders:[]});
  if(url.pathname==='/api/inventory-workflow'){if(url.searchParams.get('view')==='local')return send({rows:(url.searchParams.get('product_ids')||'').split(',').filter(Boolean).map(id=>({product_id:Number(id),physical_stock:12,workflow_free:10}))});return send({rows:[],total:0});}
  if(url.pathname==='/api/inventory-workflow/purchase-arrivals')return send({rows:[{id:10,product_id:7,product_name:products[6].name,physical_quantity:10,purchased_at:'2026-11-01T00:00:00Z'}],total:1});
  if(url.pathname==='/api/inventory-workflow/receipts/context')return send({physical:12,available:10,rows:[{id:10,quantity:10,order_no:'PO-TEST'}]});
  return send({rows:[],total:0});
 });}}]});await server.listen();return{server,calls};
}

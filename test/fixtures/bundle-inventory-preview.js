import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function startBundleInventoryPreview(){
 const calls=[],writes=[],stocks=new Map([[210,10],[211,20]]);
 const user={id:1,personId:1,name:'套装测试员',roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}};
 const products=[{id:200,name:'门槛条套装 · 主商品',inventory_number:'2-200',component_count:2},{id:210,name:'子库存 A · 左侧门槛条',inventory_number:'2-210',component_count:0},{id:211,name:'子库存 B · 右侧门槛条',inventory_number:'2-211',component_count:0}].map(p=>({...p,image_url:`/api/products/${p.id}/image`,avg_unit_cost:2,stock_unit:'件',bound_sku_count:0}));
 const context=()=>({product:products[0],revision:'bom1',incomplete:false,structure:[],components:products.slice(1).map((p,i)=>({...p,product_id:p.id,per_set_quantity:i?1:2,active:true,physical_stock:stocks.get(p.id),revision:`revision-${p.id}-${stocks.get(p.id)}`,open_order_demand:1,fbp_reserved:0}))});
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'erp-bundle-preview-'));
 const entry=`import{createApp,h}from'vue';import{createPinia}from'pinia';import{createRouter,createWebHashHistory,RouterView}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import'/frontend/admin/styles/mobile-workbench.css';import Layout from'/frontend/admin/layouts/MobileLayout.vue';import Mobile from'/frontend/admin/views/mobile/MobileInventoryView.vue';import Desktop from'/frontend/admin/views/inventory/InventoryProductsPage.vue';import{useAuthStore}from'/frontend/admin/stores/auth.js';import{setAuthToken}from'/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore();auth.user=${JSON.stringify(user)};setAuthToken('bundle-preview');localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));window.bundleRole=roles=>auth.user={...auth.user,roles};window.bundleErrors=[];app.config.errorHandler=e=>window.bundleErrors.push(e.message);const router=createRouter({history:createWebHashHistory(),routes:[{path:'/inventory/products',component:Desktop},{path:'/mobile',component:Layout,children:[{path:'inventory',component:Mobile,meta:{title:'库存'}}]}]});app.use(router).use(ElementPlus);app.mount('#app');`;
 const server=await createServer({configFile:false,root:process.cwd(),publicDir:false,cacheDir,logLevel:'error',optimizeDeps:{noDiscovery:true,include:['vue','vue-router','pinia','element-plus','@element-plus/icons-vue','pdf-lib','hls.js','bwip-js/browser','@zxing/library']},server:{host:'127.0.0.1',port:8788,strictPort:true,hmr:false},plugins:[vue(),{name:'bundle-preview',resolveId(id){if(id==='/__bundle.js')return id;},load(id){if(id==='/__bundle.js')return entry;},configureServer(vite){vite.middlewares.use((req,res,next)=>{
  const url=new URL(req.url,'http://localhost:8788'),send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(url.pathname==='/admin.html'){res.setHeader('Content-Type','text/html');res.setHeader('Permissions-Policy','camera=(self), microphone=(), geolocation=()');return res.end('<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/__bundle.js"></script></body></html>');}
  if(!url.pathname.startsWith('/api/'))return next();calls.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams)});
  if(url.pathname.endsWith('/image')){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#8a9bad"/></svg>');}
  if(req.method==='POST'){
   if(url.pathname!=='/api/inventory/bundle-stocktake')return send({error:'Unexpected write'},400);
   let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>{const body=JSON.parse(data);writes.push(body);for(const item of body.items)stocks.set(item.product_id,item.counted_quantity);send({ok:true,results:body.items});});return;
  }
  if(url.pathname==='/api/products'){const rows=url.searchParams.get('query')?products.filter(p=>p.inventory_number===url.searchParams.get('query')):products;return send({rows,total:rows.length,page:1,pageSize:20});}
  if(url.pathname==='/api/inventory/bundle-stocktake')return send(context());
  if(url.pathname==='/api/inventory-workflow')return send({rows:products.map(p=>({product_id:p.id,physical_stock:stocks.get(p.id)??5,workflow_free:3,fbp_stock_known:0}))});
  if(url.pathname==='/api/auth/me')return send(user);
  if(url.pathname==='/api/people')return send([{id:1,name:'套装测试员',active:1}]);
  if(url.pathname==='/api/suppliers'||url.pathname==='/api/logistics-rules')return send([]);
  return send({rows:[],total:0});
 });}}]});
 await server.listen();return{server,calls,writes};
}

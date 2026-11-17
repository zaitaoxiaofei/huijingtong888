import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
import {createTenantMysqlFixture} from '../helpers/tenant-mysql-fixture.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real conversion services and an isolated, socket-only random MySQL database.
// No application environment file or production credentials are used.
export async function startBundleConversionPreview(){
 const fixture=await createTenantMysqlFixture('bundle_preview');fixture.useEnvironment();const q=fixture.query;
 const services=await import('../../src/services/mysql-cutover.js');
 const {createInventoryWorkflowService}=await import('../../src/services/inventory-workflow.js');
 const workflow=createInventoryWorkflowService({query:q});
 const user={id:1,personId:1,name:'套装本地测试员',roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}};
 await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','套装本地测试')");
 await q("INSERT INTO people(id,name,role) VALUES(1,'套装本地测试员','procurement')");
 await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json,active) VALUES(2,1,'member',JSON_ARRAY('procurement'),1)");
 await services.prepareInventoryFlowMysql();
 await q("INSERT INTO products(id,tenant_id,name,inventory_number,purchase_cost,stock_unit) VALUES(200,2,'套装 A · X×2 + Y×1','2-200',0,'套'),(202,2,'套装 B · X×1','2-202',0,'套'),(210,2,'散件 X · 共享配件','2-210',2,'个'),(211,2,'散件 Y','2-211',3,'个')");
 await q('INSERT INTO product_components(tenant_id,product_id,component_product_id,quantity) VALUES(2,200,210,2),(2,200,211,1),(2,202,210,1)');
 await q("INSERT INTO inventory_movements(tenant_id,product_id,source_type,source_ref,quantity_delta,stock_location) VALUES(2,210,'opening_stock','preview-x',100,'LOCAL'),(2,211,'opening_stock','preview-y',80,'LOCAL')");
 const cacheDir=await fs.mkdtemp(path.join(os.tmpdir(),'erp-bundle-conversion-'));
 const entry=`import{createApp,h}from'vue';import{createPinia}from'pinia';import{createRouter,createWebHashHistory,RouterView}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import'/frontend/admin/styles/mobile-workbench.css';import Layout from'/frontend/admin/layouts/MobileLayout.vue';import Mobile from'/frontend/admin/views/mobile/MobileInventoryView.vue';import Desktop from'/frontend/admin/views/inventory/InventoryProductsPage.vue';import{useAuthStore}from'/frontend/admin/stores/auth.js';import{setAuthToken}from'/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore();auth.user=${JSON.stringify(user)};setAuthToken('bundle-local-preview');window.bundleErrors=[];app.config.errorHandler=e=>window.bundleErrors.push(e.message);const router=createRouter({history:createWebHashHistory(),routes:[{path:'/inventory/products',component:Desktop},{path:'/mobile',component:Layout,children:[{path:'inventory',component:Mobile,meta:{title:'库存'}}]}]});app.use(router).use(ElementPlus);app.mount('#app');`;
 const server=await createServer({configFile:false,root:process.cwd(),publicDir:false,cacheDir,logLevel:'error',optimizeDeps:{noDiscovery:true,include:['vue','vue-router','pinia','element-plus','@element-plus/icons-vue','pdf-lib','hls.js','bwip-js/browser','@zxing/library']},server:{host:'127.0.0.1',port:8788,strictPort:true,hmr:false},plugins:[vue(),{name:'bundle-real-preview',resolveId(id){if(id==='/__bundle.js')return id;},load(id){if(id==='/__bundle.js')return entry;},configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,'http://localhost:8788'),send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  try{
   if(url.pathname==='/admin.html'){res.setHeader('Content-Type','text/html');return res.end('<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/__bundle.js"></script></body></html>');}
   if(!url.pathname.startsWith('/api/'))return next();
   if(url.pathname.endsWith('/image')){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="168"><rect width="128" height="168" fill="#d8e5e8"/><path d="M24 60 64 38 104 60V110L64 132 24 110Z" fill="#6a8e9d"/><path d="M24 60 64 83 104 60M64 83V132" stroke="#fff" fill="none" stroke-width="3"/></svg>');}
   if(req.method==='POST'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
    if(url.pathname==='/api/inventory/bundle-conversion')return send(await services.applyInventoryBundleConversionMysql(body,user));
    if(url.pathname==='/api/inventory/bundle-stocktake')return send(await services.applyInventoryBundleStocktakeMysql(body,user));
    return send({error:'本地样例仅开放组装、拆包和散件盘点'},403);
   }
   if(url.pathname==='/api/products'){
    const rows=await q("SELECT p.*,(SELECT COUNT(*) FROM product_components c WHERE c.product_id=p.id) AS component_count,0 AS bound_sku_count,0 AS avg_unit_cost FROM products p WHERE p.tenant_id=2 ORDER BY p.id");
    for(const row of rows)row.image_url=`/api/products/${row.id}/image`;
    return send({rows:rows.filter(p=>!url.searchParams.get('query')||p.inventory_number.includes(url.searchParams.get('query'))||p.name.includes(url.searchParams.get('query'))),total:rows.length,page:1,pageSize:20});
   }
   if(url.pathname==='/api/inventory/bundle-conversion')return send(await services.inventoryBundleConversionContextMysql(Object.fromEntries(url.searchParams),user));
   if(url.pathname==='/api/inventory/bundle-stocktake')return send(await services.inventoryBundleContextMysql(Object.fromEntries(url.searchParams),user));
   if(url.pathname==='/api/inventory-workflow'){const ids=String(url.searchParams.get('product_ids')||'200,202,210,211').split(',').map(Number);return send({rows:await workflow.localQuantities(ids,2)});}
   if(url.pathname==='/api/inventory-workflow/product-aliases')return send({rows:[200,202,210,211].map(id=>({product_id:id,product_alias:''}))});
   if(url.pathname==='/api/auth/me')return send(user);
   if(url.pathname==='/api/people')return send([{id:1,name:user.name,active:1}]);
   if(url.pathname==='/api/suppliers'||url.pathname==='/api/logistics-rules')return send([]);
   return send({rows:[],total:0});
  }catch(error){send({error:error.message},error.statusCode||500);}
 });}}]});
 await server.listen();
 const close=async()=>{await server.close();const {closeMysqlPool}=await import('../../src/mysql-pool.js');await closeMysqlPool();await fixture.cleanup();await fs.rm(cacheDir,{recursive:true,force:true});};
 return{server,fixture,close};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const preview=await startBundleConversionPreview();console.log('套装库存真实本地样例：http://localhost:8788/admin.html#/inventory/products');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await preview.close();process.exit(0);});
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('desktop inventory pages open existing metadata and history using product IDs without inventory writes',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000
},async t=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-product-actions-'));let browser;
 const reads=[],writes=[],errors=[];
 const product=id=>({id,name:`实际库存 ${id}`,inventory_number:`1-2-${id}`,active:1,product_type:'main',selection_status:'listed',owner_person_id:7,updated_at:'2026-11-06 01:23:45',stock_unit:'个',component_count:0,composition_items:[],structured_naming:{category:'门槛条',accessory:'旧款',quantity:1,stock_unit:'个',fitment_type:'universal',vehicle_brand:'',vehicle_models:[],colors:[],materials:[],package_mode:'single'}});
 const row={id:901,product_id:200,product_name:'实际库存 200',inventory_number:'1-2-200',shop_id:20,shop_name:'测试店铺',ozon_sku:'SKU-901',offer_id:'OFFER-901',active:1,quantity:80,physical_quantity:80,amount:100,order_no:'PO-901',purchased_at:'2026-11-06 01:00:00',received_at:'2026-11-06 02:00:00',status:'pending_arrival',components:[{product_id:201,name:'最小实物 201',inventory_number:'1-2-201',quantity:80,per_set_quantity:1}],requested_qty:5,approved_qty:5,final_qty:5};
 const entry=`import{createApp,h}from'vue';import{createPinia}from'pinia';import{createRouter,createWebHashHistory,RouterView}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';
 import Products from'/frontend/admin/views/inventory/InventoryProductsPage.vue';import Hidden from'/frontend/admin/views/inventory/InventoryHiddenPage.vue';import Fbp from'/frontend/admin/views/inventory/InventoryFbpPage.vue';import Alerts from'/frontend/admin/views/inventory/InventoryAlertsPage.vue';import Mappings from'/frontend/admin/views/inventory/InventoryMappingsPage.vue';import Opportunities from'/frontend/admin/views/inventory/InventoryFbpOpportunitiesPage.vue';import Replenishment from'/frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue';import Online from'/frontend/admin/views/inventory/OnlineProductsView.vue';import Legacy from'/frontend/admin/views/procurement/PurchaseListView.vue';import History from'/frontend/admin/views/procurement/PurchaseHistoryView.vue';import Receiving from'/frontend/admin/views/inventory/InventoryReceivingWorkspace.vue';import Supply from'/frontend/admin/components/inventory/InventorySupplyWorkspace.vue';import Queue from'/frontend/admin/components/procurement/InventoryPurchaseBatchQueue.vue';import FbpReceipt from'/frontend/admin/components/inventory/InventoryFbpReceiptReview.vue';import{useAuthStore}from'/frontend/admin/stores/auth.js';import{setAuthToken}from'/frontend/admin/utils/api.js';
 const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore();auth.user={id:7,personId:7,name:'库存入口验证',roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('inventory-actions-fixture');window.changeRoles=roles=>auth.user={...auth.user,roles};
 const routes=[['/inventory/products',Products],['/inventory/hidden',Hidden],['/inventory/fbp',Fbp],['/inventory/alerts',Alerts],['/inventory/mappings',Mappings],['/inventory/fbp-opportunities',Opportunities],['/inventory/fbp-replenishment',Replenishment],['/online-products',Online],['/legacy-receiving',Legacy],['/purchase-history',History],['/purchase-list',Receiving],['/fbp-receipts',FbpReceipt],['/supply',{render:()=>h(Supply,{entry:'procurement',initialTask:'required'})}],['/queue-open',{render:()=>h(Queue,{status:'open',filters:{}})}]].map(([path,component])=>({path,component}));const router=createRouter({history:createWebHashHistory(),routes});window.testRouter=router;app.use(router).use(ElementPlus);app.mount('#app');`;
 try{
  await build({configFile:false,root:process.cwd(),publicDir:false,logLevel:'error',plugins:[vue(),{name:'inventory-actions-fixture',resolveId(id){if(id==='virtual:inventory-actions')return '\0inventory-actions';},load(id){if(id==='\0inventory-actions')return entry;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:inventory-actions',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),reply=value=>route.fulfill({json:value});assert.equal(url.origin,'http://localhost:8788');
   if(request.method()!=='GET'){writes.push(`${request.method()} ${url.pathname}`);return route.abort();}
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname.startsWith('/api/'))reads.push(url.pathname+url.search);
   const historyId=Number(url.pathname.match(/^\/api\/products\/(\d+)\/edit-history$/)?.[1]);
   if(historyId)return reply({product_id:historyId,current:product(historyId),number_aliases:[],name_aliases:[],rows:[],total:0,page:1,pageSize:20,history_complete:false,history_notice:'仅展示真实留存历史'});
   const productId=Number(url.pathname.match(/^\/api\/products\/(\d+)$/)?.[1]);if(productId)return reply(product(productId));
   if(url.pathname==='/api/people')return reply([{id:7,name:'库存负责人',active:1}]);
   if(url.pathname==='/api/shops')return reply([{id:20,name:'测试店铺',active:1}]);
   if(url.pathname==='/api/suppliers')return reply(url.searchParams.has('paged')?{rows:[]}:[]);
   if(url.pathname==='/api/logistics-rules')return reply([]);
   if(url.pathname==='/api/products'||url.pathname==='/api/products/hidden')return reply({rows:[product(200)],total:1});
   if(url.pathname==='/api/inventory-workflow/purchase-arrivals')return reply({rows:[row],days:[{date:'2026-11-06',open:1,arrived:1}],selected_day:'2026-11-06',page:1,total:1,summary:{open:1,arrived:1}});
   if(url.pathname==='/api/inventory-workflow'){const {id,...workflowRow}=row;return reply({rows:[{...workflowRow,component_count:0,physical:10,free:10,local_stock:10,supply_plan:{}}],total:1,meta:{},snapshot:{available:true,refreshing:false,calculated_at:'2026-11-06 01:00:00'}});}
   if(url.pathname==='/api/stock-alerts')return reply({rows:[row,{...row,id:902,product_id:null,product_name:'未绑定库存 SKU'}],total:2});
   if(url.pathname==='/api/inventory-workflow/alerts'||url.pathname==='/api/mappings'||url.pathname==='/api/fbp-opportunities'||url.pathname==='/api/online-products'||url.pathname==='/api/inbound-records')return reply({rows:[row],total:1});
   if(url.pathname==='/api/inventory-workflow/details')return reply({rows:[row],total:1});
   if(url.pathname==='/api/fbp-replenishment-orders')return reply({rows:[{id:950,status:'draft',shop_id:20,shop_name:'测试店铺',order_no:'FBP-950',items:[row]}],total:1});
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return reply({rows:[],total:0,brands:[]});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):decodeURIComponent(url.pathname.slice(1));return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await fs.mkdir('.verification',{recursive:true});
  const cases=[['/inventory/products',200],['/supply',200],['/queue-open',201],['/purchase-list',201],['/fbp-receipts',200],['/inventory/fbp',200],['/inventory/alerts',200],['/inventory/alerts?view=sku',200],['/inventory/mappings',200],['/inventory/fbp-opportunities',200],['/inventory/fbp-replenishment',200],['/inventory/fbp-replenishment',200,'inventory'],['/online-products',200],['/legacy-receiving',200],['/purchase-history',200],['/inventory/hidden',200]];
  for(const [target,id,view] of cases){
   t.diagnostic(target+(view?' '+view:''));
   try{
   await page.goto('http://localhost:8788/admin.html#'+target);
   if(view==='inventory')await page.getByText('库存视角',{exact:true}).click();
   const action=page.getByRole('button',{name:'历史版本',exact:true}).first();await action.waitFor();
   const before=reads.length;await action.click();const history=page.getByRole('dialog',{name:'库存历史版本',exact:true});await history.getByText(`实际库存 ${id}`,{exact:true}).waitFor();
   assert.ok(reads.slice(before).some(url=>url.startsWith(`/api/products/${id}/edit-history?`)),target+' history uses the inventory product, not the row ID');
   await history.getByRole('button',{name:'关闭',exact:true}).click();await history.waitFor({state:'hidden'});
   if(target==='/inventory/hidden'){assert.equal(await page.getByRole('button',{name:'编辑库存',exact:true}).count(),0);continue;}
   const edit=target==='/inventory/products'?page.locator('.inventory-actions').getByRole('button',{name:'编辑',exact:true}):page.getByRole('button',{name:'编辑库存',exact:true}).first();
   const editBefore=reads.length;await edit.click();const editor=page.locator('.selection-form-dialog:not(.selection-form-dialog--mobile)');await editor.waitFor();
   if(target!=='/inventory/products')assert.ok(reads.slice(editBefore).includes(`/api/products/${id}`),target+' editor reads the exact product');
   await editor.locator('.inventory-dialog-header__actions').getByRole('button',{name:'取消',exact:true}).click();await editor.waitFor({state:'hidden'});
   if(['/inventory/products','/purchase-list'].includes(target))await page.screenshot({path:'.verification/inventory-actions-'+(target==='/purchase-list'?'receiving':'products')+'.png',animations:'disabled'});
   }catch(error){await page.screenshot({path:'.verification/inventory-actions-failure.png',animations:'disabled'});throw new Error(target+': '+error.message+'; '+JSON.stringify({reads:reads.slice(-12),errors,dialogs:await page.getByRole('dialog').allTextContents()}));}
  }
  await page.goto('http://localhost:8788/admin.html#/inventory/fbp');await page.getByRole('button',{name:'历史版本',exact:true}).waitFor();assert.equal(await page.locator('.inventory-product-actions').count(),1,'unbound SKU does not guess a product from its row ID or displayed inventory number');
  await page.evaluate(()=>window.changeRoles(['packing']));assert.equal(await page.getByRole('button',{name:'编辑库存',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'历史版本',exact:true}).count(),1);
  await page.evaluate(()=>window.changeRoles(['technical']));assert.equal(await page.getByRole('button',{name:'编辑库存',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'历史版本',exact:true}).count(),0);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

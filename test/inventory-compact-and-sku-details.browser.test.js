import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
test('compact inventory stays usable without eager workflow scans; FBP images and composition load only in detail', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-compact-'));let browser;
 const errors=[],api=[],writes=[];let compositionReads=0,quantityReads=0,quantityRoute,quantityReady;const quantityRequested=new Promise(resolve=>{quantityReady=resolve;});
 const row={id:12,name:'普通贴纸 4件',inventory_number:'3-1',stock:23,physical_stock:20,fbp_stock:3,fbp_stock_known:3,workflow_free:11,component_count:0,stock_unit:'份',purchase_cost:5,total_sales_quantity:10,total_sales_amount:100,total_purchase_quantity:30,total_purchase_amount:150,order_count:10};
 try{
 await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'compact-fixture',resolveId(id){if(id==='virtual:compact')return '\0compact';},load(id){if(id==='\0compact')return `import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createMemoryHistory} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import 'element-plus/theme-chalk/dark/css-vars.css';import '/frontend/admin/styles/index.css';import Products from '/frontend/admin/views/inventory/InventoryProductsPage.vue';import Skus from '/frontend/admin/components/procurement/InventoryFbpSkuTable.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';const pinia=createPinia();const router=createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]});const component=location.search.includes('sku')?{render:()=>h(Skus,{productId:12,rows:[{shop_id:20,shop_name:'A shop',ozon_sku:'TEST-BUNDLE',root_product_id:202,product_name:'不锈钢＋贴纸8件套',present:3,available:3,per_set_quantity:1,inventory_quantity:3,warehouse_name:'FBP'}]})}:Products;const app=createApp(component).use(pinia).use(router).use(ElementPlus);useAuthStore(pinia).user={id:2,personId:2,roles:['operations'],tenant:{id:2,slug:'a',role:'member'}};app.mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:compact',output:{entryFileNames:'entry.js'}}}});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage({viewport:{width:1920,height:1080}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://localhost:8788/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
  if(url.pathname.startsWith('/api/')){
   api.push(url.pathname+url.search);if(route.request().method()!=='GET')writes.push(url.pathname);
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#409eff"/></svg>'});
   if(url.pathname==='/api/inventory-workflow'&&url.searchParams.get('view')==='sku'){compositionReads++;return route.fulfill({json:{source:'bundle',root:{id:202,name:'不锈钢＋贴纸8件套',inventory_number:'2-202'},components:[{product_id:6,inventory_number:'2-2',name:'不锈钢4件',quantity:1,stock_unit:'份',current:false,image_url:'/api/products/6/image'},{product_id:12,inventory_number:'3-1',name:'普通贴纸4件',quantity:1,stock_unit:'份',current:true,image_url:'/api/products/12/image'}]}});}
   if(url.pathname==='/api/products')return route.fulfill({json:{rows:[{...row,physical_stock:null,workflow_free:null,fbp_stock_known:null}],total:1}});
   if(url.pathname==='/api/inventory-workflow'&&url.searchParams.get('view')==='local'){quantityReads++;quantityRoute=route;quantityReady();return;}
   if(url.pathname==='/api/inventory/ledger'){
    if(url.searchParams.get('view')==='fbp')return route.fulfill({json:{fbp_inventory:{rows:[],present:0,incomplete:false},applications:[],requested:0}});
    return route.fulfill({json:{product:row,physical_estimate:20,open_order_demand:2,fbp_reserved:0,incoming_quantity:0,current_incoming:0,current_shortage:0,orders:[],purchases:[],movements:[],batches:[],sources:[],actions:[],flow_summary:{safety:7,free:11,orders:[],applications:[],applications_pending:true}}});
   }
   if(url.pathname==='/api/inventory-workflow')return route.fulfill({json:{rows:[{product_id:12,requests:[]}]}});
   if(url.pathname==='/api/inventory-flow/sync')return route.fulfill({json:{running:false,result:{ok:true}}});
   return route.fulfill({json:{rows:[]}});
  }
  const asset=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(n=>n.endsWith('.css'))):url.pathname.slice(1);return route.fulfill({contentType:asset.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,asset))});
 });
 await page.goto('http://localhost:8788/admin.html?sku');await page.getByText('TEST-BUNDLE',{exact:true}).waitFor();assert.equal(compositionReads,0);await page.getByRole('button',{name:'查看库存组成',exact:true}).click();await page.getByText('普通贴纸4件',{exact:true}).waitFor();assert.equal(compositionReads,1);await page.getByText('当前查看库存',{exact:true}).waitFor();assert.equal(await page.locator('.fbp-component').count(),2);await page.getByRole('button',{name:'查看库存组成',exact:true}).click();await page.getByRole('button',{name:'查看库存组成',exact:true}).click();assert.equal(compositionReads,1,'reopening uses current expanded detail');
 await page.goto('http://localhost:8788/admin.html');await page.locator('.inventory-actions').getByRole('button',{name:'库存明细',exact:true}).waitFor();
 const labels=await page.locator('.el-table__header-wrapper th').allTextContents();for(const removed of ['预估利润','真实利润','采购在途','FBP在途'])assert.ok(!labels.some(label=>label.trim()===removed));assert.ok(labels.some(label=>label.trim()==='库存货值'));
 assert.deepEqual(await page.locator('.inventory-actions>button').allTextContents(),['编辑','更新本地库存','库存明细','更多']);assert.equal(api.filter(url=>url.startsWith('/api/inventory-workflow')&&!url.includes('view=sku')&&!url.includes('view=local')).length,0,'list has no full workflow request');assert.ok(api.some(url=>url.startsWith('/api/products?')&&url.includes('view=inventory')));
 await quantityRequested;assert.equal(quantityReads,1);await page.getByText('普通贴纸 4件',{exact:true}).waitFor();await quantityRoute.fulfill({json:{rows:[{product_id:12,physical_stock:20,workflow_free:11,fbp_stock_known:3}]}});await page.getByText('可用 11 份',{exact:true}).waitFor();
 for(const width of [1920,1366]){await page.setViewportSize({width,height:1080});for(const dark of [false,true]){await page.evaluate(v=>document.documentElement.classList.toggle('dark',v),dark);await page.screenshot({path:`.verification/inventory-compact-${width}-${dark?'dark':'light'}.png`,animations:'disabled'});assert.ok((await page.locator('.el-table__body-wrapper tr').first().boundingBox()).height<140,'actions do not stretch rows');}}
 await page.locator('.inventory-actions').getByRole('button',{name:'库存明细',exact:true}).click();await page.locator('[data-node="physical"]').waitFor();assert.ok(api.some(url=>url.includes('/api/inventory-workflow?')&&url.includes('view=requests')));assert.ok(!api.some(url=>url.startsWith('/api/inventory-workflow?')&&!url.includes('view=requests')&&!url.includes('view=sku')&&!url.includes('view=local')),'opening detail does not load the full forecast');
 assert.ok(writes.every(url=>url==='/api/inventory-flow/sync'),'only the existing read-through stock sync can run; no purchase, stocktake or binding writes');assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

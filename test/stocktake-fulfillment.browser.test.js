import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

test('stocktake separates FBS and FBP, loads official stock independently and only submits local physical count',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:60000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'stocktake-fulfillment-'));let browser;const posts=[];
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'stocktake-preview',resolveId:id=>id==='virtual:stocktake'?'\0stocktake':undefined,load:id=>id==='\0stocktake'?`import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createMemoryHistory} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import 'element-plus/theme-chalk/dark/css-vars.css';import Ledger from '/frontend/admin/components/procurement/ProcurementLedgerDialog.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';const app=createApp({render:()=>h(Ledger,{modelValue:true,productId:10,initialAction:'stocktake'})});const pinia=createPinia();app.use(pinia);useAuthStore().user={roles:['procurement'],tenant:{id:2,role:'member'}};app.use(createRouter({history:createMemoryHistory(),routes:[]})).use(ElementPlus).mount('#app');`:undefined}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:stocktake',output:{entryFileNames:'entry.js',chunkFileNames:'chunks/[name]-[hash].js'}}}});
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const ledger={product:{id:10,name:'测试配件',inventory_number:'21-4'},revision:'v1',physical_estimate:20,available_estimate:8,open_order_demand:9,fbp_reserved:3,fulfillment_summary:{fbs:{order_count:3,quantity:9},fbp:{order_count:2,quantity:50}},orders:[],movements:[],purchases:[],batches:[],actions:[],sources:[],cost_tasks:[],allocations:[],cost_links:[],priorities:[]};
  await page.route('http://localhost:8788/**',async route=>{
   const url=new URL(route.request().url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(route.request().method()==='POST'){const body=route.request().postDataJSON();posts.push({path:url.pathname,body});return json(url.pathname.endsWith('/preview')?{physical_before:20,physical_after:25,available_before:8,available_after:13,open_order_demand:9,fbp_reserved:3,stocktake_delta:5}:{ok:true});}
   if(url.pathname.endsWith('/ledger')){if(url.searchParams.get('view')==='fbp'){await new Promise(r=>setTimeout(r,800));return json({fbp_inventory:{present:100,available:70,incomplete:false,rows:[]},applications:[]});}return json(ledger);}
   if(url.pathname.startsWith('/api/'))return json({rows:[]});
   const asset=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(n=>n.endsWith('.css'))):url.pathname.slice(1);return route.fulfill({contentType:asset.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,asset))});
  });
  await page.goto('http://localhost:8788/admin.html');const dialog=page.getByRole('dialog',{name:'更新本地库存',exact:true});await dialog.waitFor();
  const fbs=dialog.getByRole('region',{name:'FBS本地库存'}),fbp=dialog.getByRole('region',{name:'FBP官方库存'});
  await fbs.getByText('待发订单 3 单 · 9 件',{exact:true}).waitFor();await fbp.getByText('待发订单 2 单 · 50 件',{exact:true}).waitFor();
  await dialog.getByRole('spinbutton',{name:'本地仓库实物总数'}).fill('25');await fbp.getByText('70 件',{exact:true}).waitFor();assert.equal(await dialog.getByRole('spinbutton',{name:'本地仓库实物总数'}).inputValue(),'25');
  assert.equal(await dialog.getByText(/家里/).count(),0);await dialog.getByText('历史库存记错',{exact:true}).click();
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/stocktake-fulfillment-light.png',fullPage:true,animations:'disabled'});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));await page.screenshot({path:'.verification/stocktake-fulfillment-dark.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'.verification/stocktake-fulfillment-mobile.png',fullPage:true,animations:'disabled'});
  await dialog.getByRole('button',{name:'预览变动',exact:true}).click();const submitted=posts.find(p=>p.path.endsWith('/preview'));assert.equal(submitted.body.counted_quantity,25);assert.equal(submitted.body.stocktake_type,'physical');assert.equal(submitted.body.stock_location,undefined);assert.equal(submitted.body.fbp_inventory,undefined);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

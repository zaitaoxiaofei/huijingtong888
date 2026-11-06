import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('mobile shipping cards show the recorded latest print time in Beijing without changing print state or submitting writes',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'mobile-print-time-'));let browser;
 const reads=[],writes=[],errors=[];
 const base={status:'awaiting_deliver',shop_name:'手机打包测试店铺',skus:'KEY-1',sku_names:'KEY-1:普通钥匙壳',sku_inventory_numbers:'KEY-1:1-2-3',sku_quantities:'KEY-1:1',unbound_item_count:0};
 const records=[
  {...base,id:1,posting_number:'PRINT-UTC-NAIVE-LONG-ORDER',printed_at:'2026-11-05 16:01:02'},
  {...base,id:2,posting_number:'PRINT-UTC-ISO',printed_at:'2026-11-05T16:01:02Z'},
  {...base,id:3,posting_number:'PRINT-WITH-OFFSET',printed_at:'2026-11-06T00:01:02+08:00'},
  {...base,id:4,posting_number:'NOT-PRINTED',printed_at:null,ordered_at:'2026-11-05T18:00:00Z',updated_at:'2026-11-06T02:00:00Z'},
  {...base,id:5,posting_number:'PRINT-TIME-UNKNOWN',printed_at:'invalid-print-time'}
 ];
 const entry=`import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import Layout from '/frontend/admin/layouts/MobileLayout.vue';import Orders from '/frontend/admin/views/mobile/MobileOrdersView.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore(),user={id:7,personId:7,name:'打包验证',roles:['packing'],tenant:{id:2,slug:'a',role:'member'}};auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('mobile-print-fixture');const router=createRouter({history:createWebHashHistory(),routes:[{path:'/mobile',component:Layout,children:[{path:'orders',component:Orders,meta:{title:'手机订单'}},{path:'orders/:id',component:{render:()=>h('p','订单详情验证入口')},meta:{title:'订单详情'}}]}]});window.fixtureRoute=()=>router.currentRoute.value.fullPath;window.changePrintScope=()=>{auth.user={...user,tenant:{id:3,slug:'b',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('mobile-print-other-scope');currentApiCacheScope();};app.use(router).use(ElementPlus);app.mount('#app');`;
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',publicDir:false,plugins:[vue(),{name:'mobile-print-fixture',resolveId(id){if(id==='virtual:mobile-print-time')return '\0mobile-print-time';},load(id){if(id==='\0mobile-print-time')return entry;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:mobile-print-time',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/Los_Angeles'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   assert.equal(url.origin,'http://localhost:8788','mobile print QA must not access external services');
   if(request.method()!=='GET'){writes.push(url.pathname);return route.abort();}
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname==='/api/orders'){
    const query=Object.fromEntries(url.searchParams);reads.push(query);const rows=records.filter(row=>query.printFilter==='printed'?!!row.printed_at:query.printFilter==='unprinted'?!row.printed_at:true);
    return route.fulfill({json:{rows,total:rows.length,page:1,pageSize:20}});
   }
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{rows:[]}});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):decodeURIComponent(url.pathname.slice(1));
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/mobile/orders?status=awaiting_deliver');
  const card=posting=>page.locator('.mobile-order-card').filter({hasText:posting});
  await card('PRINT-UTC-NAIVE-LONG-ORDER').getByText('2026/11/06 00:01:02',{exact:true}).waitFor();
  await card('PRINT-UTC-ISO').getByText('2026/11/06 00:01:02',{exact:true}).waitFor();await card('PRINT-WITH-OFFSET').getByText('2026/11/06 00:01:02',{exact:true}).waitFor();
  assert.equal(await card('NOT-PRINTED').locator('.mobile-order-card__print-time').count(),0);assert.equal(await card('NOT-PRINTED').locator('.mobile-print-badge').innerText(),'未打印');
  await card('PRINT-TIME-UNKNOWN').getByText('待核实',{exact:true}).waitFor();assert.equal(await card('PRINT-TIME-UNKNOWN').locator('.mobile-print-badge').innerText(),'已打印');
  assert.equal(reads[0].status,'awaiting_deliver');assert.equal(reads[0].includeCounts,'0');assert.equal(reads[0].sortMode,'inventory_picking');
  await fs.mkdir('.verification',{recursive:true});
  for(const width of [375,390,430]){
   await page.setViewportSize({width,height:844});await page.locator('.mobile-list-scroll').evaluate(el=>el.scrollTo(0,0));
   assert.equal(await page.evaluate(()=>[document.documentElement,document.body,document.querySelector('.mobile-content'),...document.querySelectorAll('.mobile-order-card')].every(el=>el.scrollWidth<=el.clientWidth+1)),true);
   await page.screenshot({path:'.verification/mobile-order-print-time-'+width+'.png',animations:'disabled'});
  }
  records[0].printed_at='2026-11-06 01:22:33';await page.getByRole('button',{name:'查询',exact:true}).click();await card('PRINT-UTC-NAIVE-LONG-ORDER').getByText('2026/11/06 09:22:33',{exact:true}).waitFor();
  await page.getByRole('combobox',{name:'打印状态',exact:true}).selectOption('printed');await page.waitForFunction(()=>document.querySelectorAll('.mobile-order-card').length===4);assert.equal(reads.at(-1).printFilter,'printed');
  await page.getByRole('combobox',{name:'打印状态',exact:true}).selectOption('unprinted');await card('NOT-PRINTED').waitFor();assert.equal(await page.locator('.mobile-order-card').count(),1);assert.equal(await page.locator('.mobile-order-card__print-time').count(),0);
  await card('NOT-PRINTED').getByRole('button',{name:'详情',exact:true}).click();await page.waitForFunction(()=>window.fixtureRoute().startsWith('/mobile/orders/4'));
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

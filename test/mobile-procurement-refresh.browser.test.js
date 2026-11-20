import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('mobile procurement follows completed snapshots, registers selected products and stops obsolete polling',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'mobile-procurement-refresh-'));let browser;
 const reads=[],writes=[],errors=[];
 let warming=0,mode='ready',revision=1,remaining=[101,102],failedPurchase=false;
 const product=id=>({id,product_id:id,name:`手机采购商品 ${id}`,product_name:`手机采购商品 ${id}`,inventory_number:`1-3-${id}`,component_count:0});
 const demandRow=id=>({...product(id),workflow:{product_id:id,physical_recorded:0,incoming:0,supply_plan:{known:true,required_purchase:2,optional_purchase:3}}});
 const entry=`import{createApp,h}from'vue';import{createPinia}from'pinia';import{createRouter,createWebHashHistory,RouterView}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import Layout from'/frontend/admin/layouts/MobileLayout.vue';import Queue from'/frontend/admin/components/mobile/MobileWorkQueue.vue';import{useAuthStore}from'/frontend/admin/stores/auth.js';import{setAuthToken,currentApiCacheScope}from'/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore(),user={id:7,personId:7,name:'采购验证',roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}};auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('mobile-procurement-test');window.changeScope=()=>{auth.user={...user,tenant:{id:3,slug:'b',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('other-scope');currentApiCacheScope();};const router=createRouter({history:createWebHashHistory(),routes:[{path:'/mobile',component:Layout,children:[{path:'procurement',component:Queue,meta:{title:'采购'}},{path:'other',component:{template:'<p>其他页面</p>'},meta:{title:'其他'}}]}]});window.mobileRouter=router;app.use(router).use(ElementPlus);app.mount('#app');`;
 try{
  await build({configFile:false,root:process.cwd(),publicDir:false,logLevel:'error',plugins:[vue(),{name:'procurement-refresh-fixture',resolveId(id){if(id==='virtual:procurement-refresh')return'\0procurement-refresh';},load(id){if(id==='\0procurement-refresh')return entry;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:procurement-refresh',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),reply=data=>route.fulfill({json:data});
   assert.equal(url.origin,'http://localhost:8788');
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>'});
   if(request.method()==='POST'){
    const body=request.postDataJSON();writes.push({path:url.pathname,body});assert.equal(url.pathname,'/api/procurement/purchases');
    if(!failedPurchase){failedPurchase=true;return route.fulfill({status:503,json:{error:'暂不可用，请重试'}});}
    remaining=[];warming=1;revision++;return reply({ok:true,purchase_order_id:1001});
   }
   if(url.pathname==='/api/products')return reply({rows:[product(101),product(102)],total:2});
   if(url.pathname==='/api/inventory-workflow/alerts'){
    const params=Object.fromEntries(url.searchParams);reads.push(params);
    if(params.refresh==='1'){warming=1;revision++;}
    const refreshing=mode!=='error'&&(mode==='warming'||warming-->0);
    const snapshot={available:true,stale:refreshing,refreshing,calculated_at:`2026-11-21T00:00:0${revision}Z`,error:mode==='error'?'后台核算失败，请重新核算重试':null};
    return reply({rows:remaining.map(demandRow),total:remaining.length,snapshot});
   }
   if(url.pathname==='/api/inventory-workflow')return reply({rows:(url.searchParams.get('product_ids')||url.searchParams.get('product_id')||'').split(',').filter(Boolean).map(Number).map(id=>demandRow(id).workflow)});
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#8baca1"/></svg>'});
   if(url.pathname.startsWith('/api/'))return reply({rows:[],total:0});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):decodeURIComponent(url.pathname.slice(1));
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/mobile/procurement');
  warming=1;await page.getByRole('button',{name:'保障补货',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.mobile-work-queue')?.textContent.includes('正在更新采购建议'));
  await page.waitForFunction(()=>!document.querySelector('.mobile-work-queue')?.textContent.includes('正在更新采购建议'));
  assert.ok(reads.length>=2,'warming response is followed without changing tabs');
  assert.equal(reads.at(-1).refresh,undefined,'poll does not restart full calculation');
  await page.locator('.mobile-work-queue').getByRole('button',{name:'刷新',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.mobile-work-queue')?.textContent.includes('正在更新采购建议'));
  await page.waitForFunction(()=>!document.querySelector('.mobile-work-queue')?.textContent.includes('正在更新采购建议'));
  assert.equal(reads.filter(r=>r.refresh==='1').length,1,'manual refresh starts one calculation');
  // Batch registration uses the same actual-purchase form and one idempotent submission.
  await page.getByText('选择本页商品',{exact:true}).click();
  await fs.mkdir('.verification',{recursive:true});
  for(const width of [375,390,430]){
   await page.setViewportSize({width,height:844});
   assert.equal(await page.evaluate(()=>[document.documentElement,document.body,document.querySelector('.mobile-work-queue')].every(el=>el.scrollWidth<=el.clientWidth+1)),true);
   await page.screenshot({path:`.verification/mobile-procurement-selection-${width}.png`,animations:'disabled'});
  }
  await page.getByRole('button',{name:/批量登记采购.*2/}).click();
  const dialog=page.getByRole('dialog',{name:'登记实际采购',exact:true});await dialog.waitFor();
  assert.equal(await dialog.getByRole('spinbutton',{name:'实际采购件数',exact:true}).count(),2);
  const quantities=dialog.getByRole('spinbutton',{name:'实际采购件数',exact:true}),amounts=dialog.getByRole('spinbutton',{name:'采购货款',exact:true});
  await quantities.nth(0).fill('4');await quantities.nth(1).fill('7');await amounts.nth(0).fill('40');await amounts.nth(1).fill('70');
  for(const [width,height] of [[375,667],[390,480],[430,844]]){
   await page.setViewportSize({width,height});assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
   const footer=await dialog.locator('.el-dialog__footer').boundingBox();assert.ok(footer.y+footer.height<=height+1);
   await page.screenshot({path:`.verification/mobile-procurement-batch-${width}x${height}.png`,animations:'disabled'});
  }
  await dialog.getByRole('button',{name:'确认登记',exact:true}).click();await dialog.getByText(/暂不可用，请重试/).waitFor();
  await dialog.getByRole('button',{name:'确认登记',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(writes[1].body.workspace_batch,true);
  assert.deepEqual(writes[1].body.items.map(r=>[r.product_id,r.quantity,r.amount]),[[101,4,40],[102,7,70]]);
  await page.getByText('当前筛选暂无待处理记录',{exact:true}).waitFor();
  assert.equal(await page.locator('.mobile-list-scroll>.mobile-record').count(),0);
  // Snapshot failures are visible and manual refresh recovers; no silent zero-demand state.
  mode='error';await page.locator('.mobile-work-queue').getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('后台核算失败，请重新核算重试',{exact:true}).waitFor();
  const failedReads=reads.length;await page.waitForTimeout(8500);assert.equal(reads.length,failedReads);
  mode='ready';await page.locator('.mobile-work-queue').getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('当前筛选暂无待处理记录',{exact:true}).waitFor();
  // Changing tabs and identity cancels the pending follow-up.
  mode='warming';await page.getByRole('button',{name:'必须采购',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mobile-work-queue')?.textContent.includes('正在更新采购建议'));
  await page.getByRole('button',{name:'登记采购',exact:true}).first().click();const tabReads=reads.length;await page.waitForTimeout(8500);assert.equal(reads.length,tabReads);
  await page.getByRole('button',{name:'必须采购',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mobile-work-queue')?.textContent.includes('正在更新采购建议'));
  await page.evaluate(()=>window.changeScope());const scopeReads=reads.length;await page.waitForTimeout(8500);assert.equal(reads.length,scopeReads);assert.equal(await page.locator('.mobile-list-scroll>.mobile-record').count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

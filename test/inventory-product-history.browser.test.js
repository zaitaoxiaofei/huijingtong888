import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('inventory edit history is lazy, readable on phone and desktop, paged and cleared on product/session changes',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-history-browser-'));let browser,hold=false,releaseHeld,failNext=false;
 const reads=[],writes=[],errors=[];
 const history=id=>({product_id:id,current:{id,inventory_number:id===200?'2-1-3':'2-1-4',name:`当前库存 ${id}`},number_aliases:id===200?[{number:'1-1-2',recorded_at:'2026-11-06 16:01:02'}]:[],name_aliases:id===200?[{name:'历史错误名称',active:true,recorded_at:'2026-11-06T16:01:02Z'}]:[],history_complete:false,history_notice:'仅展示已留存的身份资料版本；旧编号与旧名称分别留存，留存时间不等于修改发生时间。',total:id===200?25:0,rows:[]});
 const records=Array.from({length:25},(_,i)=>({id:i+1,recorded_at:'2026-11-06 16:01:02',actor:{id:7,name:'资料维护员'},source:'catalog_edit',source_label:'库存资料编辑',before:{name:'旧名称 '+i,inventory_number:'1-1-2'},after:{name:'新名称 '+i,inventory_number:'2-1-3'},changed_fields:['name','inventory_number']})).reverse();
 Object.assign(records.at(-1),{unavailable:true,before:null,after:null,changed_fields:[]});
 const entry=`import{createApp,h,ref}from'vue';import{createPinia}from'pinia';import{createRouter,createWebHashHistory,RouterView}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import Layout from'/frontend/admin/layouts/MobileLayout.vue';import Action from'/frontend/admin/components/inventory/InventoryProductHistoryAction.vue';import{useAuthStore}from'/frontend/admin/stores/auth.js';import{setAuthToken,currentApiCacheScope}from'/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore(),user={id:7,personId:7,name:'历史查看',roles:['packing'],tenant:{id:2,slug:'a',role:'member'}};auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('history-fixture');const id=ref(200),view=mobile=>({setup(){return()=>h(Action,{productId:id.value,mobile});}});const router=createRouter({history:createWebHashHistory(),routes:[{path:'/mobile',component:Layout,children:[{path:'history',component:view(true),meta:{title:'库存历史'}}]},{path:'/desktop',component:view(false)}]});window.historyProduct=value=>id.value=value;window.historyScope=()=>{auth.user={...user,tenant:{id:3,slug:'b',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('other-history-scope');currentApiCacheScope();};window.historyRouter=router;app.use(router).use(ElementPlus);app.mount('#app');`;
 try{
  await build({configFile:false,root:process.cwd(),publicDir:false,logLevel:'error',plugins:[vue(),{name:'history-fixture',resolveId(id){if(id==='virtual:inventory-history')return '\0inventory-history';},load(id){if(id==='\0inventory-history')return entry;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:inventory-history',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/Los_Angeles'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());assert.equal(url.origin,'http://localhost:8788','history fixtures cannot call external services');
   if(request.method()!=='GET'){writes.push(url.pathname);return route.abort();}
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(/^\/api\/products\/\d+\/edit-history$/.test(url.pathname)){
    reads.push(url.pathname+url.search);if(hold){hold=false;await new Promise(resolve=>releaseHeld=resolve);}
    if(failNext){failNext=false;return route.fulfill({status:500,json:{error:'历史读取暂时失败'}});}
    const id=Number(url.pathname.split('/')[3]),data=history(id),pageNumber=Number(url.searchParams.get('page')||1);data.page=pageNumber;data.pageSize=20;data.rows=id===200?records.slice((pageNumber-1)*20,pageNumber*20):[];return route.fulfill({json:data});
   }
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{rows:[]}});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):decodeURIComponent(url.pathname.slice(1));
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/mobile/history');assert.equal(reads.length,0,'history does not load until opened');
  const action=()=>page.getByRole('button',{name:'历史版本',exact:true}),dialog=()=>page.getByRole('dialog',{name:'库存历史版本',exact:true});
  await action().click();await dialog().getByText('当前库存 200',{exact:true}).waitFor();assert.equal(reads.length,1);assert.ok(reads[0].startsWith('/api/products/200/edit-history?'));
  await dialog().getByRole('region',{name:'历史编号和名称'}).getByText('1-1-2',{exact:true}).waitFor();assert.equal(await dialog().getByText('留存时间 2026/11/07 00:01:02',{exact:true}).count(),2);
  await dialog().locator('summary').first().click();await dialog().getByText('旧名称 24',{exact:true}).waitFor();await dialog().getByText('新名称 24',{exact:true}).waitFor();
  assert.equal(await dialog().locator('.inventory-history-version').count(),20);await dialog().getByRole('button',{name:'下一页',exact:true}).click();await dialog().getByText('版本 5',{exact:true}).waitFor();assert.equal(await dialog().locator('.inventory-history-version').count(),5);await dialog().locator('summary').last().click();await dialog().getByText('该条历史快照不完整，无法展示修改前后资料。',{exact:true}).waitFor();
  await dialog().getByRole('button',{name:'上一页',exact:true}).click();await dialog().getByText('版本 25',{exact:true}).waitFor();
  await fs.mkdir('.verification',{recursive:true});
  for(const width of [375,390,430]){
   await page.setViewportSize({width,height:844});if(await dialog().locator('details').first().getAttribute('open')===null)await dialog().locator('summary').first().click();
   assert.equal(await page.evaluate(()=>[document.documentElement,document.body,document.querySelector('.inventory-history'),document.querySelector('.mobile-dialog')].filter(Boolean).every(el=>el.scrollWidth<=el.clientWidth+1)),true);
   const geometry=await dialog().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};});assert.ok(geometry.left>=-1&&geometry.right<=width+1&&geometry.bottom<=845);
   await page.screenshot({path:'.verification/inventory-product-history-'+width+'.png',animations:'disabled'});
  }
  await dialog().getByRole('button',{name:'关闭',exact:true}).click();await dialog().waitFor({state:'hidden'});
  hold=true;await action().click();for(let i=0;i<100&&!releaseHeld;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(releaseHeld);
  await page.evaluate(()=>window.historyProduct(201));await dialog().waitFor({state:'hidden'});releaseHeld();await action().click();await dialog().getByText('当前库存 201',{exact:true}).waitFor();assert.equal(await dialog().getByText('历史错误名称',{exact:true}).count(),0);
  await dialog().getByText('暂无已留存的资料修改版本，历史别名可在上方查看。',{exact:true}).waitFor();await page.evaluate(()=>window.historyScope());await dialog().waitFor({state:'hidden'});
  failNext=true;await action().click();await dialog().getByRole('button',{name:'重试读取',exact:true}).waitFor();await dialog().getByRole('button',{name:'重试读取',exact:true}).click();await dialog().getByText('当前库存 201',{exact:true}).waitFor();
  await dialog().getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>{window.historyProduct(200);window.historyRouter.push('/desktop');});await page.setViewportSize({width:1366,height:900});await action().click();await dialog().getByText('当前库存 200',{exact:true}).waitFor();await dialog().locator('summary').first().click();
  await page.screenshot({path:'.verification/inventory-product-history-desktop.png',animations:'disabled'});assert.equal(await dialog().locator('.inventory-history-version').count(),20);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

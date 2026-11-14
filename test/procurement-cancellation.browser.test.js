import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {PROCUREMENT_CANCELLATION_CAUSES} from '../src/shared/procurement-demand-cancellation.js';

test('reasoned demand cancellation validates sources, retries one immutable operation and records manual handling with optional notes', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'procurement-cancellation-browser-'));let browser,releaseRead;
 const writes=[],unexpectedWrites=[],errors=[];
 const details={product:{id:200,name:'订单采购测试物料'},cancellation_revision:'revision-1',orders:[
  {order_item_id:111,order_id:11,posting_number:'ORDER-A',ozon_name:'待处理配件',shop_name:'测试店铺',shortage_quantity:3,actionable_shortage_quantity:3},
  {order_item_id:112,order_id:12,posting_number:'ORDER-B',ozon_name:'此前已取消配件',shop_name:'测试店铺',shortage_quantity:2,actionable_shortage_quantity:0,cancellation:{quantity:2,event_id:8,cause:'supplier_out_of_stock',note:'此前厂家断货，等待运营处理',person_name:'测试采购员',created_at:'2026-11-05 01:00:00'}}
 ]};
 let failFirst=true,delayRead=false;
 const entry=`import {createApp,h,ref} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Dialog from '/frontend/admin/components/procurement/ProcurementDemandCancellationDialog.vue';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';localStorage.setItem('baodanAuthUser',JSON.stringify({id:7,personId:7,tenant:{id:1,slug:'default'}}));setAuthToken('cancellation-fixture');currentApiCacheScope();window.cancellationChanges=[];createApp({setup(){const visible=ref(false);window.addEventListener('erp:auth-scope-changed',()=>visible.value=false);window.changeCancellationScope=()=>{localStorage.setItem('baodanAuthUser',JSON.stringify({id:8,personId:8,tenant:{id:42,slug:'customer'}}));setAuthToken('other-cancellation-fixture');currentApiCacheScope();};return()=>h('div',[h('button',{onClick:()=>visible.value=true},'处理采购需求'),visible.value&&h(Dialog,{modelValue:true,productId:200,'onUpdate:modelValue':value=>visible.value=value,onChanged:result=>window.cancellationChanges.push(result)})]);}}).use(ElementPlus).mount('#app');`;
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'procurement-cancellation-fixture',resolveId(id){if(id==='virtual:cancellation')return '\0cancellation';},load(id){if(id==='\0cancellation')return entry;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:cancellation',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:8788/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname==='/api/inventory-workflow/demand-details'){
    assert.equal(url.searchParams.get('product_id'),'200');
    if(delayRead)await new Promise(resolve=>{releaseRead=resolve;});
    return route.fulfill({json:details}).catch(()=>{});
   }
   if(url.pathname==='/api/inventory-workflow/cancel-demand'&&route.request().method()==='POST'){
    const body=route.request().postDataJSON();writes.push(body);
    if(failFirst){failFirst=false;return route.fulfill({status:503,json:{error:'采购决定暂未保存，请重试'}});}
    if(body.operation==='cancel'){
     details.orders[0].cancellation={quantity:3,event_id:9,cause:body.cause,note:body.note,created_at:'2026-11-05 02:00:00'};
     details.orders[0].actionable_shortage_quantity=0;details.cancellation_revision='revision-2';
    }else{
     details.orders[1].cancellation=null;details.orders[1].actionable_shortage_quantity=2;details.cancellation_revision='revision-3';
    }
    return route.fulfill({json:{ok:true,operation:body.operation,product_id:200,state:{physical_recorded:0,incoming:0},sources:body.order_item_ids.map(order_item_id=>({order_item_id}))}});
   }
   if(url.pathname.startsWith('/api/')){
    if(!['GET','HEAD'].includes(route.request().method()))unexpectedWrites.push({method:route.request().method(),path:url.pathname});
    return route.fulfill({status:404,json:{error:'Unexpected API request'}});
   }
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/procurement/workspace');
  const open=()=>page.getByRole('button',{name:'处理采购需求',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'取消采购并标记订单',exact:true});
  await open();await dialog.getByText('ORDER-A',{exact:true}).waitFor();
  await dialog.getByText(/测试采购员 · 2026\/11\/05 09:00:00/).waitFor();
  let confirm=dialog.getByRole('button',{name:'确认取消采购并标记订单',exact:true});
  const first=dialog.locator('.el-table__body-wrapper tbody tr').filter({hasText:'ORDER-A'}),prior=dialog.locator('.el-table__body-wrapper tbody tr').filter({hasText:'ORDER-B'});
  assert.equal(await confirm.isDisabled(),true);
  assert.equal(await prior.getByRole('checkbox').isDisabled(),false,'manual handling reason may be updated');
  await first.locator('.el-checkbox').click();assert.equal(await confirm.isDisabled(),true,'a source alone is insufficient');
  assert.equal(await confirm.isDisabled(),true,'a reason is mandatory');
  await dialog.locator('.el-select').click();await page.getByRole('option',{name:PROCUREMENT_CANCELLATION_CAUSES.supplier_out_of_stock,exact:true}).click();
  assert.equal(await confirm.isEnabled(),true);assert.equal(writes.length,0);
  await confirm.click();await dialog.getByRole('button',{name:'重试原操作',exact:true}).waitFor();
  await page.getByText('采购决定暂未保存，请重试',{exact:true}).waitFor();
  assert.equal(writes.length,1);assert.equal(await dialog.getByRole('textbox').isDisabled(),true);
  assert.equal(await dialog.getByRole('button',{name:'刷新明细',exact:true}).isDisabled(),true);
  await dialog.getByRole('button',{name:'重试原操作',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual(writes[0],writes[1],'503 retry retains the exact payload and UUID');
  assert.equal(writes[0].product_id,200);assert.deepEqual(writes[0].order_item_ids,[111]);assert.equal(writes[0].expected_revision,'revision-1');assert.equal(writes[0].cause,'supplier_out_of_stock');assert.equal(writes[0].operation,'cancel');
  assert.match(writes[0].request_key,/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i);
  await open();await dialog.getByText('ORDER-B',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'恢复选中采购',exact:true}).count(),0);
  await prior.locator('.el-checkbox').click();
  await dialog.locator('.el-select').click();await page.getByRole('option',{name:PROCUREMENT_CANCELLATION_CAUSES.no_shipment,exact:true}).click();
  await dialog.getByRole('button',{name:'确认取消采购并标记订单',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(writes[2].operation,'cancel');assert.equal(writes[2].note,'');assert.deepEqual(writes[2].order_item_ids,[112]);

  delayRead=true;const pendingRead=page.waitForRequest(request=>request.url().includes('/demand-details?'));
  await open();await pendingRead;await page.evaluate(()=>window.changeCancellationScope());await dialog.waitFor({state:'hidden'});
  releaseRead?.();releaseRead=null;await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>window.cancellationChanges.length),2,'an old enterprise response cannot reopen or mutate the new scope');
  assert.equal(writes.length,3);assert.deepEqual(unexpectedWrites,[],'no stock, arrival, fulfillment or sales-order cancellation writes');assert.deepEqual(errors,[]);
 }finally{
  releaseRead?.();await browser?.close();assert.equal(path.dirname(output),path.resolve(os.tmpdir()));await fs.rm(output,{recursive:true,force:true});
 }
});

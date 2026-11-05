import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('procurement order collaboration edits one actual order, preserves marks, retries and clears explicitly without leaking scopes',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'procurement-order-notes-'));let browser,releaseRead;
 const writes=[],unexpected=[],errors=[],events=[];
 const details={product:{id:200,name:'门槛条测试'},orders:[
  {order_id:11,order_item_id:111,posting_number:'ORDER-A',shop_name:'A店铺',manual_note:'保留原要求'},
  {order_id:11,order_item_id:112,posting_number:'ORDER-A',shop_name:'A店铺',manual_note:'保留原要求'},
  {order_id:12,order_item_id:113,posting_number:'ORDER-B',shop_name:'B店铺',manual_note:''}
 ]};
 let failFirst=true,delayRead=false;
 const entry=`import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Dialog from '/frontend/admin/components/procurement/ProcurementOrderNotesDialog.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';const user={id:7,personId:7,roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('notes-fixture');currentApiCacheScope();window.noteEvents=[];window.addEventListener('erp:order-collaboration-note-saved',e=>window.noteEvents.push(e.detail));const app=createApp({setup(){const visible=ref(false);window.changeNotesScope=()=>{localStorage.setItem('baodanAuthUser',JSON.stringify({...user,tenant:{id:42,slug:'b'}}));setAuthToken('other-notes-fixture');currentApiCacheScope();};return()=>h('div',[h('button',{onClick:()=>visible.value=true},'编辑关联订单备注'),visible.value&&h(Dialog,{modelValue:true,productId:200,'onUpdate:modelValue':value=>visible.value=value})]);}});app.use(createPinia()).use(ElementPlus);useAuthStore().user=user;app.mount('#app');`;
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'notes-fixture',resolveId(id){if(id==='virtual:notes')return '\0notes';},load(id){if(id==='\0notes')return entry;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:notes',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1450,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8788/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname==='/api/inventory-workflow/demand-details'){
    assert.equal(url.searchParams.get('product_id'),'200');if(delayRead)await new Promise(resolve=>releaseRead=resolve);
    return route.fulfill({json:details}).catch(()=>{});
   }
   if(url.pathname==='/api/inventory-workflow/node-action'&&route.request().method()==='POST'){
    const body=route.request().postDataJSON();writes.push(body);
    if(failFirst){failFirst=false;return route.fulfill({status:503,json:{error:'本次备注暂未保存，请重试'}});}
    for(const row of details.orders)if(row.order_id===body.id)row.manual_note=body.note;
    return route.fulfill({json:{ok:true}});
   }
   if(url.pathname.startsWith('/api/')){unexpected.push(url.pathname);return route.fulfill({status:404,json:{error:'unexpected request'}});}
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/procurement/workspace');
  const open=()=>page.getByRole('button',{name:'编辑关联订单备注',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'关联订单人工备注',exact:true});await open();await dialog.getByText('ORDER-A',{exact:true}).waitFor();
  const rows=dialog.locator('.el-table__body-wrapper tbody tr');assert.equal(await rows.count(),2,'several SKU items in one order share one collaboration note');
  const first=rows.filter({hasText:'ORDER-A'}),other=rows.filter({hasText:'ORDER-B'});
  const input=first.getByRole('textbox',{name:'订单 ORDER-A 人工备注',exact:true});assert.equal(await input.inputValue(),'保留原要求');
  assert.equal(await first.getByRole('button',{name:'保存备注',exact:true}).isDisabled(),true);
  await input.fill('门槛条去掉部分字体\n打包前核对');await first.getByRole('button',{name:'保存备注',exact:true}).click();
  await dialog.getByText('本次备注暂未保存，请重试',{exact:true}).waitFor();assert.equal(await input.inputValue(),'门槛条去掉部分字体\n打包前核对');
  await first.getByRole('button',{name:'保存备注',exact:true}).click();await page.waitForFunction(()=>window.noteEvents.length===1);
  assert.deepEqual(writes[0],writes[1]);assert.equal(writes[1].id,11);assert.equal(writes[1].product_id,200);assert.equal(writes[1].expected_note,'保留原要求');assert.equal(writes[1].preserve_mark,true);assert.equal(writes[1].clear_note,undefined);
  assert.equal(await other.getByRole('textbox').inputValue(),'');assert.equal(details.orders[2].manual_note,'');
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/procurement-order-notes.png',animations:'disabled'});
  await input.fill('');await first.getByRole('button',{name:'清空备注',exact:true}).click();await page.waitForFunction(()=>window.noteEvents.length===2);
  assert.equal(writes[2].clear_note,true);assert.equal(writes[2].expected_note,'门槛条去掉部分字体\n打包前核对');
  assert.equal(writes[2].note,'');events.push(...await page.evaluate(()=>window.noteEvents));assert.deepEqual(events.map(e=>e.orderId),[11,11]);assert.equal(events[0].note,'门槛条去掉部分字体\n打包前核对');assert.equal(events[1].note,'');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'hidden'});
  delayRead=true;const pending=page.waitForRequest(request=>request.url().includes('/demand-details?'));await open();await pending;
  await page.evaluate(()=>window.changeNotesScope());await dialog.waitFor({state:'hidden'});releaseRead?.();releaseRead=null;
  assert.equal(await page.evaluate(()=>window.noteEvents.length),2);assert.equal(writes.length,3);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 }finally{releaseRead?.();await browser?.close();assert.equal(path.dirname(output),path.resolve(os.tmpdir()));await fs.rm(output,{recursive:true,force:true});}
});

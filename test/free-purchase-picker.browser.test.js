import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('free purchase uses a separate precise inventory picker and preserves cross-page additions and entered costs', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'free-purchase-picker-'));let browser;
 const searches=[],purchases=[],products=[{id:501,name:'自主采购物料A',inventory_number:'1-501'},{id:502,name:'自主采购物料B',inventory_number:'1-502'}];
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'free-purchase-picker-fixture',resolveId(id){if(id==='virtual:picker')return '\0picker';},load(id){if(id==='\0picker')return `import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Batch from '/frontend/admin/components/procurement/ProcurementBatchPurchaseDialog.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const pinia=createPinia(),app=createApp({setup(){const visible=ref(false);return()=>h('div',[h('button',{onClick:()=>visible.value=true},'自由采购入口'),visible.value&&h(Batch,{modelValue:visible.value,'onUpdate:modelValue':value=>visible.value=value,freePurchase:true})]);}});app.use(pinia);const auth=useAuthStore();auth.user={id:7,personId:7,tenant:{id:1,slug:'default',role:'owner'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('picker-fixture');app.use(ElementPlus).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:picker',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8788/**',async route=>{
   const url=new URL(route.request().url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname==='/api/people')return json([{id:7,name:'演示采购',active:1}]);
   if(url.pathname==='/api/products'){searches.push(Object.fromEntries(url.searchParams));return json({rows:[products[url.searchParams.get('page')==='2'?1:0]],total:51});}
   if(url.pathname==='/api/inventory-workflow')return json({rows:[{is_bundle:false,components:[products.find(p=>p.id===Number(url.searchParams.get('product_id')))]}]});
   if(url.pathname==='/api/inventory-product-naming/options')return json({rows:[{value:url.searchParams.get('type')==='category'?'盒子':'黑色'}]});
   if(url.pathname==='/api/ai-variant-lab/vehicle-catalog')return json({brands:[]});
   if(url.pathname==='/api/procurement/purchases'){purchases.push(route.request().postDataJSON());return json({ok:true});}
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return json({rows:[]});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html');
  await page.getByRole('button',{name:'自由采购入口',exact:true}).click();
  const form=page.getByRole('dialog',{name:'自由采购',exact:true}),picker=page.getByRole('dialog',{name:'添加库存商品到本次采购单（全部库存）',exact:true});
  await form.waitFor();assert.equal(searches.length,0,'inventory picker mounts only when requested');
  await form.getByRole('button',{name:'＋ 添加库存商品',exact:true}).click();
  await picker.waitFor();await picker.getByText('自主采购物料A',{exact:true}).waitFor();
  await picker.locator('.el-form-item').filter({hasText:'核心品名'}).locator('.el-select').click();await page.getByRole('option',{name:'盒子',exact:true}).click();
  await picker.locator('.el-form-item').filter({hasText:'颜色'}).locator('.el-select').click();await page.getByRole('option',{name:'黑色',exact:true}).click();
  await picker.getByPlaceholder('补充名称关键词').fill('物料');
  await picker.getByRole('button',{name:'查询',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.batch-inventory-picker .el-loading-mask'));
  assert.ok(searches.some(s=>s.inventoryCategory==='盒子'&&s.color==='黑色'&&s.productName==='物料'));
  await picker.locator('.el-table__body-wrapper tbody tr').first().locator('.el-checkbox').click();
  await picker.locator('button.btn-next').click();await picker.getByText('自主采购物料B',{exact:true}).waitFor();
  await picker.locator('.el-table__body-wrapper tbody tr').first().locator('.el-checkbox').click();
  await picker.getByText(/已勾选 2 项/).waitFor();
  await picker.getByRole('button',{name:'批量加入采购表',exact:true}).click();
  await picker.getByText(/采购表已有 2 项/).waitFor();
  await picker.locator('button.btn-prev').click();await picker.getByRole('button',{name:'已加入',exact:true}).waitFor();
  assert.equal(await picker.getByRole('button',{name:'已加入',exact:true}).isDisabled(),true);
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/free-purchase-picker.png',fullPage:true,animations:'disabled'});
  await picker.getByRole('button',{name:'完成添加',exact:true}).click();await picker.waitFor({state:'hidden'});
  const first=form.locator('tr').filter({hasText:'自主采购物料A'}),second=form.locator('tr').filter({hasText:'自主采购物料B'});
  await first.getByRole('spinbutton').nth(0).fill('3');await first.getByRole('spinbutton').nth(1).fill('30');await first.getByRole('spinbutton').nth(2).fill('2');
  await second.getByRole('button',{name:'移除',exact:true}).click();
  await form.getByRole('button',{name:'＋ 添加库存商品',exact:true}).click();await picker.waitFor();
  await picker.locator('button.btn-next').click();await picker.getByText('自主采购物料B',{exact:true}).waitFor();
  await picker.getByRole('button',{name:'加入采购',exact:true}).click();await picker.getByRole('button',{name:'已加入',exact:true}).waitFor();
  await picker.getByRole('button',{name:'完成添加',exact:true}).click();await picker.waitFor({state:'hidden'});
  assert.equal(await first.getByRole('spinbutton').nth(0).inputValue(),'3');assert.equal(Number(await first.getByRole('spinbutton').nth(1).inputValue()),30);assert.equal(Number(await first.getByRole('spinbutton').nth(2).inputValue()),2);
  await second.getByRole('spinbutton').nth(1).fill('20');await second.getByRole('spinbutton').nth(1).press('Tab');
  assert.equal(await form.locator('.el-table__body-wrapper tbody tr').count(),2);
  await page.screenshot({path:'.verification/free-purchase-form.png',fullPage:true,animations:'disabled'});
  await form.getByRole('button',{name:'确认登记采购',exact:true}).click();await form.waitFor({state:'hidden'});
  assert.equal(purchases.length,1);assert.equal(purchases[0].workspace_batch,true);assert.equal(purchases[0].items.length,2);assert.equal(purchases[0].items[0].product_id,501);assert.equal(purchases[0].items[0].quantity,3);assert.equal(purchases[0].items[0].amount,30);assert.equal(purchases[0].items[0].shipping_amount,2);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

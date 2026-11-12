import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('order inventory types remain red bundles, green individual items and neutral unknowns in normal and printed rows',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'order-type-badges-'));let browser;
 const summaries=[
  {productId:10,inventoryNumber:'2-10',inventoryMode:'single',componentCount:2,productName:'标准组合库存',quantity:3,pickingItems:[{product_id:11,inventory_number:'2-11',product_name:'盒子',required_quantity:6},{product_id:12,inventory_number:'2-12',product_name:'配件',required_quantity:3}]},
  {productId:20,inventoryNumber:'2-20',inventoryMode:'single',componentCount:0,productName:'清洁用品 两盒装',quantity:2},
  {productId:30,inventoryNumber:'2-30',productName:'组成资料尚未同步',quantity:1}
 ];
 const rows=[...summaries.map((summary,i)=>({id:i+1,inventorySummaries:[summary]})),{id:4,inventorySummaries:[],procurement_coverage:{items:[{product_id:40,inventory_number:'2-40',product_name:'旧记录库存',quantity:1}]}}].map((row,i)=>({shop_id:1,shop_name:'验证店铺',posting_number:'TYPE-ORDER-'+(i+1),orderTitleParts:[{text:'TYPE-ORDER-'+(i+1)}],quantitySummary:summaries[i]?.quantity||1,statusLabel:'等待发货',productDisplayRows:[],logisticsSummary:i===1?{isFbp:true,deliveryMethodLabel:'FBP',methodLabel:'FBP',warehouse:'珲春仓'}:{deliveryMethodLabel:'FBS',serviceClass:'OGL',transportMode:'陆运'},fulfillment_type_key:i===1?'fbp':'fbs',profitSummary:{},procurementState:{},availableActions:{showPrint:true,print:true},unboundItems:[],cancelCategoryText:'--',cancelReasonText:'--',...row}));
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'order-badge-fixture',resolveId(id){if(id==='virtual:order-badges')return '\0order-badges';},load(id){if(id==='\0order-badges')return `import {createApp,h,ref} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/orders/orders-view.css';import Table from '/frontend/orders/components/OrdersTable.vue';const rows=${JSON.stringify(rows)};createApp({setup(){const printed=ref(false);return()=>h('section',[h('button',{onClick:()=>printed.value=!printed.value},printed.value?'返回普通订单':'查看打印状态'),h('h3',printed.value?'打印状态订单':'普通订单'),h(Table,{rows:rows.map(row=>({...row,printedState:printed.value,printed_at:printed.value?'2026-11-05 08:00:00':null})),tableHeight:850,onPrintOrder:id=>window.lastPrintedOrder=id})]);}}).use(ElementPlus).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:order-badges',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:2100,height:1100}}),requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8788/**',async route=>{
   const url=new URL(route.request().url());if(url.pathname.startsWith('/api/')){requests.push(url.pathname);return route.fulfill({json:{rows:[]}});}
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{font-family:Arial,sans-serif;margin:20px}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html');await page.locator('.inventory-type-badge').first().waitFor();
  const tableRows=page.locator('.el-table__body-wrapper tbody tr');
  async function verify(){
   const bundle=tableRows.nth(0),single=tableRows.nth(1),unknown=tableRows.nth(2),fallback=tableRows.nth(3);
   assert.equal(await bundle.locator('.inventory-type-badge.el-tag--danger').innerText(),'套装');assert.equal(await single.locator('.inventory-type-badge.el-tag--success').innerText(),'单件');assert.equal(await unknown.locator('.inventory-type-badge.el-tag--info').innerText(),'类型待核');assert.equal(await fallback.locator('.inventory-fallback-type.el-tag--info').innerText(),'类型待核');
   assert.equal(await unknown.locator('.el-tag--success').count(),0);assert.equal(await fallback.locator('.el-tag--success').count(),0);
   await bundle.getByText('本单 3 套',{exact:true}).waitFor();await bundle.getByText('× 6 件',{exact:true}).waitFor();await single.getByText('本单 2 件',{exact:true}).waitFor();await single.getByText('仓库: 珲春仓',{exact:true}).waitFor();
   const red=await bundle.locator('.inventory-type-badge').evaluate(node=>getComputedStyle(node).backgroundColor),green=await single.locator('.inventory-type-badge').evaluate(node=>getComputedStyle(node).backgroundColor);assert.notEqual(red,green);assert.notEqual(red,'rgba(0, 0, 0, 0)');
   await page.locator('.el-table__body-wrapper .el-scrollbar__wrap').evaluate(node=>{node.scrollLeft=node.scrollWidth;});await page.waitForTimeout(150);
   await page.locator('.el-table__body-wrapper .el-scrollbar__wrap').evaluate(node=>{node.scrollLeft=0;});await page.waitForTimeout(150);const box=await bundle.locator('.inventory-type-badge').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=2100,'inventory badge remains visible beside its ID when returning to the first columns');
  }
  await verify();await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/order-inventory-types-normal.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'查看打印状态',exact:true}).click();await tableRows.nth(0).getByText('已打印',{exact:true}).waitFor();await verify();await page.screenshot({path:'.verification/order-inventory-types-printed.png',fullPage:true,animations:'disabled'});
  await tableRows.nth(0).getByRole('button',{name:'打印标签',exact:true}).click();assert.equal(await page.evaluate(()=>window.lastPrintedOrder),1);assert.deepEqual(requests,[],'badges do not add per-order API calls');assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

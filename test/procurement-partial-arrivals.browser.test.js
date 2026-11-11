import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {demoUser} from './fixtures/inventory-role-workspace.js';

test('purchase queue records 80 of 600 as arrived, receives only 80, and leaves 520 awaiting delivery',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'partial-arrival-browser-'));let browser,stock=0;
 const requests=[],records=[{id:10,product_id:200,product_name:'600件分批到货物料',inventory_number:'1-200',quantity:600,status:'pending_arrival',received_at:null,updated_at:'2026-11-05 01:00:00',purchased_at:'2026-11-01 01:00:00',order_no:'PO-600',buyer_name:'演示采购',ordered_quantity:600}];
 const project=r=>({...r,components:[{product_id:200,name:r.product_name,inventory_number:r.inventory_number,quantity:r.quantity,per_set_quantity:1,stock_unit:'件'}],affected_bundles:[],review_required:false});
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'partial-arrival-fixture',resolveId(id){if(id==='virtual:partial-arrival')return '\0partial-arrival';},load(id){if(id==='\0partial-arrival')return `import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Queue from '/frontend/admin/components/procurement/InventoryPurchaseBatchQueue.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const pinia=createPinia(),app=createApp({setup(){const status=ref('open');return()=>h('div',[h('button',{onClick:()=>status.value='open'},'采购待到货'),h('button',{onClick:()=>status.value='arrived'},'到货待验收'),h(Queue,{status:status.value,filters:{}})]);}});app.use(pinia);const auth=useAuthStore();auth.user=${JSON.stringify(demoUser)};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('partial-arrival-fixture');app.use(ElementPlus).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:partial-arrival',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8788/**',async route=>{
   const url=new URL(route.request().url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(route.request().method()==='POST'){
    const body=route.request().postDataJSON();requests.push({path:url.pathname,body});
    if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){assert.equal(body.quantity,80);assert.equal(body.expected_quantity,600);const row=records.find(r=>r.id===body.id);records.push({...row,id:11,quantity:row.quantity-body.quantity});row.quantity=body.quantity;row.received_at='2026-11-05 02:00:00';return json({ok:true,quantity:80,remaining_quantity:520,remaining_inbound_id:11});}
    if(url.pathname==='/api/inventory-workflow/receipts/preview')return json({quantity:body.records.reduce((n,r)=>n+r.quantity,0),physical_before:stock,physical_after:stock+body.records.reduce((n,r)=>n+r.quantity,0),available_before:stock,available_after:stock+body.records.reduce((n,r)=>n+r.quantity,0),revision:'receipt-revision'});
    if(url.pathname==='/api/inventory-workflow/receipts'){for(const record of body.records){const row=records.find(r=>r.id===record.id);assert.equal(row.quantity,record.expected_quantity);if(row.quantity>record.quantity)records.push({...row,id:Math.max(...records.map(r=>r.id))+1,quantity:row.quantity-record.quantity,received_at:row.received_at});row.quantity=record.quantity;row.status='approved';stock+=record.quantity;}return json({ok:true});}
    return json({ok:true});
   }
   if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){const pending=records.filter(r=>r.status==='pending_arrival'),rows=pending.filter(r=>url.searchParams.get('status')==='open'?!r.received_at:!!r.received_at);return json({rows:rows.map(project),total:rows.length,summary:{open_quantity:pending.filter(r=>!r.received_at).reduce((n,r)=>n+r.quantity,0),arrived_quantity:pending.filter(r=>r.received_at).reduce((n,r)=>n+r.quantity,0)}});}
   if(url.pathname==='/api/inventory-workflow/receipts/context')return json({rows:records.filter(r=>r.status==='pending_arrival'),physical:stock,available:stock});
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return json({rows:[]});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html');await page.getByRole('button',{name:'确认实物到货',exact:true}).click();
  const arriving=page.getByRole('dialog',{name:'批量确认实物到货',exact:true});await arriving.waitFor();
  await arriving.getByRole('spinbutton',{name:'批次 10 到货数量',exact:true}).fill('80');
  assert.equal(await arriving.locator('.purchase-quantity-difference .el-select').count(),0);
  assert.equal(await arriving.getByRole('textbox',{name:'批次 10 数量差异原因',exact:true}).inputValue(),'');
  assert.equal(await arriving.getByPlaceholder('到货位置或签收说明（选填）').inputValue(),'');
  await arriving.getByText('本次 80 件，剩余 520 件继续采购待到货；采购总数和金额不变。',{exact:true}).waitFor();
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/partial-arrival-80-of-600.png',fullPage:true,animations:'disabled'});
  await arriving.getByRole('button',{name:'确认批量到货',exact:true}).click();await arriving.getByText(/已完成 1 \/ 1 项/).waitFor();
  await arriving.getByRole('columnheader',{name:'本次到货',exact:true}).waitFor();await arriving.getByRole('columnheader',{name:'剩余待到货',exact:true}).waitFor();
  const completed=arriving.locator('.el-table__body-wrapper tbody tr').filter({hasText:'PO-600'});assert.equal(await completed.getByText('80 件',{exact:true}).count(),1);assert.equal(await completed.getByText('520 件',{exact:true}).count(),1);await completed.getByText('已到货待验收',{exact:true}).waitFor();await completed.getByText('继续采购待到货',{exact:true}).waitFor();
  await page.screenshot({path:'.verification/partial-arrival-completion.png',fullPage:true,animations:'disabled'});await arriving.getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal(stock,0);await page.getByRole('button',{name:'到货待验收',exact:true}).click();await page.getByRole('button',{name:'验收入库',exact:true}).click();
  const receiving=page.getByRole('dialog',{name:'登记本次实收',exact:true});await receiving.waitFor();assert.equal(await receiving.getByRole('spinbutton',{name:'批次 10 入库数量',exact:true}).inputValue(),'80');
  await receiving.getByRole('button',{name:'确认数量，查看影响',exact:true}).click();await page.getByRole('dialog',{name:'确认入库影响',exact:true}).getByRole('button',{name:'确认入库',exact:true}).click();
  await page.getByRole('dialog',{name:'确认入库影响',exact:true}).waitFor({state:'hidden'});await page.getByRole('button',{name:'采购待到货',exact:true}).click();
  await page.getByText('520 件',{exact:true}).waitFor();assert.equal(stock,80);assert.equal(records.find(r=>r.id===11).received_at,null);assert.equal(records.find(r=>r.id===11).quantity,520);
  assert.equal(requests.filter(r=>r.path==='/api/inventory-workflow/purchase-arrivals').length,1);assert.equal(requests.find(r=>r.path==='/api/inventory-workflow/receipts').body.records[0].quantity,80);
  // Batch receipt also distinguishes a partial delivery from a mistaken purchase total.
  records.splice(0,records.length,{...records[0],id:12,quantity:600,status:'pending_arrival',received_at:'2026-11-05 02:00:00'});
  await page.getByRole('button',{name:'到货待验收',exact:true}).click();await page.locator('.inventory-batch-queue .el-table__body-wrapper .el-checkbox').click();await page.getByRole('button',{name:'批量验收入库（1）',exact:true}).click();
  const batch=page.getByRole('dialog',{name:'批量登记验收入库',exact:true});await batch.getByRole('spinbutton',{name:'批次 12 实收数量',exact:true}).fill('80');
  await batch.locator('.purchase-quantity-difference .el-select').click();await page.getByRole('option',{name:'原采购总数录错，先更正采购记录',exact:true}).click();
  await batch.getByRole('button',{name:'核对并更正采购记录',exact:true}).waitFor();const receiptCount=requests.filter(r=>r.path==='/api/inventory-workflow/receipts').length;
  await batch.getByRole('button',{name:'核对数量，查看入库影响',exact:true}).click();await batch.getByText('数量不一致时，请选择保留余量继续待处理；采购总数录错请先更正采购记录',{exact:true}).waitFor();assert.equal(requests.filter(r=>r.path==='/api/inventory-workflow/receipts').length,receiptCount);
  await batch.locator('.purchase-quantity-difference .el-select').click();await page.getByRole('option',{name:'分批验收，余量继续待验收',exact:true}).click();await batch.getByRole('button',{name:'核对数量，查看入库影响',exact:true}).click();await batch.getByText('部分入库请填写未收部分的原因',{exact:true}).waitFor();assert.equal(requests.filter(r=>r.path==='/api/inventory-workflow/receipts').length,receiptCount);await batch.getByRole('textbox',{name:'批次 12 数量差异原因',exact:true}).fill('其余520件继续待验收');
  await batch.getByRole('button',{name:'核对数量，查看入库影响',exact:true}).click();await batch.getByRole('button',{name:'确认批量入库',exact:true}).click();await batch.getByText(/已完成 1 \/ 1 项/).waitFor();await batch.getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal(records.find(r=>r.id===13).quantity,520);assert.equal(records.find(r=>r.id===13).received_at,'2026-11-05 02:00:00');assert.equal(stock,160);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

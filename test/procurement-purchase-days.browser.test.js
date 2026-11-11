import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {demoUser} from './fixtures/inventory-role-workspace.js';
import {purchaseQueueDays} from '../frontend/admin/utils/purchase-queue-days.js';
import {shanghaiDateKey} from '../frontend/admin/utils/shanghai-date.js';

test('purchase day tabs retain only unfinished dates with the oldest first',()=>{
 const days=purchaseQueueDays([{date:'2026-01-02',open:2,arrived:1},{date:'2026-11-06',open:3,arrived:4},{date:'2026-11-05',open:2,arrived:0}],{status:'arrived'});
 assert.deepEqual(days.map(day=>[day.date,day.count,day.dayLabel]),[['2026-01-02',1,'2号'],['2026-11-06',4,'6号']]);
 assert.deepEqual(purchaseQueueDays([],{selectedDay:'2025-12-01'}),[]);
});

test('purchase queue switches real date pages, searches across days and confirms arrival without mandatory notes',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'purchase-days-browser-'));let browser;
 const today=shanghaiDateKey(),previous=shanghaiDateKey(new Date(new Date(`${today}T00:00:00+08:00`).getTime()-86400000)),emptyDay=shanghaiDateKey(new Date(new Date(`${today}T00:00:00+08:00`).getTime()-2*86400000));
 const requests=[],writes=[],errors=[];
 const make=(id,day,extra={})=>({id,product_id:200,product_name:`日期物料 ${id}`,inventory_number:'1-3-200',quantity:3,status:'pending_arrival',received_at:null,updated_at:`${day} 01:00:00`,purchased_at:`${day} 01:00:00`,order_no:`PO-${id}`,buyer_name:'演示采购',day,...extra});
 const records=[...Array.from({length:51},(_,i)=>make(i+1,today)),...Array.from({length:21},(_,i)=>make(i+101,previous)),make(901,'2026-01-02',{product_id:901,product_name:'旧日精确物料',inventory_number:'1-3-901',quantity:600,order_no:'HISTORY315',source_bundle_batch:{id:1685,product_id:900,purchase_order_id:6,order_no:'006'}}),make(902,'2026-01-02',{review_required:true,is_bundle:true,quantity:20,product_name:'历史待核套装'}),make(903,today,{received_at:`${today} 02:00:00`})];
 const project=row=>({...row,components:[{product_id:row.product_id,name:row.product_name,inventory_number:row.inventory_number,quantity:row.review_required?row.quantity*2:row.quantity,per_set_quantity:row.review_required?2:1,stock_unit:row.review_required?'个':'件'}],affected_bundles:[]});
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'purchase-days-fixture',resolveId(id){if(id==='virtual:purchase-days')return '\0purchase-days';},load(id){if(id==='\0purchase-days')return `import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Queue from '/frontend/admin/components/procurement/InventoryPurchaseBatchQueue.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const pinia=createPinia(),app=createApp({setup(){const status=ref('open'),filters=ref({});return()=>h('div',[h('label',['精确库存编号',h('input',{'aria-label':'精确库存编号',onInput:e=>filters.value={searchMode:'inventory_id',query:e.target.value}})]),h('button',{onClick:()=>status.value='open'},'采购待到货'),h('button',{onClick:()=>status.value='arrived'},'到货待验收'),h(Queue,{status:status.value,filters:filters.value})]);}});app.use(pinia);const auth=useAuthStore();auth.user=${JSON.stringify(demoUser)};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('purchase-days-fixture');app.use(ElementPlus).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:purchase-days',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(request.method()==='POST'){
    const body=request.postDataJSON();writes.push({path:url.pathname,body});
    assert.equal(url.pathname,'/api/inventory-workflow/purchase-arrivals');assert.ok([1,2,901].includes(body.id));assert.equal(body.quantity,body.id===901?600:3);assert.equal(body.note,'');if(body.id===901)records.find(row=>row.id===901).received_at=new Date().toISOString();return json({ok:true,quantity:body.quantity,remaining_quantity:0});
   }
   if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){
    const query=Object.fromEntries(url.searchParams);requests.push(query);assert.equal(query.day_mode,'pending');
    const filtered=records.filter(row=>(!query.query||row.inventory_number===query.query)&&(!query.start_date||row.day>=query.start_date)&&(!query.end_date||row.day<=query.end_date));
    const days=[...new Set(filtered.map(row=>row.day))].sort().map(date=>{const matching=filtered.filter(row=>row.day===date),open=matching.filter(row=>!row.received_at),arrived=matching.filter(row=>row.received_at);return {date,open:open.length,arrived:arrived.length,total:matching.length,open_quantity:open.reduce((n,r)=>n+r.quantity,0),arrived_quantity:arrived.reduce((n,r)=>n+r.quantity,0)};});
    const selected_day=query.purchase_day==='all'?'all':days.some(day=>day.date===query.purchase_day&&day[query.status]>0)?query.purchase_day:days.find(day=>day[query.status]>0)?.date??'';
    const matching=filtered.filter(row=>(query.status==='open'?!row.received_at:!!row.received_at)&&(selected_day==='all'||row.day===selected_day)),offset=(Number(query.page||1)-1)*Number(query.pageSize||50);
    return json({rows:matching.slice(offset,offset+Number(query.pageSize||50)).map(project),total:matching.length,selected_day,days,summary:{open_batches:filtered.filter(row=>!row.received_at).length,arrived_batches:filtered.filter(row=>row.received_at).length},day_summary:days.find(day=>day.date===selected_day)||{}});
   }
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return json({rows:[]});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html');
  const dayTab=date=>page.getByRole('button',{name:new RegExp(`^采购日期 ${date}，`)}),allTab=page.getByRole('button',{name:/^全部待处理/});
  await dayTab(today).waitFor();
  assert.equal(await dayTab('2026-01-02').getAttribute('aria-pressed'),'true');assert.deepEqual(await page.locator('.batch-month-label').allTextContents(),['2026年1月',today.substring(0,4)+'年'+Number(today.substring(5,7))+'月']);assert.equal(await dayTab(today).locator('span').innerText(),Number(today.substring(8))+'号');await dayTab(today).click();
  assert.equal(await dayTab(today).locator('.batch-day-count.is-recent').innerText(),'51');assert.equal(await dayTab(previous).locator('.batch-day-count.is-recent').innerText(),'21');
  assert.equal(await dayTab('2026-01-02').locator('.batch-day-count.is-overdue').innerText(),'2');assert.equal(await dayTab(emptyDay).count(),0);
  assert.match(await allTab.getAttribute('aria-label'),/74 个批次，其中前天及更早逾期 2 个批次/);assert.equal(await allTab.locator('.batch-day-count.is-overdue').count(),1);
  const badgeShape=await dayTab('2026-01-02').locator('.batch-day-count').evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,color:getComputedStyle(node).color}));assert.equal(badgeShape.width,badgeShape.height);assert.equal(badgeShape.color,'rgb(255, 255, 255)');
  const largeShape=await dayTab(today).locator('.batch-day-count').evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}));assert.ok(largeShape.width>largeShape.height);
  await page.getByText(`${today} · 共 51 个批次 · 本页 50 个批次`,{exact:true}).waitFor();
  assert.equal(requests[0].purchase_day,undefined);
  await page.locator('.el-pagination .el-select').click();await page.getByRole('option').filter({hasText:/^20\s*\//}).click();
  await page.getByText(`${today} · 共 51 个批次 · 本页 20 个批次`,{exact:true}).waitFor();await page.locator('.el-pagination .btn-next').click();
  await page.waitForFunction(()=>document.querySelector('.el-pagination .number.is-active')?.textContent==='2');assert.equal(requests.at(-1).purchase_day,today);assert.equal(requests.at(-1).pageSize,'20');
  await page.locator('.inventory-batch-queue .el-table__body-wrapper .el-checkbox').first().click();await page.getByRole('button',{name:'批量确认实物到货（1）',exact:true}).waitFor();
  await dayTab(previous).click();await page.getByText(`${previous} · 共 21 个批次 · 本页 20 个批次`,{exact:true}).waitFor();assert.equal(await allTab.locator('.batch-day-count.is-overdue').innerText(),'74','selected day and pagination do not hide older pending batches from the summary');
  assert.equal(requests.at(-1).page,'1');assert.equal(await page.getByRole('button',{name:'批量确认实物到货',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:/^全部待处理/}).click();await page.getByText('全部待处理 · 共 74 个批次 · 本页 20 个批次',{exact:true}).waitFor();assert.equal(requests.at(-1).purchase_day,'all');
  // A search resets the chosen day and page so an old matching purchase is immediately visible.
  await page.getByRole('textbox',{name:'精确库存编号',exact:true}).fill('1-3-901');await page.getByText('2026-01-02 · 共 1 个批次 · 本页 1 个批次',{exact:true}).waitFor();assert.equal(requests.at(-1).purchase_day,undefined);assert.equal(requests.at(-1).page,'1');
  await page.getByText('原采购单号 006',{exact:true}).waitFor();await page.getByText('核对生成 HISTORY315',{exact:true}).waitFor();await page.getByText('原批次 #1685 → 当前 #901',{exact:true}).waitFor();
  await page.getByRole('button',{name:'确认实物到货',exact:true}).click();const dialog=page.getByRole('dialog',{name:'批量确认实物到货',exact:true});await dialog.waitFor();
  assert.equal(await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).inputValue(),'600');assert.equal(await dialog.getByPlaceholder('到货位置或签收说明（选填）').inputValue(),'');
  await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).fill('80.5');await dialog.getByRole('button',{name:'确认批量到货',exact:true}).click();await dialog.getByText('本次到货件数须为正整数且不超过待到货件数；采购数录错请先更正采购记录',{exact:true}).waitFor();assert.equal(writes.length,0);
  await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).fill('600');await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).blur();await dialog.getByRole('button',{name:'确认批量到货',exact:true}).click();await dialog.getByText(/已完成 1 \/ 1 项/).waitFor();assert.equal(writes.length,1);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('textbox',{name:'精确库存编号',exact:true}).fill('');await page.getByText('2026-01-02 · 共 1 个批次 · 本页 1 个批次',{exact:true}).waitFor();await dayTab(today).click();await page.getByText(`${today} · 共 51 个批次 · 本页 20 个批次`,{exact:true}).waitFor();
  await page.locator('.inventory-batch-queue .el-table__body-wrapper .el-checkbox').nth(0).click();await page.locator('.inventory-batch-queue .el-table__body-wrapper .el-checkbox').nth(1).click();await page.getByRole('button',{name:'批量确认实物到货（2）',exact:true}).click();
  await dialog.waitFor();await dialog.getByRole('button',{name:'确认批量到货',exact:true}).click();await dialog.getByText(/已完成 2 \/ 2 项/).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(writes.length,3);
  await dayTab('2026-01-02').click();await page.getByRole('button',{name:'核对套装采购内容',exact:true}).waitFor();
  const legacy=page.locator('.el-table__body-wrapper tbody tr').filter({hasText:'历史待核套装'});assert.equal(await legacy.getByRole('checkbox').isDisabled(),true);assert.equal(await legacy.getByRole('button',{name:'确认实物到货',exact:true}).count(),0);
  await legacy.getByText('原登记 20 套',{exact:true}).waitFor();await legacy.getByText('折算 40 个 · 待核',{exact:true}).waitFor();assert.equal(await legacy.getByText('40 个',{exact:true}).count(),0);
  assert.equal(await page.locator('.el-table__body-wrapper tbody tr').filter({hasText:'旧日精确物料'}).count(),0,'completed batch leaves the open queue');
  assert.equal(await page.getByRole('button',{name:'全选本页',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'批量确认实物到货',exact:true}).isDisabled(),true,'unreviewed bundles cannot be selected');
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/purchase-queue-days-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:1366,height:900});await page.screenshot({path:'.verification/purchase-queue-days-laptop.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'到货待验收',exact:true}).click();await page.getByText('2026-01-02 · 共 1 个批次 · 本页 1 个批次',{exact:true}).waitFor();assert.equal(requests.at(-1).purchase_day,undefined);assert.equal(requests.at(-1).status,'arrived');assert.equal(await allTab.locator('.batch-day-count.is-overdue').innerText(),'2');assert.equal(await dayTab(previous).count(),0,'dates with pending work only in the other queue disappear');
  await page.getByRole('button',{name:'采购待到货',exact:true}).click();await page.getByText('2026-01-02 · 共 1 个批次 · 本页 1 个批次',{exact:true}).waitFor();await dayTab(today).click();await page.getByText(`${today} · 共 51 个批次 · 本页 20 个批次`,{exact:true}).waitFor();
  await page.getByRole('button',{name:'全选本页',exact:true}).click();await page.getByRole('button',{name:'批量确认实物到货（20）',exact:true}).waitFor();await page.getByRole('button',{name:'取消本页选择',exact:true}).click();
  await page.getByPlaceholder('采购开始日期').fill('2026-01-01');await page.getByPlaceholder('采购结束日期').fill('2026-01-31');await page.getByPlaceholder('采购结束日期').press('Tab');
  await page.getByText('2026-01-02 · 共 1 个批次 · 本页 1 个批次',{exact:true}).waitFor();assert.equal(requests.at(-1).start_date,'2026-01-01');assert.equal(requests.at(-1).end_date,'2026-01-31');assert.equal(requests.at(-1).purchase_day,undefined);
  assert.equal(await dayTab(today).count(),0);
  await page.getByRole('textbox',{name:'精确库存编号',exact:true}).fill('does-not-exist');await page.getByText('没有待处理日期 · 共 0 个批次 · 本页 0 个批次',{exact:true}).waitFor();assert.equal(await allTab.locator('.batch-day-count.is-empty').innerText(),'0');assert.match(await allTab.getAttribute('aria-label'),/0 个批次.*无需提醒/);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

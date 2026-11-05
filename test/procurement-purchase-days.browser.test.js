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

test('purchase day tabs retain old unfinished days and fill seven Beijing calendar days',()=>{
 const now=new Date('2026-11-05T16:05:00Z');
 const days=purchaseQueueDays([{date:'2026-01-02',open:2,arrived:1},{date:'2026-11-06',open:3,arrived:4}],{now,status:'arrived'});
 assert.equal(days.length,8);assert.equal(days[0].date,'2026-11-06');assert.equal(days[0].count,4);assert.equal(days.at(-1).date,'2026-01-02');assert.equal(days.at(-1).count,1);
 assert.deepEqual(purchaseQueueDays([{date:'2026-01-02',open:2}],{now,startDate:'2026-01-01',endDate:'2026-01-31'}).map(day=>day.date),['2026-01-02']);
 assert.ok(purchaseQueueDays([],{now,selectedDay:'2025-12-01'}).some(day=>day.date==='2025-12-01'&&day.count===0));
});

test('purchase queue switches real date pages, searches across days and confirms arrival without mandatory notes',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'purchase-days-browser-'));let browser;
 const today=shanghaiDateKey(),previous=shanghaiDateKey(new Date(new Date(`${today}T00:00:00+08:00`).getTime()-86400000)),emptyDay=shanghaiDateKey(new Date(new Date(`${today}T00:00:00+08:00`).getTime()-2*86400000));
 const requests=[],writes=[],errors=[];
 const make=(id,day,extra={})=>({id,product_id:200,product_name:`日期物料 ${id}`,inventory_number:'1-3-200',quantity:3,status:'pending_arrival',received_at:null,updated_at:`${day} 01:00:00`,purchased_at:`${day} 01:00:00`,order_no:`PO-${id}`,buyer_name:'演示采购',day,...extra});
 const records=[...Array.from({length:51},(_,i)=>make(i+1,today)),...Array.from({length:21},(_,i)=>make(i+101,previous)),make(901,'2026-01-02',{product_id:901,product_name:'旧日精确物料',inventory_number:'1-3-901',quantity:600}),make(902,'2026-01-02',{review_required:true,is_bundle:true,product_name:'历史待核套装'}),make(903,today,{received_at:`${today} 02:00:00`})];
 const project=row=>({...row,components:[{product_id:row.product_id,name:row.product_name,inventory_number:row.inventory_number,quantity:row.quantity,per_set_quantity:1,stock_unit:'件'}],affected_bundles:[]});
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'purchase-days-fixture',resolveId(id){if(id==='virtual:purchase-days')return '\0purchase-days';},load(id){if(id==='\0purchase-days')return `import {createApp,h,ref} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Queue from '/frontend/admin/components/procurement/InventoryPurchaseBatchQueue.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const pinia=createPinia(),app=createApp({setup(){const status=ref('open'),filters=ref({});return()=>h('div',[h('label',['精确库存编号',h('input',{'aria-label':'精确库存编号',onInput:e=>filters.value={searchMode:'inventory_id',query:e.target.value}})]),h('button',{onClick:()=>status.value='open'},'采购待到货'),h('button',{onClick:()=>status.value='arrived'},'到货待验收'),h(Queue,{status:status.value,filters:filters.value})]);}});app.use(pinia);const auth=useAuthStore();auth.user=${JSON.stringify(demoUser)};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('purchase-days-fixture');app.use(ElementPlus).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:purchase-days',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(request.method()==='POST'){
    const body=request.postDataJSON();writes.push({path:url.pathname,body});
    assert.equal(url.pathname,'/api/inventory-workflow/purchase-arrivals');assert.ok([1,2,901].includes(body.id));assert.equal(body.quantity,body.id===901?600:3);assert.equal(body.note,'');return json({ok:true,quantity:body.quantity,remaining_quantity:0});
   }
   if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){
    const query=Object.fromEntries(url.searchParams);requests.push(query);assert.equal(query.day_mode,'pending');
    const filtered=records.filter(row=>(!query.query||row.inventory_number===query.query)&&(!query.start_date||row.day>=query.start_date)&&(!query.end_date||row.day<=query.end_date));
    const days=[...new Set(filtered.map(row=>row.day))].sort().reverse().map(date=>{const matching=filtered.filter(row=>row.day===date),open=matching.filter(row=>!row.received_at),arrived=matching.filter(row=>row.received_at);return {date,open:open.length,arrived:arrived.length,total:matching.length,open_quantity:open.reduce((n,r)=>n+r.quantity,0),arrived_quantity:arrived.reduce((n,r)=>n+r.quantity,0)};});
    const selected_day=query.purchase_day??days.find(day=>day[query.status]>0)?.date??'';
    const matching=filtered.filter(row=>(query.status==='open'?!row.received_at:!!row.received_at)&&(selected_day==='all'||row.day===selected_day)),offset=(Number(query.page||1)-1)*Number(query.pageSize||50);
    return json({rows:matching.slice(offset,offset+Number(query.pageSize||50)).map(project),total:matching.length,selected_day,days,summary:{open_batches:filtered.filter(row=>!row.received_at).length,arrived_batches:filtered.filter(row=>row.received_at).length},day_summary:days.find(day=>day.date===selected_day)||{}});
   }
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return json({rows:[]});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html');
  await page.getByRole('button',{name:`采购日期 ${today}，51 个批次`,exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:`采购日期 ${today}，51 个批次`,exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByText(`${today} · 共 51 个批次 · 本页 50 个批次`,{exact:true}).waitFor();
  assert.equal(requests[0].purchase_day,undefined);
  await page.locator('.el-pagination .el-select').click();await page.getByRole('option').filter({hasText:/^20\s*\//}).click();
  await page.getByText(`${today} · 共 51 个批次 · 本页 20 个批次`,{exact:true}).waitFor();await page.locator('.el-pagination .btn-next').click();
  await page.waitForFunction(()=>document.querySelector('.el-pagination .number.is-active')?.textContent==='2');assert.equal(requests.at(-1).purchase_day,today);assert.equal(requests.at(-1).pageSize,'20');
  await page.locator('.inventory-batch-queue .el-table__body-wrapper .el-checkbox').first().click();await page.getByRole('button',{name:'批量确认到货（1）',exact:true}).waitFor();
  await page.getByRole('button',{name:`采购日期 ${previous}，21 个批次`,exact:true}).click();await page.getByText(`${previous} · 共 21 个批次 · 本页 20 个批次`,{exact:true}).waitFor();
  assert.equal(requests.at(-1).page,'1');assert.equal(await page.getByRole('button',{name:'批量确认到货',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:`采购日期 ${emptyDay}，0 个批次`,exact:true}).click();await page.getByText(`${emptyDay} · 共 0 个批次 · 本页 0 个批次`,{exact:true}).waitFor();
  await page.getByRole('button',{name:/^全部待处理/}).click();await page.getByText('全部待处理 · 共 74 个批次 · 本页 20 个批次',{exact:true}).waitFor();assert.equal(requests.at(-1).purchase_day,'all');
  // A search resets the chosen day and page so an old matching purchase is immediately visible.
  await page.getByRole('textbox',{name:'精确库存编号',exact:true}).fill('1-3-901');await page.getByText('2026-01-02 · 共 1 个批次 · 本页 1 个批次',{exact:true}).waitFor();assert.equal(requests.at(-1).purchase_day,undefined);assert.equal(requests.at(-1).page,'1');
  await page.getByRole('button',{name:'确认到货',exact:true}).click();const dialog=page.getByRole('dialog',{name:'批量确认采购到货',exact:true});await dialog.waitFor();
  assert.equal(await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).inputValue(),'600');assert.equal(await dialog.getByPlaceholder('到货位置或签收说明（选填）').inputValue(),'');
  await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).fill('80.5');await dialog.getByRole('button',{name:'确认批量到货',exact:true}).click();await dialog.getByText('本次到货件数须为正整数且不超过待到货件数；采购数录错请先更正采购记录',{exact:true}).waitFor();assert.equal(writes.length,0);
  await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).fill('600');await dialog.getByRole('spinbutton',{name:'批次 901 到货数量',exact:true}).blur();await dialog.getByRole('button',{name:'确认批量到货',exact:true}).click();await dialog.getByText(/已完成 1 \/ 1 项/).waitFor();assert.equal(writes.length,1);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('textbox',{name:'精确库存编号',exact:true}).fill('');await page.getByText(`${today} · 共 51 个批次 · 本页 20 个批次`,{exact:true}).waitFor();
  await page.locator('.inventory-batch-queue .el-table__body-wrapper .el-checkbox').nth(0).click();await page.locator('.inventory-batch-queue .el-table__body-wrapper .el-checkbox').nth(1).click();await page.getByRole('button',{name:'批量确认到货（2）',exact:true}).click();
  await dialog.waitFor();await dialog.getByRole('button',{name:'确认批量到货',exact:true}).click();await dialog.getByText(/已完成 2 \/ 2 项/).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(writes.length,3);
  await page.getByRole('button',{name:'采购日期 2026-01-02，2 个批次',exact:true}).click();await page.getByRole('button',{name:'核对套装采购内容',exact:true}).waitFor();
  const legacy=page.locator('.el-table__body-wrapper tbody tr').filter({hasText:'历史待核套装'});assert.equal(await legacy.getByRole('checkbox').isDisabled(),true);assert.equal(await legacy.getByRole('button',{name:'确认到货',exact:true}).count(),0);
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/purchase-queue-days-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:1366,height:900});await page.screenshot({path:'.verification/purchase-queue-days-laptop.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'到货待验收',exact:true}).click();await page.getByText(`${today} · 共 1 个批次 · 本页 1 个批次`,{exact:true}).waitFor();assert.equal(requests.at(-1).purchase_day,undefined);assert.equal(requests.at(-1).status,'arrived');
  await page.getByRole('button',{name:'采购待到货',exact:true}).click();await page.getByText(`${today} · 共 51 个批次 · 本页 20 个批次`,{exact:true}).waitFor();
  await page.getByPlaceholder('采购开始日期').fill('2026-01-01');await page.getByPlaceholder('采购结束日期').fill('2026-01-31');await page.getByPlaceholder('采购结束日期').press('Tab');
  await page.getByText('2026-01-02 · 共 2 个批次 · 本页 2 个批次',{exact:true}).waitFor();assert.equal(requests.at(-1).start_date,'2026-01-01');assert.equal(requests.at(-1).end_date,'2026-01-31');assert.equal(requests.at(-1).purchase_day,undefined);
  assert.equal(await page.getByRole('button',{name:`采购日期 ${today}，0 个批次`,exact:true}).count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

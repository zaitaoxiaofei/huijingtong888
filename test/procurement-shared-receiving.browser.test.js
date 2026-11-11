import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {shanghaiDateKey} from '../frontend/admin/utils/shanghai-date.js';

test('shared receiving keeps warehouse visibility, arrival reminders and physical receipt separate',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'shared-receiving-browser-'));let browser;
 const today=shanghaiDateKey(),old='2026-01-02',errors=[],reads=[],writes=[];let physical=0;
 const make=(id,day,quantity,extra={})=>({id,product_id:id,product_name:`收货物料 ${id}`,inventory_number:`1-3-${id}`,quantity,status:'pending_arrival',received_at:null,arrival_reminder:null,updated_at:`${day} 01:00:00`,purchased_at:`${day} 01:00:00`,order_no:`PO-${id}`,buyer_name:'演示采购',day,...extra});
 const records=[make(11,old,600),make(12,today,80,{received_at:`${today} 02:00:00`}),make(13,old,2,{review_required:true,is_bundle:true,product_name:'历史待核套装'}),make(14,'2025-12-01',3,{status:'approved'})];
 const project=row=>{const matching=records.filter(r=>r.product_id===row.product_id&&r.status==='pending_arrival'),ordered=row.product_id===11?600:row.product_id===12?80:row.quantity;return {...row,purchase_progress:row.review_required?null:{ordered_quantity:ordered,unarrived_quantity:matching.filter(r=>!r.received_at).reduce((n,r)=>n+r.quantity,0),arrived_quantity:matching.filter(r=>r.received_at).reduce((n,r)=>n+r.quantity,0),received_quantity:ordered-matching.reduce((n,r)=>n+r.quantity,0)},components:[{product_id:row.product_id,name:row.product_name,inventory_number:row.inventory_number,quantity:row.quantity,per_set_quantity:1,stock_unit:'件'}],affected_bundles:[]};};
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'shared-receiving-fixture',resolveId(id){if(id==='virtual:shared-receiving')return '\0shared-receiving';},load(id){if(id==='\0shared-receiving')return `import {createApp,h} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Workspace from '/frontend/admin/components/inventory/InventorySupplyWorkspace.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const q=new URLSearchParams(location.search),role=q.get('role')||'procurement',pinia=createPinia(),app=createApp({render:()=>h(Workspace,{entry:'procurement',initialTask:q.get('task')||''})});app.use(pinia);const auth=useAuthStore();auth.user={id:1,personId:1,name:'演示人员',roles:[role],tenant:{id:2,slug:'demo',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('shared-receiving-'+role);app.use(ElementPlus).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:shared-receiving',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1050}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(request.method()==='POST'){
    const body=request.postDataJSON();writes.push({path:url.pathname,body});
    if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){
     const row=records.find(row=>row.id===body.id);assert.equal(body.expected_quantity,row.quantity);assert.ok(body.request_key);
     if(body.operation==='remind'){row.arrival_reminder={id:51,person_id:1,person_name:'演示采购',created_at:`${today} 03:00:00`,note:''};row.updated_at=`${today} 03:00:00`;return json({ok:true});}
     assert.equal(body.quantity,80);assert.equal(body.note,`分批到货，本次 80 件，剩余 520 件继续待到货`);row.quantity-=body.quantity;records.push({...row,id:111,order_no:'PO-111',quantity:body.quantity,received_at:`${today} 04:00:00`});return json({ok:true,quantity:80,remaining_quantity:row.quantity});
    }
    if(url.pathname==='/api/inventory-workflow/receipts/preview'){const quantity=body.records.reduce((sum,r)=>sum+r.quantity,0);return json({quantity,physical_before:physical,physical_after:physical+quantity,available_before:physical,available_after:physical+quantity,revision:'receipt-v1'});}
    if(url.pathname==='/api/inventory-workflow/receipts'){for(const received of body.records){const row=records.find(row=>row.id===received.id);assert.equal(received.expected_quantity,row.quantity);physical+=received.quantity;row.quantity-=received.quantity;if(!row.quantity)row.status='approved';}return json({ok:true});}
    return json({error:'unexpected mutation'});
   }
   if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){
    const query=Object.fromEntries(url.searchParams);reads.push(query);
    const pending=records.filter(row=>row.status==='pending_arrival'),days=[...new Set(pending.map(row=>row.day))].sort().map(date=>{const rows=pending.filter(row=>row.day===date);return {date,pending:rows.length,open:rows.filter(row=>!row.received_at).length,reminded:rows.filter(row=>!row.received_at&&row.arrival_reminder).length,arrived:rows.filter(row=>row.received_at).length};});
    const summary={pending:pending.length,open:pending.filter(row=>!row.received_at).length,reminded:pending.filter(row=>!row.received_at&&row.arrival_reminder).length,arrived:pending.filter(row=>row.received_at).length};
    if(query.summary_only)return json({rows:[],summary});
    const status=query.status||'pending',selected_day=query.purchase_day==='all'?'all':days.some(day=>day.date===query.purchase_day&&day[status]>0)?query.purchase_day:days.find(day=>day[status]>0)?.date??'';
    const rows=pending.filter(row=>(status==='pending'||status==='arrived'&&row.received_at||status==='open'&&!row.received_at||status==='reminded'&&!row.received_at&&row.arrival_reminder)&&(selected_day==='all'||row.day===selected_day));
    return json({rows:rows.map(project),total:rows.length,days,selected_day,summary,page:1});
   }
   if(url.pathname==='/api/inventory-workflow/receipts/context'){const id=Number(url.searchParams.get('product_id'));return json({rows:records.filter(row=>row.product_id===id&&row.status==='pending_arrival').map(project),physical,available:physical});}
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return json({rows:[],total:0});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  const row=id=>page.locator('.inventory-batch-queue .el-table__body-wrapper tbody tr').filter({has:page.getByText(`PO-${id}`,{exact:true})});
  await page.goto('http://localhost:8788/admin.html?role=procurement&task=incoming');
  await page.locator('[data-task="receiving"]').waitFor();assert.equal(await page.locator('[data-task="incoming"]').count(),0);assert.equal(reads.filter(r=>!r.summary_only).at(-1).status,'pending');
  await row(11).getByRole('button',{name:'提醒到货',exact:true}).click();await row(11).getByRole('button',{name:'已提醒到货',exact:true}).waitFor();assert.equal(records[0].received_at,null);assert.equal(records[0].quantity,600);assert.equal(physical,0);assert.equal(writes.length,1);await row(11).getByText('物流提示，实物尚待核实',{exact:true}).waitFor();
  assert.equal(await row(11).getByRole('button',{name:'验收入库',exact:true}).count(),0,'purchase role cannot receive stock');
  await page.locator('.batch-status-filter .el-radio-button').filter({hasText:'已提醒到货'}).click();await row(13).waitFor({state:'hidden'});await row(11).waitFor();assert.equal(reads.filter(r=>!r.summary_only).at(-1).status,'reminded');assert.equal(await row(13).count(),0);
  await row(11).getByRole('button',{name:'确认实物到货',exact:true}).click();const arrival=page.getByRole('dialog',{name:'批量确认实物到货',exact:true});await arrival.waitFor();await arrival.getByRole('spinbutton',{name:'批次 11 到货数量',exact:true}).fill('80');await arrival.getByRole('spinbutton',{name:'批次 11 到货数量',exact:true}).blur();await arrival.getByRole('button',{name:'确认批量到货',exact:true}).click();await arrival.getByText(/已完成 1 \/ 1 项/).waitFor();await arrival.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(records[0].quantity,520);assert.equal(physical,0);
  await page.goto('http://localhost:8788/admin.html?role=packing');
  await row(11).waitFor();assert.equal(reads.filter(r=>!r.summary_only).at(-1).status,'pending');assert.equal(await page.locator('[data-task="required"]').count(),0,'warehouse defaults to shared receipt instead of purchase demand');assert.equal(await row(11).getByRole('button',{name:'提醒到货',exact:true}).count(),0);await row(11).getByRole('button',{name:'确认实物到货',exact:true}).waitFor();
  await page.getByRole('button',{name:/^全部待处理/}).click();await row(12).waitFor();await row(111).waitFor();
  const oldTab=page.getByRole('button',{name:new RegExp(`^采购日期 ${old}，`)}),todayTab=page.getByRole('button',{name:new RegExp(`^采购日期 ${today}，`)});assert.equal(await oldTab.locator('.is-overdue').count(),1);assert.equal(await todayTab.locator('.is-recent').count(),1);assert.equal(await page.getByRole('button',{name:/^采购日期 2025-12-01，/}).count(),0);
  await page.getByRole('button',{name:'全选本页',exact:true}).click();await page.getByRole('button',{name:'批量确认实物到货（1）',exact:true}).waitFor();await page.getByRole('button',{name:'批量验收入库（3）',exact:true}).waitFor();assert.equal(await row(13).getByRole('checkbox').isDisabled(),true);await page.getByRole('button',{name:'取消本页选择',exact:true}).click();
  await row(11).getByRole('button',{name:'验收入库',exact:true}).click();const receipt=page.getByRole('dialog',{name:/登记本次实收|确认入库影响/});await receipt.waitFor();await receipt.getByRole('spinbutton',{name:'批次 11 入库数量',exact:true}).fill('80');await receipt.getByRole('spinbutton',{name:'批次 11 入库数量',exact:true}).blur();await receipt.locator('.purchase-quantity-difference .el-select').click();await page.getByRole('option',{name:'分批到货，余量继续待到货',exact:true}).click();await receipt.getByRole('textbox',{name:'批次 11 数量差异原因',exact:true}).fill('本次收到80');await receipt.getByRole('button',{name:'确认数量，查看影响',exact:true}).click();await receipt.getByRole('button',{name:'确认入库',exact:true}).click();await receipt.waitFor({state:'hidden'});assert.equal(physical,80);assert.equal(records[0].quantity,440);assert.equal(records[0].received_at,null,'unreceived residual remains pending arrival');
  await row(11).getByText('总采购 600',{exact:true}).waitFor();await row(11).getByText('已入库 80',{exact:true}).waitFor();assert.equal(await row(13).locator('.batch-purchase-progress').count(),0,'legacy unknown purchase totals are not guessed');
  await row(12).getByRole('button',{name:'验收入库',exact:true}).click();await receipt.waitFor();await receipt.getByRole('button',{name:'确认数量，查看影响',exact:true}).click();await receipt.getByRole('button',{name:'确认入库',exact:true}).click();await receipt.waitFor({state:'hidden'});await todayTab.waitFor({state:'hidden'});assert.equal(physical,160);assert.equal(records.find(r=>r.id===12).status,'approved');
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/procurement-shared-receiving-desktop.png',fullPage:true,animations:'disabled'});assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

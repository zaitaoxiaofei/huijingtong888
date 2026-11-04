import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
import {withOglDispatch} from '../src/services/ogl-dispatch-state.js';
import {PDFDocument} from 'pdf-lib';
import {orderStateKey} from '../frontend/orders/constants/orders-ui.js';

test('printing a previously bound order keeps its working row and actual handover overlaps waiting until transit',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const now=new Date().toISOString();
 const base={shop_id:1,shop_name:'验证店铺',status:'awaiting_deliver',ordered_at:now,item_count:1,skus:'SKU-DEMO',sku_names:'SKU-DEMO:演示配件',sku_quantities:'SKU-DEMO:1',revenue:30,estimated_profit:5,order_details_loaded:true,fulfillment_type_key:'fbs',logistics_carrier:'ogl',logistics_carrier_label:'OGL',ozon_available_actions:['label_download_small'],availableActions:{print:true}};
 const member={batch_id:10,official_carriage_id:'901',official_member:1,default_shop_id:1,batch_status:'preparing',official_status:'observed'};
 const doc=await PDFDocument.create();doc.addPage([200,300]);const pdf=Buffer.from(await doc.save());
 const rows=[withOglDispatch({...base,id:1,posting_number:'UNPRINTED-OFFICIAL',printed_at:null},member),withOglDispatch({...base,id:2,posting_number:'PRINTED-BOUND',printed_at:now},member),withOglDispatch({...base,id:3,posting_number:'ACTUALLY-DISPATCHED'}, {...member,dispatched_at:now})];
 const server=await startPagedWorkspacePreview({host:'::1',stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders/package-label'){res.setHeader('content-type','application/pdf');res.setHeader('X-Ozon-Label-Printed-Ids',encodeURIComponent('[1]'));res.end(pdf);return true;}
  if(url.pathname==='/api/orders/package-label-printed'){rows[0]=withOglDispatch({...rows[0],printed_at:now},member);send({ok:true,print_batch_id:'fixture-print-1'});return true;}
  if(url.pathname==='/api/orders'){
   const status=url.searchParams.get('status'),selected=rows.filter(row=>!status||status==='all'||orderStateKey(row)===status||(status==='awaiting_deliver'&&orderStateKey(row)==='ogl_dispatched'));
   send({rows:selected,total:selected.length,page:1,pageSize:30,counts:{all:3,awaiting_deliver:3,ogl_bound:1,ogl_dispatched:1}});return true;
  }
  return false;
 }});
 const script=`const task=await taskSpace('ogl-waiting-stability-20261104');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://[::1]:8788/admin.html?unprintedqa='+Date.now()+'#/orders');await page.waitForSelector('.orders-status-item');console.log(await page.snapshot());
 await page.click('.orders-status-item:has-text("等待发运")');await page.waitForFunction(()=>{const rows=document.querySelectorAll('.orders-table .el-table__body tbody tr');return rows.length===3&&rows[0].textContent.includes('UNPRINTED-OFFICIAL');});
 await page.evaluate(()=>{const row=document.querySelector('.orders-table .el-table__body tbody tr');for(const label of ['等待发运','已加入发运单 · 待打印','剩余','运货单 901'])if(!row.textContent.includes(label))throw Error('Missing '+label);const print=[...row.querySelectorAll('button')].find(n=>n.textContent.includes('打印标签'));if(!print||print.disabled)throw Error('Printing unavailable');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});
 console.log(await page.snapshot());await page.screenshot({path:'/private/tmp/ogl-unprinted-waiting.png'});
 await page.evaluate(()=>{if([...document.querySelectorAll('.orders-status-item')].some(n=>n.textContent.includes('已绑定待交运')))throw Error('Obsolete tab remains');window.beforePrintOrder=[...document.querySelectorAll('.orders-table .el-table__body tbody tr')].map(n=>n.querySelector('.order-posting-link')?.textContent||n.textContent.match(/UNPRINTED-OFFICIAL|PRINTED-BOUND|ACTUALLY-DISPATCHED/)[0]);});
 await page.click('.orders-table tbody tr:first-child button:has-text("打印标签")');await page.waitForSelector('.order-print-review');console.log(await page.snapshot());
 const popupPromise=page.waitForEvent('popup');await page.click('button:has-text("确认打印 1 单")');const preview=await popupPromise;await preview.waitForSelector('#printNow');console.log(await preview.snapshot());
 await preview.evaluate(()=>{document.getElementById('labelFrame').contentWindow.print=()=>{};});await preview.click('#printNow');await preview.waitForSelector('#printResultMask.visible');await preview.click('#printCompleted');
 await page.waitForFunction(()=>!document.querySelector('.order-print-review'));await page.waitForFunction(()=>{const row=document.querySelector('.orders-table .el-table__body tbody tr');return row.textContent.includes('UNPRINTED-OFFICIAL')&&row.textContent.includes('已绑定发运单 · 未交运');});
 await page.evaluate(()=>{const rows=[...document.querySelectorAll('.orders-table .el-table__body tbody tr')];if(rows.length!==3||JSON.stringify(rows.map(n=>n.querySelector('.order-posting-link')?.textContent||n.textContent.match(/UNPRINTED-OFFICIAL|PRINTED-BOUND|ACTUALLY-DISPATCHED/)[0]))!==JSON.stringify(window.beforePrintOrder))throw Error('Print changed row membership or order');if(!rows[0].textContent.includes('等待发运'))throw Error('Print incorrectly claims handover');});
 await page.screenshot({path:'/private/tmp/ogl-waiting-after-print.png'});
 await page.click('.orders-table tbody tr:first-child button:has-text("打印标签")');await page.waitForSelector('.order-print-review');await page.waitForFunction(()=>document.querySelector('.order-print-review').textContent.includes('将打印 0 单'));await page.click('.order-print-review .el-checkbox');await page.waitForFunction(()=>document.querySelector('.order-print-review').textContent.includes('将打印 1 单'));await page.click('text="返回选择"');
 await page.click('.orders-status-item:has-text("已交运待上网")');await page.waitForFunction(()=>{const rows=document.querySelectorAll('.orders-table .el-table__body tbody tr');return rows.length===1&&rows[0].textContent.includes('ACTUALLY-DISPATCHED');});
 await page.click('.orders-status-item:has-text("等待发运")');await page.waitForFunction(()=>document.querySelectorAll('.orders-table .el-table__body tbody tr').length===3);
 console.log('OGL_UNPRINTED_WAITING_OK');await task.finish({keep:[]});`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/ogl-unprinted-browser.log',stdout+stderr);assert.match(stdout+stderr,/OGL_UNPRINTED_WAITING_OK/);}
 finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

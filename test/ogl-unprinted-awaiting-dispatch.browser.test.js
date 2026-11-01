import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
import {withOglDispatch} from '../src/services/ogl-dispatch-state.js';
import {orderStateKey} from '../frontend/orders/constants/orders-ui.js';

test('officially included unprinted order stays waiting with countdown and printing, outside bound queue',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const now=new Date().toISOString();
 const base={shop_id:1,shop_name:'验证店铺',status:'awaiting_deliver',ordered_at:now,item_count:1,skus:'SKU-DEMO',sku_names:'SKU-DEMO:演示配件',sku_quantities:'SKU-DEMO:1',revenue:30,estimated_profit:5,order_details_loaded:true,fulfillment_type_key:'fbs',logistics_carrier:'ogl',logistics_carrier_label:'OGL',availableActions:{print:true}};
 const member={batch_id:10,official_carriage_id:'901',official_member:1,default_shop_id:1,batch_status:'preparing',official_status:'observed'};
 const rows=[withOglDispatch({...base,id:1,posting_number:'UNPRINTED-OFFICIAL',printed_at:null},member),withOglDispatch({...base,id:2,posting_number:'PRINTED-BOUND',printed_at:now},member),withOglDispatch({...base,id:3,posting_number:'ACTUALLY-DISPATCHED'}, {...member,dispatched_at:now})];
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders'){
   const status=url.searchParams.get('status'),selected=rows.filter(row=>!status||status==='all'||orderStateKey(row)===status);
   send({rows:selected,total:selected.length,page:1,pageSize:30,counts:{all:3,awaiting_deliver:1,ogl_bound:1,ogl_dispatched:1}});return true;
  }
  return false;
 }});
 const script=`const task=await taskSpace('ogl-unprinted-waiting-20261101');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html?unprintedqa='+Date.now()+'#/orders');await page.waitForSelector('.orders-status-item');console.log(await page.snapshot());
 await page.click('.orders-status-item:has-text("等待发运")');await page.waitForFunction(()=>{const rows=document.querySelectorAll('.orders-table .el-table__body tbody tr');return rows.length===1&&rows[0].textContent.includes('UNPRINTED-OFFICIAL');});
 await page.evaluate(()=>{const row=document.querySelector('.orders-table .el-table__body tbody tr');for(const label of ['等待发运','已加入发运单 · 待打印','剩余','运货单 901'])if(!row.textContent.includes(label))throw Error('Missing '+label);const print=[...row.querySelectorAll('button')].find(n=>n.textContent.includes('打印标签'));if(!print||print.disabled)throw Error('Printing unavailable');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});
 console.log(await page.snapshot());await page.screenshot({path:'/private/tmp/ogl-unprinted-waiting.png'});
 await page.click('.orders-status-item:has-text("已绑定待交运")');await page.waitForFunction(()=>{const rows=document.querySelectorAll('.orders-table .el-table__body tbody tr');return rows.length===1&&rows[0].textContent.includes('PRINTED-BOUND')&&!rows[0].textContent.includes('UNPRINTED-OFFICIAL');});
 console.log('OGL_UNPRINTED_WAITING_OK');await task.finish({keep:[]});`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/ogl-unprinted-browser.log',stdout+stderr);assert.match(stdout+stderr,/OGL_UNPRINTED_WAITING_OK/);}
 finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

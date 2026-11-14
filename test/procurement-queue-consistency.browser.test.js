import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
import {demoRows} from './fixtures/inventory-role-workspace.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';

test('required page visibly retains cancelled shortages beside active demand with no automatic business writes',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
 const row=structuredClone(demoRows[0]);
 row.product_id=491;row.product_name='雨刮垫 通用 黑 扇贝形';row.inventory_number='11-1-4';
 row.workflow.supply_plan={...row.workflow.supply_plan,known:true,order_quantity:1,required_purchase:0,required_fbs:0,required_fbp:0,optional_purchase:0,cancelled_fbs:1,raw_required_fbs:1,unresolved_fbs:1};
 row.workflow.physical_recorded=0;row.workflow.physical=0;row.workflow.incoming=0;
 row.workflow.demands=row.workflow.demands.map(d=>({...d,physical_gap:d.key==='real_order'?1:0,purchase_quantity:0,required_purchase_quantity:0,optional_purchase_quantity:0,submitted_quantity:0}));
 const all=[row,structuredClone(demoRows[0])],writes=[];
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/inventory-workflow/alerts'){
   send({...inventoryWorkspacePage(all,Object.fromEntries(url.searchParams)),snapshot:{available:true,status:'ready',stale:false,refreshing:false,calculated_at:new Date().toISOString()}});return true;
  }
  if(req.method!=='GET'){writes.push(req.url);res.statusCode=405;send({error:'Test rejects business writes'});return true;}
 }});
 const screenshot=path.resolve('.verification/procurement-required-cancelled.png');
 const script=`const task=await taskSpace('procurement-queue-consistency-20261114');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html#/procurement/workspace');await page.waitForSelector('.supply-cancelled-warning');
 const state=await page.evaluate(()=>({text:document.querySelector('.supply-workspace').innerText,warning:document.querySelector('.supply-cancelled-warning').innerText,errors:window.layoutErrors}));
 if(!state.text.includes('雨刮垫 通用 黑 扇贝形')||!state.warning.includes('已取消采购 1 件')||!state.warning.includes('订单仍缺货')||state.errors.length)throw Error(JSON.stringify(state));
 console.log(await page.snapshot());console.log({screenshot:await page.screenshot({path:${JSON.stringify(screenshot)}})});console.log('PROCUREMENT_CONSISTENCY_OK');await task.finish({keep:[]});`;
 try{
  await fs.mkdir('.verification',{recursive:true});
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});run.child.stdin.end();
  const {stdout,stderr}=await run;await fs.writeFile('.verification/procurement-queue-browser.log',stdout+stderr);
  assert.match(stdout+stderr,/PROCUREMENT_CONSISTENCY_OK/);assert.deepEqual(writes,[]);
 }finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

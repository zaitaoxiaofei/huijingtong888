import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
import {withOglDispatch} from '../src/services/ogl-dispatch-state.js';
import {orderStateKey} from '../frontend/orders/constants/orders-ui.js';

test('printed marked order stays waiting until selecting no mark; note remains and the bound queue refreshes',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 let mark='follow',note='待确认备注';const writes=[],now=new Date().toISOString();
 const base={id:1,shop_id:1,shop_name:'验证店铺',posting_number:'MARKED-PRINTED',status:'awaiting_deliver',ordered_at:now,printed_at:now,item_count:1,skus:'DEMO',sku_names:'DEMO:演示配件',sku_quantities:'DEMO:1',order_details_loaded:true,fulfillment_type_key:'fbs',logistics_carrier:'ogl',availableActions:{print:true}};
 const member={batch_id:10,official_carriage_id:'901',official_member:1,default_shop_id:1,batch_status:'preparing',official_status:'observed'};
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders/1/mark'&&req.method==='PUT'){
   let body='';req.on('data',c=>body+=c);req.on('end',()=>{const value=JSON.parse(body);writes.push(value);mark=value.mark_type;note=value.note;send({ok:true,id:1,...value});});return true;
  }
  if(url.pathname==='/api/orders'){
   const row=withOglDispatch({...base,mark_type:mark,mark_note:note},member),status=url.searchParams.get('status');const selected=status==='all'||orderStateKey(row)===status?[row]:[];
   send({rows:selected,total:selected.length,page:1,pageSize:30,counts:{all:1,awaiting_packaging:0,awaiting_deliver:mark?1:0,ogl_bound:mark?0:1}});return true;
  }
  return false;
 }});
 const script=`const task=await taskSpace('marked-orders-hold-20261101');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html?markholdqa='+Date.now()+'#/orders');await page.waitForSelector('.orders-status-item');console.log(await page.snapshot());
 await page.click('.orders-status-item:has-text("等待发运")');await page.waitForSelector('.orders-mark-pill');await page.waitForFunction(()=>document.querySelector('.orders-table')?.textContent.includes('人工标记待处理'));
 await page.evaluate(()=>{const row=document.querySelector('.orders-table .el-table__body tbody tr');for(const value of ['已打印','等待发运','人工标记待处理','剩余'])if(!row.textContent.includes(value))throw Error('Missing '+value);});console.log(await page.snapshot());
 await page.click('.orders-mark-pill');await page.waitForSelector('.orders-mark-menu-item');console.log(await page.snapshot());
 await page.click('.orders-mark-menu-item:has-text("无标记")');await page.waitForSelector('.el-message-box');await page.click('.el-message-box button:has-text("保存")');await page.waitForFunction(()=>document.querySelector('.orders-table')?.textContent.includes('当前筛选下暂无订单'));
 await page.click('.orders-status-item:has-text("已绑定待交运")');await page.waitForFunction(()=>{const row=document.querySelector('.orders-table .el-table__body tbody tr');return row?.textContent.includes('MARKED-PRINTED')&&!row.textContent.includes('人工标记待处理');});
 await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});console.log('ORDER_MARK_HOLD_OK');await task.finish({keep:[]});`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/order-dispatch-hold-browser.log',stdout+stderr);assert.match(stdout+stderr,/ORDER_MARK_HOLD_OK/);assert.deepEqual(writes,[{mark_type:'',note:'待确认备注'}]);}
 finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

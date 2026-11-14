import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
import {demoRows} from './fixtures/inventory-role-workspace.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';

test('reason-only cancellation moves both procurement and order displays to manual handling',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
 const row=structuredClone(demoRows[0]);
 row.product_id=491;row.product_name='雨刮垫 通用 黑 扇贝形';row.inventory_number='11-1-4';
 row.workflow.supply_plan={...row.workflow.supply_plan,known:true,order_quantity:1,required_purchase:1,required_fbs:1,required_fbp:0,optional_purchase:0,cancelled_fbs:0};
 row.workflow.physical_recorded=0;row.workflow.physical=0;row.workflow.incoming=0;
 row.workflow.demands=row.workflow.demands.map(d=>({...d,physical_gap:d.key==='real_order'?1:0,purchase_quantity:d.key==='real_order'?1:0,required_purchase_quantity:d.key==='real_order'?1:0,optional_purchase_quantity:0,submitted_quantity:0}));
 const all=[row],writes=[];
 const order={id:11,posting_number:'LINKED-ORDER-1',shop_id:1,shop_name:'验证店铺',status:'awaiting_packaging',ordered_at:'2026-11-14T01:00:00Z',revenue:50,item_count:1,product_names:row.product_name,skus:'SKU-491',sku_quantities:'SKU-491:1',sku_product_ids:'SKU-491:491',sku_inventory_names:'SKU-491:雨刮垫',sku_inventory_numbers:'SKU-491:11-1-4',sku_inventory_modes:'SKU-491:single',sku_component_counts:'SKU-491:0',product_ids:'491',mark_type:'',mark_note:'',procurement_coverage:{order_id:11,needs_fulfillment:true,stock_location:'LOCAL',shortage_quantity:1,actionable_shortage_quantity:1,cancelled_purchase_quantity:0,items:[{order_item_id:11,product_id:491,product_name:row.product_name,quantity:1,shortage_quantity:1,stock_quantity:0,incoming_quantity:0}]}};
 const details={product:{id:491,name:row.product_name},cancellation_revision:'revision-1',orders:[{order_id:11,order_item_id:11,posting_number:order.posting_number,shop_name:order.shop_name,ozon_name:row.product_name,shortage_quantity:1,actionable_shortage_quantity:1,mark_type:'',mark_note:''}]};
 const server=await startPagedWorkspacePreview({stableDeps:true,productionBuild:true,apiHandler(req,res,url,send){

  if(url.pathname==='/api/inventory-workflow/alerts'){send({...inventoryWorkspacePage(all,Object.fromEntries(url.searchParams)),snapshot:{available:true,status:'ready',stale:false,refreshing:false,calculated_at:new Date().toISOString()}});return true;}
  if(url.pathname==='/api/inventory-workflow'){send({rows:[{...row.workflow,product_id:491}]});return true;}
  if(url.pathname==='/api/inventory-workflow/demand-details'){send(details);return true;}
  if(url.pathname==='/api/inventory-workflow/cancel-demand'&&req.method==='POST'){
   let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{const body=JSON.parse(text);writes.push(body);
    row.workflow.calculated_at=new Date().toISOString();
    Object.assign(row.workflow.supply_plan,{required_purchase:0,required_fbs:0,cancelled_fbs:1,raw_required_fbs:1});
    Object.assign(order,{mark_type:'follow',mark_note:'取消采购：不发货'});
    Object.assign(order.procurement_coverage,{cancelled_purchase_quantity:1,actionable_shortage_quantity:0,procurement_manually_handled:true});
    send({ok:true,event_id:99,product_id:491,operation:'cancel',state:{...row.workflow,product_id:491}});
   });return true;
  }
  if(url.pathname==='/api/orders'){const rows=url.searchParams.get('status')==='pending_purchase'&&writes.length?[]:[order];send({rows,total:rows.length,page:1,pageSize:30,counts:{all:1,pending_purchase:writes.length?0:1}});return true;}
  if(req.method!=='GET'){res.statusCode=405;send({error:'Unexpected business mutation'});return true;}
 }});
 const screenshot=path.resolve('.verification/procurement-manual-handling.png');
 const script=`const task=await taskSpace('procurement-manual-handling-20261114');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html?manual=${Date.now()}#/procurement/workspace');await page.waitForSelector('text="雨刮垫 通用 黑 扇贝形"');
 await page.click('loc=role:button[name="取消采购"]');
 await page.waitForSelector('.el-dialog');
 await page.click('.el-dialog .el-table__body-wrapper .el-checkbox');await page.click('.el-dialog .el-select');await page.click('loc=role:option[name="不发货"]');
 await page.click('loc=role:button[name="确认取消采购并标记订单"]');
 await page.waitForFunction(()=>!document.querySelector('.supply-workspace .el-table__body-wrapper')?.innerText.includes('雨刮垫 通用 黑 扇贝形'));
 await page.click('.supply-context-actions .el-dropdown');await page.click('loc=role:menuitem[name*="人工处理记录"]');await page.waitForSelector('.supply-cancelled-warning');
 const state=await page.evaluate(()=>({text:document.querySelector('.supply-workspace').innerText,errors:window.layoutErrors}));
 if(!state.text.includes('已转订单人工处理')||state.text.includes('恢复采购')||state.errors.length)throw Error(JSON.stringify(state));
 console.log(await page.snapshot());console.log({screenshot:await page.screenshot({path:${JSON.stringify(screenshot)}})});
 await page.evaluate(()=>window.layoutRouter.push('/orders'));await page.waitForFunction(()=>document.body.innerText.includes('LINKED-ORDER-1')&&document.body.innerText.includes('取消采购：不发货')&&document.body.innerText.includes('已人工处理'));
 const orderState=await page.evaluate(()=>({text:document.body.innerText,errors:window.layoutErrors}));if(!orderState.text.includes('已人工处理')||orderState.errors.length)throw Error(JSON.stringify(orderState));
 console.log('PROCUREMENT_MANUAL_OK');await task.finish({keep:[]});`;
 try{
  await fs.mkdir('.verification',{recursive:true});
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});run.child.stdin.end();
  const {stdout,stderr}=await run;await fs.writeFile('.verification/procurement-manual-browser.log',stdout+stderr);
  assert.match(stdout+stderr,/PROCUREMENT_MANUAL_OK/);assert.equal(writes.length,1);assert.equal(writes[0].note,'');assert.equal(writes[0].cause,'no_shipment');assert.equal(writes[0].operation,'cancel');
 }finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

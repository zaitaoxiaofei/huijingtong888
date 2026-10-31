import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';

// Real order page and real OGL drawers; all API traffic terminates in fixtures.
test('OGL printed-order composer preserves cross-page selections, reviews and nested navigation', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const calls=[];let marked=false;
 const order=id=>({id,posting_number:`OGL-TEST-${id}`,shop_id:id%2?1:2,shop_name:id%2?'创建店铺':'同企业其他店铺',status:'awaiting_deliver',ordered_at:'2026-10-31T01:00:00Z',printed_at:'2026-10-31T02:00:00Z',item_count:1,skus:`SKU-${id}`,fulfillment_type_key:'fbs',logistics_carrier:'ogl',logistics_carrier_label:'OGL',needs_review:id===2,mark_note:id===2?(marked?'Changed note':'Manual review'):'',review_signature:id===2?(marked?'review-v2':'review-v1'):undefined});
 const detail=()=>({batch:{id:10,official_carriage_id:'901',default_shop_id:1,dispatch_shop_name:'创建店铺',containers_count:2,official_status:'observed',status:'preparing',official_result:{}},members:[{...order(1),order_id:1,active:true,official_member:1}],summary:{active:1},events:[]});
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders'){const page=Number(url.searchParams.get('page')||1),size=Number(url.searchParams.get('pageSize')||30);send({rows:[order(page===1?1:2)],total:60,page,pageSize:size,counts:{all:60,awaiting_deliver:60}});return true;}
  if(!url.pathname.startsWith('/api/ogl-dispatch/'))return false;
  const call={path:url.pathname,method:req.method};calls.push(call);
  if(req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const data=JSON.parse(body||'{}');call.body=data;if(url.pathname.endsWith('/preview'))send({eligible:data.order_ids.map(order),rejected:[],counts:{eligible:data.order_ids.length}});else send(detail());});return true;}
  if(url.pathname.endsWith('/bootstrap'))send({settings:{dispatch_shop_id:1},shops:[{id:1,name:'创建店铺'},{id:2,name:'同企业其他店铺'}]});
  else if(url.pathname.endsWith('/candidates')){const page=Number(url.searchParams.get('page')||1);send({eligible:[order(page===1?1:2)],rejected:[],total:21,page});}
  else if(url.pathname.endsWith('/official-carriages'))send({rows:[{carriage_id:'901',local_batch_id:10,dispatch_shop:{name:'创建店铺'},status:'formed',containers_count:2,departure_date:'2026-10-31'}]});
  else if(url.pathname.endsWith('/batch'))send(detail());else send({rows:[],total:0});return true;
 }});
 const space=process.env.EGO_OGL_SPACE_ID;
 const script=`
const task=await taskSpace(${space?Number(space):JSON.stringify('OGL workflow QA 20261031')});console.log('SPACE='+task.spaceId);const page=task.page('p1');
try {
await page.cdp('Network.enable');await page.cdp('Network.setCacheDisabled',{cacheDisabled:true});
await page.goto('http://localhost:8788/admin.html?oglqa='+Date.now()+'#/orders');await page.waitForSelector('.orders-table .el-table__body tbody tr');
console.log(await page.snapshot());
console.log('STAGE_SELECT');await page.click('.orders-table .el-table__body tbody tr .el-checkbox');
await page.click('button[aria-label="下一页"]');
await page.waitForFunction(()=>document.querySelector('.orders-table').textContent.includes('OGL-TEST-2'));
console.log('STAGE_SELECT');await page.click('.orders-table .el-table__body tbody tr .el-checkbox');
await page.click('.orders-selected-count');await page.waitForSelector('.el-dialog');
await page.evaluate(()=>{const text=document.querySelector('.el-dialog').textContent;if(!text.includes('OGL-TEST-1')||!text.includes('OGL-TEST-2'))throw Error('Cross-page metadata lost');});
await page.click('text="返回订单"');
console.log('STAGE_COMPOSE');await page.click('text="OGL 发运"');
await page.click('text="组批 / 绑定发运（已选 2 单）"');await page.waitForSelector('.ogl-composer');
await page.click("loc=role:button[name='选择']");
await page.waitForFunction(()=>document.querySelector('.composer-target'));
await page.evaluate(()=>{const btn=[...document.querySelectorAll('.composer-footer button')].at(-1);if(!btn.disabled)throw Error('Marked order accepted without review');});
await page.click('.ogl-composer .composer-section:last-child .el-checkbox');
await page.fill('textarea[aria-label="发运复核说明"]','已核对，可合并发运');
await page.click('text="查看申请、多个运单与分箱详情"');
await page.waitForFunction(()=>document.querySelectorAll('.el-drawer').length===2);
await page.evaluate(()=>{document.querySelector('.ogl-dispatch-panel').closest('.el-drawer').querySelector('.el-drawer__close-btn').click();});
await page.waitForFunction(()=>document.querySelectorAll('.el-drawer').length===1);
await page.evaluate(()=>{if(!document.querySelector('.composer-section:last-child').textContent.includes('本次已选 2 单'))throw Error('Nested return lost selection');});
await page.click('text="确认绑定，保持待交运"');
await page.waitForFunction(()=>!document.querySelector('.ogl-composer'));
console.log('OGL_BROWSER_OK');console.log(await page.snapshot());
await page.screenshot({path:${JSON.stringify(path.resolve('.verification/ogl-composer-preview.png'))}});
} catch(error){console.log('DIAGNOSTIC='+JSON.stringify(await page.evaluate(()=>({body:document.body.innerText.slice(0,2000),errors:window.layoutErrors}))));throw error;}
${space?'':"await task.finish({keep:[]});"}
`;
 try{const running=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:160000,maxBuffer:1024*1024});running.child.stdin.end();running.child.stdout.on('data',data=>process.stdout.write(data));running.child.stderr.on('data',data=>process.stdout.write(data));const {stdout,stderr}=await running;await fs.writeFile('.verification/ogl-browser.log',stdout+stderr);assert.match(stdout+stderr,/OGL_BROWSER_OK/);assert.ok(!calls.some(row=>['dispatch','official-create','official-confirm'].includes(row.body?.action)));const binding=calls.find(row=>row.body?.action==='bind-orders');assert.deepEqual(binding.body.order_ids.sort(),[1,2]);assert.equal(binding.body.review_signatures['2'],'review-v1');}
 finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

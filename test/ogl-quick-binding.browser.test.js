import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';

test('quick binding selects today across pages independently of main selection and binds one chosen saved carriage',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const rows=Array.from({length:26},(_,i)=>({id:201+i,shop_id:1,shop_name:'验证店铺',posting_number:'QUICK-'+(201+i),status:'awaiting_deliver',printed_at:'2026-11-02T01:00:00Z',can_select:true,blocked:false,needs_review:false}));
 const calls=[],batch={id:10,official_carriage_id:'901',status:'preparing',official_status:'observed',dispatch_shop_name:'验证店铺',official_result:{info:{status:'formed'}}};
 const server=await startPagedWorkspacePreview({host:'::1',stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders'){send({rows:[{id:999,shop_id:1,posting_number:'MAIN-SELECTED',status:'awaiting_deliver',ordered_at:'2026-11-02T01:00:00Z'}],total:1,page:1,pageSize:30,counts:{all:1,awaiting_deliver:1}});return true;}
  if(url.pathname==='/api/ogl-dispatch/bootstrap'){send({settings:{dispatch_shop_id:1},shops:[{id:1,name:'验证店铺'}]});return true;}
  if(url.pathname==='/api/ogl-dispatch/official-carriages'){send({rows:[{local_batch_id:10,carriage_id:'901',dispatch_shop:{name:'验证店铺'},status:'formed',status_label:'已生成',containers_count:1}]});return true;}
  if(url.pathname==='/api/ogl-dispatch/batch'){send({batch,members:[]});return true;}
  if(url.pathname==='/api/ogl-dispatch/candidates'){assert.equal(url.searchParams.get('selection'),'today-clear');send({rows:rows.slice(0,20),selection_rows:rows,selection_date:'2026-11-02',total:26});return true;}
  if(['/api/ogl-dispatch/preview','/api/ogl-dispatch/action'].includes(url.pathname)){
   let data='';req.on('data',c=>data+=c);req.on('end',()=>{const body=JSON.parse(data);calls.push({path:url.pathname,body});const chosen=rows.filter(r=>body.order_ids.includes(r.id));send(url.pathname.endsWith('/preview')?{eligible:chosen,rejected:[]}:{batch,members:chosen.map(r=>({...r,order_id:r.id,dispatched_at:null}))});});return true;
  }
  return false;
 }});
 const script=`const task=await taskSpace('ogl-quick-today-binding-20261102');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://[::1]:8788/admin.html?quickbind='+Date.now()+'#/orders');await page.waitForSelector('.orders-table tbody tr');console.log(await page.snapshot());
 await page.click('.orders-table tbody tr:first-child .el-checkbox');await page.click('.orders-toolbar-actions-side .el-dropdown button:has-text("OGL 发运")');await page.click('.el-dropdown-menu__item:has-text("今日打印无标记")');await page.waitForSelector('.ogl-composer');
 await page.waitForFunction(()=>document.querySelector('.ogl-composer').textContent.includes('跨页选中 26 单'));
 await page.evaluate(()=>{const t=document.querySelector('.ogl-composer').textContent;if(t.includes('MAIN-SELECTED'))throw Error('Main selection leaked into quick binding');if(!t.includes('QUICK-201'))throw Error('Missing first selected order');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});
 await page.click('.ogl-composer .el-pagination li:text-is("2")');await page.waitForFunction(()=>document.querySelector('.ogl-composer').textContent.includes('QUICK-221'));
 await page.click('.ogl-composer .composer-section:last-child tbody tr:first-child button:has-text("移除")');
 await page.click('.ogl-composer .el-table tbody button:has-text("选择")');await page.waitForFunction(()=>{const b=[...document.querySelectorAll('.composer-footer button')].find(n=>n.textContent.includes('绑定所选订单'));return b&&!b.disabled;});
 await page.screenshot({path:'/private/tmp/ogl-quick-binding.png'});console.log(await page.snapshot());
 await page.click('.composer-footer button:has-text("绑定所选订单")');await page.waitForFunction(()=>!document.querySelector('.ogl-composer'));
 await page.evaluate(()=>{if(!document.querySelector('.orders-selection-summary').textContent.includes('已选 1 单'))throw Error('Quick binding changed the unrelated main selection');});
 console.log('OGL_QUICK_BINDING_OK');await task.finish({keep:[]});`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/ogl-quick-binding.log',stdout+stderr);assert.match(stdout+stderr,/OGL_QUICK_BINDING_OK/);const action=calls.find(c=>c.path.endsWith('/action'));assert.equal(action.body.action,'quick-bind-orders');assert.equal(action.body.batch_id,10);assert.equal(action.body.printed_date,'2026-11-02');assert.equal(action.body.order_ids.length,25);assert.ok(!action.body.order_ids.includes(221));assert.ok(!action.body.order_ids.includes(999));assert.equal(action.body.confirm_dispatched,undefined);}
 finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

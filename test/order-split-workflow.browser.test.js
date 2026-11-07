import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
test('split dialog keeps failed allocation and requires a separate user confirmation to prepare',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const calls=[];let splits=0;
 const order=id=>({id,shop_id:1,shop_name:'Test shop',posting_number:id===1?'PARENT':'CHILD',status:'awaiting_packaging',tracking_stage:'posting_created',ordered_at:'2026-10-31T01:00:00Z',skus:'S',sku_names:'S:Test item',sku_quantities:'S:2',item_count:2,ozon_available_actions:['ship'],fulfillment_type_key:'fbs',logistics_carrier:'ogl'});
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/orders'&&req.method==='GET'){send({rows:[order(1)],total:1,page:1,pageSize:20,counts:{all:1,awaiting_packaging:1}});return true;}
  if(url.pathname==='/api/orders/1/split'&&req.method==='GET'){send(null);return true;}
  if(url.pathname==='/api/orders/1'&&req.method==='GET'){send({order:order(1),items:[{id:11,ozon_sku:'S',quantity:2,ozon_name:'Test item'}],finance:[]});return true;}
  if(['/api/orders/split','/api/orders/ship'].includes(url.pathname)&&req.method==='POST'){
   let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const body=JSON.parse(raw);calls.push({path:url.pathname,body});if(url.pathname.endsWith('/split')){splits++;if(splits===1){res.statusCode=409;send({error:'测试密钥无效，未自动备货',validation:{split_retry_safe:true}});return;}send(splits===2?{ok:false,split_confirmed:true,prepared:false,sync_pending:true,error:'子单同步待完成；未自动备货'}:{ok:true,split_confirmed:true,prepared:false,orders:[{id:1,posting_number:'PARENT',status:'awaiting_packaging'},{id:2,posting_number:'CHILD',status:'awaiting_packaging'}],posting_numbers:['PARENT','CHILD']});}else send({ok:true,order_ids:[1,2],updated_orders:[{id:1,status:'awaiting_deliver'},{id:2,status:'awaiting_deliver'}]});});return true;
  }return false;
 }});
 const script=`const task=await taskSpace(26);const page=task.page('p1');
 await page.cdp('Network.enable');await page.cdp('Network.setCacheDisabled',{cacheDisabled:true});
 await page.goto('http://localhost:8788/admin.html?splitqa='+Date.now()+'#/orders');await page.waitForSelector('.orders-table');
 await page.click('text="拆单"');await page.waitForSelector('.orders-split-dialog');
 await page.click('text="确认拆单，不备货"');
 await page.waitForFunction(()=>document.body.textContent.includes('测试密钥无效')&&!document.querySelector('.orders-split-dialog .el-button.is-loading'));
 await page.evaluate(()=>{if(document.querySelectorAll('.orders-split-package').length!==2||document.querySelector('.orders-split-result')||document.querySelector('.orders-split-item-row input').disabled)throw Error('Definite failure lost the editable allocation');});
 await page.click('text="确认拆单，不备货"');
 await page.waitForFunction(()=>document.querySelector('.orders-split-dialog')?.textContent.includes('子单同步待完成'));
 await page.evaluate(()=>{if(document.querySelectorAll('.orders-split-package').length!==2||document.querySelector('.orders-split-result'))throw Error('Failed split lost allocation or became prepared');});
 await page.click('text="重新同步拆单结果"');await page.waitForSelector('.orders-split-result');
 await page.evaluate(()=>document.querySelector('.orders-split-result .el-table__header-wrapper .el-checkbox').scrollIntoView({block:'center'}));
 await page.click('.orders-split-result .el-table__header-wrapper .el-checkbox');
 await page.waitForFunction(()=>![...document.querySelectorAll('.orders-split-dialog button')].find(b=>b.textContent.includes('确认所选子单备货')).disabled);
 await page.click('text="确认所选子单备货"');await page.waitForSelector('.el-message-box');
 await page.click('.el-message-box__btns button:last-child');
 await page.waitForFunction(()=>!document.querySelector('.orders-split-dialog'));
 console.log('SPLIT_BROWSER_OK');console.log(await page.snapshot());`;
 try{const running=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:160000,maxBuffer:1024*1024});running.child.stdin.end();const {stdout,stderr}=await running;await fs.writeFile('.verification/order-split-browser.log',stdout+stderr);assert.match(stdout+stderr,/SPLIT_BROWSER_OK/);assert.deepEqual(calls.map(c=>c.path),['/api/orders/split','/api/orders/split','/api/orders/split','/api/orders/ship']);assert.notEqual(calls[0].body.client_request_id,calls[1].body.client_request_id);assert.equal(calls[1].body.client_request_id,calls[2].body.client_request_id);assert.equal(calls[2].body.action,'reconcile');assert.deepEqual(calls[3].body.order_ids,[1,2]);assert.equal(calls[3].body.packages,undefined);}
 finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

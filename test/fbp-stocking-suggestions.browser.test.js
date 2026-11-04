import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
import {inventoryWorkflow} from '../src/shared/inventory-workflow.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';

test('FBP stocking suggestions are separate from buying and open the existing application flow',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const forecast={skus:[{shop_id:1,ozon_sku:'DEMO',available:88,present:88,fbp_target:104,per_set_quantity:1,in_transit:0,committed_qty:0}]};
 const make=(physical,safety,fbp)=>inventoryWorkflow({physical_estimate:physical,open_order_demand:0,fbp_reserved:0,incoming_quantity:0,current_incoming:0,current_shortage:0,flow_summary:{safety}},{applications:[],forecast:fbp});
 const stocked=make(2187,0,forecast),buy=make(0,5,{skus:[]});
 const rows=[{product_id:501,product_name:'有货发仓示例',inventory_number:'DEMO-501',workflow:stocked},{product_id:502,product_name:'需采购示例',inventory_number:'DEMO-502',workflow:buy}];
 let writes=0;
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(req.method!=='GET'){if(req.method==='POST'&&['/api/inventory-workflow/fbp','/api/procurement/purchases'].includes(url.pathname))writes++;send({ok:true});return true;}
  if(url.pathname==='/api/inventory-workflow/alerts'){send({...inventoryWorkspacePage(rows,Object.fromEntries(url.searchParams)),snapshot:{available:true,calculated_at:'2026-11-04T08:00:00Z'}});return true;}
  if(url.pathname==='/api/inventory-workflow'){send({rows:[{...stocked,product_id:501,fbp_forecast_suggestions:[{shop_id:1,shop_name:'演示店铺',mapping_id:1,ozon_sku:'DEMO',available:88,fbp_target:104,per_set_quantity:1,suggested_application_qty:16,pending_physical:0}]}]});return true;}
  return false;
 }});
 const script=`const task=await taskSpace('fbp-stocking-category-20261104');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html?fbpqa='+Date.now()+'#/procurement/workspace');await page.waitForSelector('[data-task="fbp-stocking"]');console.log(await page.snapshot());
 await page.click('[data-task="advisory"]');await page.waitForFunction(()=>document.querySelector('.supply-table')?.textContent.includes('需采购示例'));await page.evaluate(()=>{if(document.querySelector('.supply-table').textContent.includes('有货发仓示例'))throw Error('stocked forecast leaked into procurement replenishment');});
 await page.click('[data-task="fbp-stocking"]');await page.waitForFunction(()=>document.querySelector('.supply-table')?.textContent.includes('有货发仓示例'));console.log(await page.snapshot());
 await page.evaluate(()=>{const table=document.querySelector('.supply-table');if(table.textContent.includes('需采购示例'))throw Error('local safety purchase leaked into FBP suggestions');if(!table.textContent.includes('建议备货 16 件'))throw Error('stocking quantity missing');if(!table.textContent.includes('货源已覆盖，无需新增采购'))throw Error('coverage explanation missing');if(document.querySelector('.supply-row-actions').textContent.includes('登记采购'))throw Error('purchase action shown for stocking-only suggestion');});
 await page.click('.supply-row-actions .el-button--primary');await page.waitForSelector('text="确认FBP预测并创建备货申请"');console.log(await page.snapshot());await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});console.log('FBP_STOCKING_OK');await task.finish({keep:[]});`;
 try{
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:165000,maxBuffer:1024*1024});run.child.stdin.end();let result;
  try{result=await run;}catch(error){await fs.writeFile('/private/tmp/fbp-stocking-browser.log',(error.stdout||'')+(error.stderr||''));throw error;}
  const log=result.stdout+result.stderr;await fs.writeFile('/private/tmp/fbp-stocking-browser.log',log);assert.match(log,/FBP_STOCKING_OK/);assert.equal(writes,0);
 }finally{await server.close();}
});

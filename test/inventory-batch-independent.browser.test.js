import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';
test('arrival and receiving batches stay usable while demand calculation is unavailable',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:90000},async()=>{
 const calls=[];const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  calls.push(url.pathname+url.search);
  if(url.pathname==='/api/inventory-workflow/alerts'){res.statusCode=503;send({error:'模拟需求引擎繁忙'});return true;}
  if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){send({rows:url.searchParams.get('summary_only')?[]:[{id:11,product_id:101,product_name:'独立到货配件',quantity:6,physical_quantity:6,purchased_at:'2026-10-31 01:00:00',components:[{product_id:101,name:'独立到货配件',inventory_number:'2-101',quantity:6,per_set_quantity:1}],affected_bundles:[]}],total:1,summary:{open:1,arrived:1,open_quantity:6,arrived_quantity:6}});return true;}
  return false;
 }});
 const script=`const task=await taskSpace('inventory-performance-20261101');console.log({space:task.spaceId});const page=task.page('p1');await page.goto('http://localhost:8788/admin.html?perfqa='+Date.now()+'#/procurement/workspace');await page.waitForSelector('.supply-task-cards');console.log(await page.snapshot());await page.click('text="采购待到货"');await page.waitForFunction(()=>document.querySelector('.inventory-batch-queue')?.textContent.includes('独立到货配件'));console.log(await page.snapshot());await page.click('text="刷新采购批次"');await page.waitForFunction(()=>!document.querySelector('.inventory-batch-queue .el-loading-mask'));await page.click('text="到货待验收"');await page.waitForFunction(()=>document.querySelector('.inventory-batch-queue')?.textContent.includes('独立到货配件'));await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));if(document.querySelector('.supply-workspace>.el-alert'))throw Error('Batch view displays unrelated demand status');});await page.screenshot({path:'/tmp/inventory-batch-independent.png'});console.log('INDEPENDENT_BATCH_OK');`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:80000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;await fs.writeFile('.verification/performance-batch-browser.log',stdout+stderr);assert.match(stdout+stderr,/INDEPENDENT_BATCH_OK/);assert.equal(calls.filter(p=>p.startsWith('/api/inventory-workflow/alerts')).length,1);assert.ok(calls.filter(p=>p.startsWith('/api/inventory-workflow/purchase-arrivals')&&!p.includes('summary_only')).length>=3);}
 finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';

test('one user gets module defaults, can switch FBP back, retires procurement registration and retains receiving links', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const server=await startPagedWorkspacePreview({stableDeps:true});
 const script=`const task=await taskSpace('module-supply-20261101');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html#/orders?mode=inventory');await page.waitForSelector('.inventory-batch-queue');
 const read=()=>page.evaluate(()=>({keys:[...document.querySelectorAll('[data-task]')].map(n=>n.dataset.task),active:document.querySelector('[data-task].is-active')?.dataset.task}));
 let state=await read();if(state.active!=='receiving'||state.keys.join(',')!=='receiving,fbp-stocking,fbp-receipts,incoming,required,advisory')throw Error(JSON.stringify(state));
 console.log(await page.snapshot());await page.click('[data-task="fbp-receipts"]');await page.waitForSelector('[data-task="fbp-receipts"].is-active');await page.click('[data-task="receiving"]');await page.waitForSelector('.inventory-batch-queue');
 await page.evaluate(()=>window.layoutRouter.push('/procurement/workspace'));await page.waitForSelector('[data-task="required"].is-active');state=await read();if(state.keys.join(',')!=='required,advisory,incoming,receiving,fbp-stocking,fbp-receipts')throw Error(JSON.stringify(state));
 await page.evaluate(()=>window.layoutRouter.push('/procurement/workspace?mode=purchase&product_id=101'));await page.waitForSelector('[data-task="required"].is-active');
 await page.evaluate(()=>{if(document.body.innerText.includes('旧版登记采购'))throw Error('Retired procurement workbench visible');});
 await page.evaluate(()=>window.layoutRouter.push('/procurement/workspace?mode=arrivals'));await page.waitForSelector('[data-task="incoming"].is-active');
 await page.evaluate(()=>window.layoutRouter.push('/purchase-list'));await page.waitForSelector('[data-task="receiving"].is-active');console.log(await page.snapshot());
 await page.click('text="旧版收货管理"');await page.waitForSelector('.procurement-list-page');await page.click('text="返回收货工作平台"');await page.waitForSelector('[data-task="receiving"].is-active');
 await page.evaluate(()=>window.layoutRouter.push('/purchase-list?orderId=123&productId=101'));await page.waitForSelector('.procurement-list-page');
 await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});console.log('MODULE_SUPPLY_OK');await task.finish({keep:[]});`;
 try{
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});run.child.stdin.end();
  const {stdout,stderr}=await run;await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/module-supply-browser.log',stdout+stderr);assert.match(stdout+stderr,/MODULE_SUPPLY_OK/);
 }finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

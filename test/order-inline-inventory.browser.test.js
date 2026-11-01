import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startOrderLocalRefreshPreview} from './fixtures/order-page-local-refresh-preview.js';
test('inline inventory numbers render with the first order rows without a second inventory request',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:90000},async()=>{
 const {server,calls}=await startOrderLocalRefreshPreview({inlineInventory:true});
 try{
  const space=process.env.BROWSER_TASK_SPACE||'order-inline-inventory-verification';
  const script=`const task=await taskSpace(${JSON.stringify(space)});const page=task.page('p1');await page.goto('http://localhost:8788/admin.html?inline='+Date.now()+'#/orders');await page.waitForFunction(()=>document.querySelectorAll('.orders-table tbody tr').length===3,undefined,{timeout:60000});console.log('INLINE_FACTS',await page.evaluate(()=>{const row=document.querySelector('.orders-table tbody tr:nth-child(2)');if(!row.textContent.match(/实物：\\s*5/))throw Error('First rows missing inventory');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));return {rows:document.querySelectorAll('.orders-table tbody tr').length};}));console.log(await page.snapshot());`;
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:80000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;assert.match(stdout+stderr,/INLINE_FACTS/);
  assert.ok(calls.some(call=>call.path==='/api/orders'&&call.query.includeInventoryAvailability==='1'));
  assert.equal(calls.filter(call=>call.path==='/api/orders/inventory-availability').length,0);
 }finally{await server.close();}
});

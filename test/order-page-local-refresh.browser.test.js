import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startOrderLocalRefreshPreview} from './fixtures/order-page-local-refresh-preview.js';
test('saving a shared component updates affected orders without reloading the list or replacing product images',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const {server,calls}=await startOrderLocalRefreshPreview();
 const script=`const task=await taskSpace('order-query-local-refresh-20261101');console.log({spaceId:task.spaceId});const page=task.page('p1');await page.goto('http://localhost:8788/admin.html?refreshqa='+Date.now()+'#/orders');
 await page.waitForFunction(()=>document.querySelectorAll('.orders-table tbody tr').length===3,undefined,{timeout:60000});await page.waitForFunction(()=>document.querySelector('.orders-table tbody tr:nth-child(2)').textContent.match(/实物：\\s*5/));
 await page.waitForFunction(()=>{const images=[...document.querySelectorAll('.orders-table tbody img')];return images.length===3&&images.every(img=>img.complete&&img.naturalWidth>0);});
 await page.evaluate(()=>{window.originalOrderImages=[...document.querySelectorAll('.orders-table tbody img')];window.unrelatedOrderText=document.querySelector('.orders-table tbody tr:nth-child(3)').textContent;});
 await page.click('.orders-table tbody tr:nth-child(2) button:has-text("更新本地库存")');await page.waitForSelector('.stocktake-form-dialog .el-input-number input');await page.fill('.stocktake-form-dialog .el-input-number input','20');await page.press('.stocktake-form-dialog .el-input-number input','Tab');await page.click('.stocktake-form-dialog .el-radio:has-text("历史库存记错")');await page.click('.stocktake-form-dialog button:has-text("确认更新")');await page.waitForSelector('.el-message-box');await page.click('.el-message-box button:has-text("确认更新")');
 await page.waitForFunction(()=>[...document.querySelectorAll('.orders-toolbar-status')].some(e=>e.textContent.includes('已更新 2 条')));
 await page.evaluate(()=>{const rows=document.querySelectorAll('.orders-table tbody tr');if(!rows[1].textContent.match(/实物：\\s*20/))throw Error('Direct order did not refresh');if(!rows[0].textContent.match(/实物：\\s*10/))throw Error('Shared component kit did not refresh');if(rows[2].textContent!==window.unrelatedOrderText)throw Error('Unrelated order changed');const images=[...document.querySelectorAll('.orders-table tbody img')];if(!images.length||images.some((img,index)=>img!==window.originalOrderImages[index]))throw Error('Product images were replaced');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});
 await page.click('.orders-table tbody tr:first-child button:has-text("查看明细")');await page.waitForSelector('.orders-detail-dialog');await page.screenshot({path:'/tmp/order-query-local-refresh.png'});console.log('LOCAL_REFRESH_UI_OK');`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:170000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;assert.match(stdout+stderr,/LOCAL_REFRESH_UI_OK/);
  assert.equal(calls.filter(c=>c.path==='/api/orders'&&c.query.includeRows!=='0').length,1,'stock save must not reload the list');
  assert.equal(calls.filter(c=>c.path==='/api/orders/inventory-availability'&&c.query.includeRows==='1').length,1);
  assert.equal(calls.filter(c=>/^\/api\/orders\/\d+$/.test(c.path)).length,1,'full detail loads only on click');
 }finally{await server.close();}
});

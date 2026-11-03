import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startInventoryRequestInboxPreview} from './fixtures/inventory-request-inbox-preview.js';

test('inventory request badge, standalone inbox and own-request notification approval update live',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const fixture=await startInventoryRequestInboxPreview();
 const script=`const task=await taskSpace('inventory-request-inbox-20261103');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://[::1]:8788/admin.html?inboxqa='+Date.now()+'#/inventory/products');await page.waitForSelector('.inventory-request-entry');console.log(await page.snapshot());
 await page.waitForFunction(()=>document.querySelector('.inventory-request-entry .el-badge__content')?.textContent.trim()==='2');
 await page.click('.inventory-request-entry button');await page.waitForURL('**#/inventory/product-requests');await page.waitForSelector('.inventory-request-center h2');
 await page.evaluate(()=>{if(!document.querySelector('.inventory-request-center h2').textContent.includes('待审核 2'))throw Error('Standalone pending count missing');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});
 await page.click('button:has-text("返回商品库存")');await page.waitForSelector('.inventory-request-entry');await page.click('button[aria-label="消息通知"]');await page.waitForSelector('.notification-card');console.log(await page.snapshot());
 await page.click('.notification-card:first-child button:has-text("通过申请")');await page.waitForSelector('.el-message-box');await page.click('.el-message-box button:has-text("通过并创建库存")');
 await page.waitForFunction(()=>document.querySelector('.inventory-request-entry .el-badge__content')?.textContent.trim()==='1');
 await page.click('.erp-notification-drawer .el-drawer__close-btn');
 await page.waitForFunction(async()=>{const r=await fetch('/__fixture/state');return(await r.json()).streams>0;});
 await page.fetch('/__fixture/create',{method:'POST'});await page.waitForSelector('.el-notification__title:has-text("库存申请待审核")');
 await page.waitForFunction(()=>document.querySelector('.inventory-request-entry .el-badge__content')?.textContent.trim()==='2');
 await page.screenshot({path:'/private/tmp/inventory-request-notification.png'});await page.click('.el-notification__title:has-text("库存申请待审核")');
 await page.waitForURL('**requestId=3');await page.waitForFunction(()=>document.body.textContent.includes('审核建品申请'));console.log(await page.snapshot());await page.screenshot({path:'/private/tmp/inventory-request-center.png'});
 await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});console.log('INVENTORY_REQUEST_INBOX_OK');await task.finish({keep:[]});`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:170000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;await fs.mkdir('.verification',{recursive:true});await fs.writeFile('.verification/inventory-request-inbox.log',stdout+stderr);assert.match(stdout+stderr,/INVENTORY_REQUEST_INBOX_OK/);assert.equal(fixture.calls.length,1);assert.equal(fixture.calls[0].id,1);assert.equal(fixture.calls[0].body.action,'approve');assert.equal(fixture.calls[0].body.revision,1);assert.equal(fixture.requests[0].status,'approved');}
 finally{await fixture.close();}
});

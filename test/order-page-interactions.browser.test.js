import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startOrderPageInteractionsPreview} from './fixtures/order-page-interactions-preview.js';
test('page batch prepare ignores hidden selection and FBP, and modes toggle in one click',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const {server,calls}=await startOrderPageInteractionsPreview();
 const script=`const task=await taskSpace('order-page-interactions-20261101');console.log({spaceId:task.spaceId});const page=task.page('p1');await page.goto('http://localhost:8788/admin.html?interactionsqa='+Date.now()+'#/orders');
 await page.waitForFunction(()=>document.querySelectorAll('.orders-table tbody tr').length===20,undefined,{timeout:60000});
 await page.click('.orders-table tbody tr:first-child .el-checkbox');await page.click('.orders-page-footer button[aria-label="下一页"]');await page.waitForFunction(()=>document.querySelector('.orders-table tbody tr')?.textContent.includes('ORDER-21'));
 await page.click('.orders-toolbar button:has-text("批量备货")');await page.waitForSelector('.el-message-box');await page.evaluate(()=>{if(!document.querySelector('.el-message-box').textContent.includes('当前页 18 个FBS订单'))throw Error('Wrong eligible count');});await page.click('text="确认备货 18 单"');await page.waitForFunction(()=>!document.querySelector('.el-message-box'));
 await page.click('button[aria-label="当前打印模式，切换模式"]');await page.waitForSelector('[aria-label="库存管理模式"] .order-work-mode-switch',{timeout:60000});await page.click('[aria-label="库存管理模式"] .order-work-mode-switch');await page.waitForSelector('button[aria-label="当前打印模式，切换模式"]');
 await page.evaluate(()=>{if(!document.querySelector('.orders-selection-summary').textContent.includes('其他页 1 单'))throw Error('Mode switch discarded selection');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));const buttons=[...document.querySelectorAll('.orders-toolbar button')].map(b=>b.textContent.trim());const expected=['查询','同步当前范围','拉取新订单','更多操作','批量备货','批量打印','OGL 发运'];let last=-1;for(const text of expected){const index=buttons.indexOf(text);if(index<=last)throw Error('Wrong toolbar order '+text);last=index;}if(!document.querySelector('.orders-toolbar-search-group button')?.textContent.includes('查询'))throw Error('Query not beside input');});
 for(const width of [1920,1366]){await page.cdp('Emulation.setDeviceMetricsOverride',{width,height:768,deviceScaleFactor:1,mobile:false});await page.evaluate(()=>{const mode=document.querySelector('.orders-toolbar .order-work-mode-switch').getBoundingClientRect(),footer=document.querySelector('.orders-page-footer').getBoundingClientRect();if(mode.right>innerWidth||footer.bottom>innerHeight+2)throw Error('Controls clipped');});await page.screenshot({path:'/tmp/order-interactions-'+width+'.png'});}console.log('ORDER_INTERACTIONS_OK');`;
 try{const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:170000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;assert.match(stdout+stderr,/ORDER_INTERACTIONS_OK/);assert.deepEqual(calls,[{order_ids:[21,...Array.from({length:17},(_,i)=>24+i)]}]);}
 finally{await server.close();}
});

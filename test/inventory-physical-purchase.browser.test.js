import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPhysicalPurchasePreview} from './fixtures/inventory-physical-preview.js';
test('compact physical procurement supports FBP retry, legacy-part review and retained batch forms',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const {server,calls}=await startPhysicalPurchasePreview();
 const script=`const task=await taskSpace('procurement-units-20261031');const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html?physicalqa='+Date.now()+'#/procurement/workspace');await page.waitForSelector('.supply-table');console.log(await page.snapshot());
 await page.click('.compact-demand-lines button:has-text("同步重算")');await page.waitForFunction(()=>document.body.textContent.includes('同步未完成，点击重试'));await page.click('text="同步未完成，点击重试"');await page.waitForFunction(()=>document.body.textContent.includes('官方库存已同步'));
 console.log(await page.evaluate(()=>({rowHeight:document.querySelector('.supply-table tbody tr').getBoundingClientRect().height,negative:document.body.textContent.includes('账面 -3 件')})));
 await page.click('text="采购待到货"');await page.click('text="核对采购内容"');await page.waitForSelector('.bundle-review');console.log(await page.snapshot());await page.click('text="实际只买了配件"');await page.click('.bundle-review tbody tr:first-child .el-checkbox');await page.waitForFunction(()=>document.querySelector('.bundle-review tbody tr:first-child td:nth-child(3) input').getAttribute('aria-disabled')!=='true');
 await page.fill('.bundle-review tbody tr:first-child td:nth-child(3) input','7');await page.fill('input[aria-label="门槛条实物配件 A实际货款"]','35');await page.fill('textarea[placeholder="核对说明 / 采购凭证"]','按凭证只买配件A');await page.click('text="已核对凭证，确认原金额录错；实际退款另走采购对账"');await page.click('text="确认保存采购内容"');await page.waitForSelector('.el-message-box');await page.click('.el-message-box__btns button:last-child');await page.waitForFunction(()=>!document.querySelector('.bundle-review'));
 await page.click('text="必须采购"');await page.click('text="批量登记采购"');await page.waitForSelector('.batch-purchase');console.log(await page.snapshot());await page.fill('input[placeholder="搜索库存编号 / SKU / 名称，加入本次采购"]','2-200');await page.click('text="搜索库存"');await page.click('text="加入采购"');await page.waitForFunction(()=>document.querySelectorAll('.batch-purchase tbody tr').length===2);
 await page.click('.batch-purchase tbody tr:last-child td:last-child button');await page.fill('input[aria-label="门槛条实物配件 A采购件数"]','9');await page.fill('input[aria-label="门槛条实物配件 A实际货款"]','45');await page.click('.batch-purchase tbody tr:first-child button:has-text("库存详情")');await page.waitForSelector('.unified-inventory-dialog');console.log(await page.snapshot());await page.click('.unified-inventory-dialog button[aria-label="Close this dialog"]');await page.waitForFunction(()=>!document.querySelector('.unified-inventory-dialog'));
 await page.evaluate(()=>{if(document.querySelector('.batch-purchase input[aria-label="门槛条实物配件 A采购件数"]').value!=='9'||document.querySelectorAll('.batch-purchase tbody tr').length!==1)throw Error('Opening detail lost purchase form');if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});
 await page.screenshot({path:'/tmp/physical-purchase-browser.png'});await page.click('text="确认批量登记采购"');await page.waitForFunction(()=>!document.querySelector('.batch-purchase'));console.log('PHYSICAL_BROWSER_OK');`;
 try{
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:160000,maxBuffer:1024*1024});run.child.stdin.end();const {stdout,stderr}=await run;await fs.writeFile('.verification/physical-browser-final.log',stdout+stderr);assert.match(stdout+stderr,/PHYSICAL_BROWSER_OK/);
  assert.ok(calls.filter(c=>c.path==='/api/inventory-flow/sync').length>=2);assert.ok(!calls.some(c=>c.path.includes('/receive')));const reviewed=calls.find(c=>c.path.endsWith('/purchase-bundle'));assert.deepEqual(reviewed.body.items,[{product_id:101,quantity:7,amount:35,shipping_amount:0}]);const purchased=calls.find(c=>c.path==='/api/procurement/purchases');assert.equal(purchased.body.items.length,1);assert.equal(purchased.body.items[0].product_id,101);assert.equal(purchased.body.items[0].quantity,9);assert.equal(purchased.body.items[0].amount,45);
 }finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

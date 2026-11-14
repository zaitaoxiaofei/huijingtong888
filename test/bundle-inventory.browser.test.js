import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startBundleInventoryPreview} from './fixtures/bundle-inventory-preview.js';

test('desktop and mobile show every child, batch-update physical stock, and expand real scanned bundles',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:150000
},async()=>{
 const {server,writes}=await startBundleInventoryPreview(),output=path.resolve('.verification');await fs.mkdir(output,{recursive:true});
 const script=`
 const task=await taskSpace('bundle-inventory-20261114'),pages=await task.pages(),page=pages[0]||await task.newPage();
 await page.cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await page.goto('about:blank');await page.goto('http://localhost:8788/admin.html#/inventory/products');await page.waitForSelector('.product-inventory-number');
 await page.click('.inventory-actions .inventory-action-row:first-child button:nth-child(2) >> nth=0');
 await page.waitForSelector('input[aria-label="子库存 2-210 实际总库存"]');
 await page.fill('input[aria-label="子库存 2-210 实际总库存"]','12');await page.press('input[aria-label="子库存 2-210 实际总库存"]','Tab');
 await page.fill('input[aria-label="子库存 2-211 实际总库存"]','0');await page.press('input[aria-label="子库存 2-211 实际总库存"]','Tab');
 await page.selectOption('select[aria-label="套装调整原因"]','history_error');
 await page.waitForFunction(()=>!document.querySelector('.inventory-bundle-dialog')||getComputedStyle(document.querySelector('.inventory-bundle-dialog')).opacity==='1'&&document.querySelector('.inventory-bundle-dialog').closest('.el-overlay').getAnimations({subtree:true}).every(animation=>animation.playState!=='running'||animation.effect.getTiming().iterations===Infinity));await page.screenshot({path:${JSON.stringify(path.join(output,'bundle-stocktake-desktop.png'))}});
 await page.click('.inventory-bundle-dialog button:has-text("一次确认更新所有子库存")');await page.waitForFunction(()=>!document.querySelector('.inventory-bundle-dialog'));
 await page.click('button:has-text("套装明细")');await page.waitForFunction(()=>document.querySelector('.inventory-bundle-dialog')?.textContent.includes('2-211'));
 await page.waitForSelector('.inventory-bundle-dialog .bundle-child .el-image__inner');await page.click('.inventory-bundle-dialog .bundle-child .el-image__inner >> nth=0');
 await page.waitForSelector('.el-image-viewer__wrapper');await page.click('.el-image-viewer__close');await page.click('.inventory-bundle-dialog .el-dialog__headerbtn');
 await page.cdp('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
 await page.goto('http://localhost:8788/admin.html#/mobile/inventory');await page.waitForSelector('.mobile-inventory-scan-button');
 await page.evaluate(async()=>{
  const button=document.querySelector('.mobile-inventory-scan-button');if(!button.classList.contains('el-button--success')||!button.querySelector('svg'))throw Error('Scan needs visible green icon');const color=getComputedStyle(button).color.match(/[0-9]+/g).map(Number);if(!(color[1]>color[0]&&color[1]>color[2]))throw Error('Scan icon must actually be green');
  const {renderInventoryLabel}=await import('/frontend/admin/utils/inventory-labels.js');const image=new Image();image.src=renderInventoryLabel({id:200,number:'2-200',name:'套装扫码测试',type:'套装'});await image.decode();
  const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=700;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1000,700);ctx.drawImage(image,87,173);
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{const stream=canvas.captureStream(5);const pump=setInterval(()=>{if(stream.getTracks().every(t=>t.readyState==='ended'))clearInterval(pump);else ctx.drawImage(image,87,173);},100);window.bundleCamera=stream;return stream;}});
 });
 await page.click('.mobile-inventory-scan-button');await page.waitForFunction(()=>document.querySelector('input[aria-label="搜索内容"]').value==='2-200'&&document.querySelector('.mobile-list-scroll .bundle-details')?.textContent.includes('2-211'));
 await page.waitForFunction(()=>[...document.querySelectorAll('.mobile-list-scroll .bundle-child img')].filter(i=>i.complete&&i.naturalWidth>0).length===2);
 await page.evaluate(()=>{const text=document.querySelector('.mobile-list-scroll .bundle-details').textContent;for(const id of ['2-210','2-211'])if(!text.includes(id))throw Error('Missing child '+id);if(!window.bundleCamera.getTracks().every(t=>t.readyState==='ended'))throw Error('Camera still active');if(document.documentElement.scrollWidth>innerWidth)throw Error('Mobile overflow');});
 await page.waitForFunction(()=>!document.querySelector('.inventory-bundle-dialog')||getComputedStyle(document.querySelector('.inventory-bundle-dialog')).opacity==='1'&&document.querySelector('.inventory-bundle-dialog').closest('.el-overlay').getAnimations({subtree:true}).every(animation=>animation.playState!=='running'||animation.effect.getTiming().iterations===Infinity));await page.screenshot({path:${JSON.stringify(path.join(output,'bundle-scan-mobile-375.png'))}});
 await page.click('.mobile-record-actions button:has-text("更新库存")');await page.waitForSelector('input[aria-label="子库存 2-210 实际总库存"]');
 await page.fill('input[aria-label="子库存 2-210 实际总库存"]','9');await page.press('input[aria-label="子库存 2-210 实际总库存"]','Tab');
 await page.fill('input[aria-label="子库存 2-211 实际总库存"]','4');await page.press('input[aria-label="子库存 2-211 实际总库存"]','Tab');await page.selectOption('select[aria-label="套装调整原因"]','history_error');
 await page.waitForFunction(()=>!document.querySelector('.inventory-bundle-dialog')||getComputedStyle(document.querySelector('.inventory-bundle-dialog')).opacity==='1'&&document.querySelector('.inventory-bundle-dialog').closest('.el-overlay').getAnimations({subtree:true}).every(animation=>animation.playState!=='running'||animation.effect.getTiming().iterations===Infinity));await page.screenshot({path:${JSON.stringify(path.join(output,'bundle-stocktake-mobile-375.png'))}});
 await page.click('.inventory-bundle-dialog button:has-text("一次确认更新所有子库存")');await page.waitForFunction(()=>!document.querySelector('.inventory-bundle-dialog'));
 await page.evaluate(()=>window.bundleRole(['packing']));await page.waitForFunction(()=>![...document.querySelectorAll('.mobile-record-actions button')].some(b=>b.textContent.trim()==='更新库存'));
 await page.click('.mobile-record-actions button:has-text("套装明细")');await page.waitForFunction(()=>document.querySelector('.inventory-bundle-dialog')?.textContent.includes('2-211'));
 await page.evaluate(()=>{if(document.querySelector('.inventory-bundle-dialog input[aria-label*="实际总库存"]'))throw Error('Read-only user can edit');if(window.bundleErrors.length)throw Error(window.bundleErrors.join(';'));});
 console.log('BUNDLE_INVENTORY_OK');await task.finish({keep:[]});
 `;
 try{
  const result=await promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:140000,maxBuffer:1024*1024});await fs.writeFile(path.join(output,'bundle-inventory-browser.log'),result.stdout+result.stderr);
  assert.match(result.stdout+result.stderr,/BUNDLE_INVENTORY_OK/);assert.equal(writes.length,2);
  assert.deepEqual(writes.map(body=>body.items.map(item=>[item.product_id,item.counted_quantity])),[[[210,12],[211,0]],[[210,9],[211,4]]]);
  assert.ok(writes.every(body=>body.product_id===200&&body.revision==='bom1'&&body.items.every(item=>item.product_id!==200)));
 }finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

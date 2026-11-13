import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startMobileDialogPreview} from './fixtures/mobile-dialog-preview.js';

test('mobile camera decodes real inventory labels, searches automatically and releases all camera tracks',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
 const {server,calls}=await startMobileDialogPreview({host:'::1',stableDeps:true}),output=path.resolve('.verification');await fs.mkdir(output,{recursive:true});
 const script=`
 const task=await taskSpace('mobile-inventory-scan-20261113'),pages=await task.pages(),page=pages[0]||await task.newPage();console.log('SPACE',task.spaceId);
 await page.cdp('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
 await page.goto('about:blank');await page.goto('http://[::1]:8788/admin.html?scan='+Date.now()+'#/mobile/inventory');
 await page.waitForSelector('.mobile-inventory-filter-actions');
 await page.evaluate(async()=>{
  const {renderInventoryLabel}=await import('/frontend/admin/utils/inventory-labels.js');
  const image=new Image();image.src=renderInventoryLabel({id:7,number:'1-7',name:'手机扫码库存测试',type:'单品'});await image.decode();
  const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=700;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1000,700);ctx.drawImage(image,87,173);
  window.cameraMode='success';window.cameraStreams=[];window.cameraOptions=[];
  const createStream=()=>{const source=window.cameraMode==='blank'?document.createElement('canvas'):canvas;if(source!==canvas){source.width=1000;source.height=700;}const draw=()=>{if(source===canvas)ctx.drawImage(image,87,173);else{source.getContext('2d').fillStyle='#fff';source.getContext('2d').fillRect(0,0,1000,700);}};const stream=source.captureStream(5);const pump=setInterval(()=>{if(stream.getTracks().every(t=>t.readyState==='ended'))clearInterval(pump);else draw();},100);window.cameraStreams.push(stream);return stream;};
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async options=>{
   window.cameraOptions.push(options);
   if(window.cameraMode==='denied')throw new DOMException('denied','NotAllowedError');
   if(window.cameraMode==='missing')throw new DOMException('missing','NotFoundError');
   if(window.cameraMode==='busy')throw new DOMException('busy','NotReadableError');
   if(window.cameraMode==='pending')return new Promise(resolve=>{window.resolveCamera=()=>resolve(createStream());});
   return createStream();
  }});
 });
 console.log('MOCKED');const open=()=>page.click('.mobile-inventory-filter-actions button:has-text("扫一扫")');
 await open();console.log('OPEN');
 await page.waitForFunction(()=>!document.querySelector('.mobile-inventory-scanner')&&document.querySelector('input[aria-label="搜索内容"]').value==='1-7'&&document.querySelectorAll('.mobile-inventory-page .mobile-list-scroll>article').length===1);
 console.log('MATCH');await page.waitForFunction(()=>[...document.querySelectorAll('.mobile-inventory-page .mobile-record-head img')].some(image=>image.complete&&image.naturalWidth>0));console.log('IMAGE');
 await page.evaluate(()=>{if(!window.cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')))throw Error('Camera leaked after match');if(window.cameraOptions[0].audio!==false||window.cameraOptions[0].video.facingMode.ideal!=='environment')throw Error('Expected rear camera without microphone');});
 await page.screenshot({path:${JSON.stringify(path.join(output,'mobile-inventory-scan-result-375.png'))}});
 await page.evaluate(()=>window.cameraMode='blank');await open();await page.waitForFunction(()=>document.querySelector('video')?.readyState===4);await page.screenshot({path:${JSON.stringify(path.join(output,'mobile-inventory-scanner-375.png'))}});
 await page.click('.mobile-inventory-scanner .el-dialog__footer button:has-text("关闭")');await page.waitForFunction(()=>!document.querySelector('.mobile-inventory-scanner')&&window.cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 for(const [mode,text] of [['denied','未获得摄像头权限'],['missing','没有找到可用摄像头'],['busy','摄像头暂时无法使用']]){
  console.log('ERROR_MODE',mode);await page.evaluate(value=>window.cameraMode=value,mode);await open();await page.waitForFunction(value=>document.querySelector('.mobile-inventory-scanner')?.textContent.includes(value),text);
  await page.click('.mobile-inventory-scanner .el-dialog__footer button:has-text("关闭")');await page.waitForFunction(()=>!document.querySelector('.mobile-inventory-scanner'));
 }
 await page.evaluate(()=>window.cameraMode='pending');await open();await page.waitForFunction(()=>!!window.resolveCamera);
 await page.click('.mobile-inventory-scanner .el-dialog__footer button:has-text("关闭")');
 await page.evaluate(()=>window.resolveCamera());await page.waitForFunction(()=>window.cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 await page.evaluate(()=>{window.resolveCamera=null;window.cameraMode='pending';});await open();await page.waitForFunction(()=>!!window.resolveCamera);
 await page.evaluate(()=>window.dispatchEvent(new Event('erp:auth-scope-changed')));await page.waitForFunction(()=>!document.querySelector('.mobile-inventory-scanner'));
 await page.evaluate(()=>window.resolveCamera());await page.waitForFunction(()=>window.cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 await page.evaluate(()=>{if(window.mobileUiErrors.length)throw Error(window.mobileUiErrors.join(';'));if(document.documentElement.scrollWidth>innerWidth)throw Error('Mobile overflow');});
 console.log('MOBILE_INVENTORY_SCAN_OK');await task.finish({keep:[]});
 `;
 try{
  const result=await promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:110000,maxBuffer:1024*1024});
  await fs.writeFile(path.join(output,'mobile-inventory-scan.log'),result.stdout+result.stderr);
  assert.match(result.stdout+result.stderr,/MOBILE_INVENTORY_SCAN_OK/);
  const search=calls.filter(call=>call.path==='/api/products'&&call.query.query==='1-7');
  assert.equal(search.length,1);assert.equal(search[0].query.searchMode,'inventory_id');assert.equal(search[0].query.page,'1');
  assert.equal(calls.filter(call=>call.method!=='GET').length,0,'scanning never changes stock');
 }finally{await server.close();await fs.rm(server.config.cacheDir,{recursive:true,force:true});}
});

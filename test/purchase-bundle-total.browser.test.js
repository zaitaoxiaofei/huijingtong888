import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {startPagedWorkspacePreview} from './fixtures/paged-workspace-preview.js';

test('bundle purchase review only needs quantity and a single total', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const posts=[];
 const components=[{id:10,product_id:10,name:'演示配件甲',inventory_number:'DEMO-10',per_set_quantity:1,quantity:50,purchase_cost:3},{id:11,product_id:11,name:'演示配件乙',inventory_number:'DEMO-11',per_set_quantity:1,quantity:50,purchase_cost:1.875}];
 const context={revision:'revision-A',product:{name:'演示配件甲套装'},batch:{id:901,quantity:50,amount:225,shipping_amount:3},components};
 const server=await startPagedWorkspacePreview({stableDeps:true,apiHandler(req,res,url,send){
  if(url.pathname==='/api/inventory-workflow/purchase-arrivals'){send({rows:[{id:901,product_id:99,product_name:'演示配件甲套装',quantity:50,review_required:true,components,affected_bundles:[],purchased_at:'2026-11-01 01:00:00'}],total:1,summary:{open:1}});return true;}
  if(url.pathname==='/api/inventory-workflow/purchase-bundle'){
   if(req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{posts.push(JSON.parse(body));send({ok:true});});}
   else send(context);return true;
  }
  return false;
 }});
 const script=`const task=await taskSpace('bundle-review-simple-total-20261104');console.log({space:task.spaceId});const page=task.page('p1');
 await page.goto('http://localhost:8788/admin.html?bundleqa='+Date.now()+'#/procurement/workspace');await page.waitForSelector('[data-task="incoming"]');console.log(await page.snapshot());await page.click('[data-task="incoming"]');await page.waitForSelector('text="确认历史采购内容"');console.log(await page.snapshot());await page.click('text="确认历史采购内容"');await page.waitForSelector('input[aria-label="采购总费用"]');console.log(await page.snapshot());
 await page.evaluate(()=>{const root=document.querySelector('.bundle-review');if(root.querySelectorAll('.el-input-number').length!==2)throw Error('whole purchase must only have two number inputs');if(root.querySelector('.el-collapse-item__wrap').offsetHeight!==0)throw Error('allocation should be collapsed');});
 await page.fill('input[aria-label="购买套数"]','40');await page.press('input[aria-label="购买套数"]','Tab');await page.fill('input[aria-label="采购总费用"]','228');await page.press('input[aria-label="采购总费用"]','Tab');await page.click('.el-dialog__footer .el-button--primary');await page.waitForSelector('.el-message-box');console.log(await page.snapshot());await page.click('.el-message-box__btns .el-button--primary');await page.waitForFunction(()=>!document.querySelector('.bundle-review'));
 await page.click('text="确认历史采购内容"');await page.waitForSelector('input[aria-label="采购总费用"]');await page.click('text="只买了部分配件"');await page.waitForSelector('[aria-label="购买演示配件甲"]');console.log(await page.snapshot());await page.click('[aria-label="购买演示配件甲"]');await page.fill('input[aria-label="演示配件甲购买数量"]','7');await page.press('input[aria-label="演示配件甲购买数量"]','Tab');await page.fill('input[aria-label="采购总费用"]','35');await page.press('input[aria-label="采购总费用"]','Tab');await page.click('.el-dialog__footer .el-button--primary');await page.waitForSelector('.el-message-box');console.log(await page.snapshot());await page.click('.el-message-box__btns .el-button--primary');await page.waitForFunction(()=>!document.querySelector('.bundle-review'));await page.evaluate(()=>{if(window.layoutErrors.length)throw Error(window.layoutErrors.join(';'));});console.log('BUNDLE_TOTAL_OK');await task.finish({keep:[]});`;
 try{
  const run=promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:165000,maxBuffer:1024*1024});run.child.stdin.end();let output;
  try{output=await run;}catch(error){await fs.writeFile('/private/tmp/bundle-total-browser.log',(error.stdout||'')+(error.stderr||''));throw error;}
  await fs.writeFile('/private/tmp/bundle-total-browser.log',output.stdout+output.stderr);assert.match(output.stdout+output.stderr,/BUNDLE_TOTAL_OK/);
  assert.equal(posts.length,2);assert.equal(posts[0].set_quantity,40);assert.equal(posts[0].total_amount,228);assert.equal(posts[0].allocation_mode,'total');
  assert.equal(posts[1].mode,'parts');assert.equal(posts[1].total_amount,35);assert.equal(posts[1].confirm_amount_change,true);assert.deepEqual(posts[1].items,[{product_id:10,quantity:7}]);assert.ok(posts[1].note);
 }finally{await server.close();}
});

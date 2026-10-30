import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {buildInventoryOperationsPreview} from '../scripts/build-inventory-operations-preview.mjs';
test('four-queue design demonstrates net purchasing, arrival and physical receipt without production calls',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:90000},async()=>{
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-operations-design-'));let browser;
 try{
  await buildInventoryOperationsPreview(out);browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[],apiCalls=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8788/**',async route=>{const u=new URL(route.request().url());if(u.pathname.startsWith('/api/')){apiCalls.push(u.pathname);return route.fulfill({status:404});}const file=path.join(out,u.pathname==='/'?'index.html':u.pathname.slice(1));return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(file)});});
  await page.goto('http://localhost:8788/');await page.getByText('建议总采购 73 件',{exact:true}).waitFor();
  await page.locator('.search-left .el-select').nth(1).click();await page.getByRole('option',{name:'库存编号精确',exact:true}).click();await page.getByRole('textbox',{name:'搜索内容',exact:true}).fill('21');await page.getByText('货源已覆盖，当前没有新的采购缺口',{exact:true}).waitFor();await page.getByRole('textbox',{name:'搜索内容',exact:true}).fill('21-4');await page.getByText('建议总采购 73 件',{exact:true}).waitFor();await page.getByRole('button',{name:'重置',exact:true}).click();await page.getByRole('button',{name:'精确搜索',exact:true}).click();for(const label of ['核心品名','汽车品牌','车型','颜色','款式','材质','工艺'])assert.equal(await page.locator('.preview-precise-fields label').filter({hasText:label}).locator('.el-select').count(),1);
  assert.equal(await page.locator('[aria-label="采购需求"]').count(),1);await page.getByRole('button',{name:'应用筛选',exact:true}).click();await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/inventory-operations-required.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button').filter({hasText:'保障补货'}).first().click();await page.getByText('建议总采购 6 件',{exact:true}).waitFor();assert.equal(await page.getByText('建议总采购 73 件',{exact:true}).count(),0,'required and advisory purchase queues are mutually exclusive');
  await page.getByRole('button').filter({hasText:'采购待到货'}).first().click();await page.locator('[aria-label="采购待到货"]').waitFor();await page.screenshot({path:'.verification/inventory-operations-incoming.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button').filter({hasText:'到货待验收'}).first().click();await page.locator('[aria-label="到货待验收"]').waitFor();await page.screenshot({path:'.verification/inventory-operations-receiving.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button').filter({hasText:'必须采购'}).first().click();await page.getByRole('button',{name:'登记采购',exact:true}).click();const buying=page.getByRole('dialog',{name:'登记采购',exact:true});assert.equal(await buying.getByRole('spinbutton',{name:'采购数量'}).inputValue(),'73');await buying.getByRole('button',{name:'确认登记采购',exact:true}).click();await page.getByText('货源已覆盖，当前没有新的采购缺口',{exact:true}).waitFor();
  await page.getByRole('button').filter({hasText:'采购待到货'}).first().click();const row=page.locator('tr').filter({hasText:'CG-DEMO-1004'});await row.getByRole('button',{name:'确认到货',exact:true}).click();await page.getByRole('button',{name:'确认本批次到货',exact:true}).click();
  await page.getByRole('button').filter({hasText:'到货待验收'}).first().click();const received=page.locator('tr').filter({hasText:'CG-DEMO-1004'});await received.getByText('本地实物 2 件',{exact:true}).waitFor();await received.getByRole('button',{name:'登记入库',exact:true}).click();await page.getByRole('button',{name:'确认验收入库',exact:true}).click();assert.equal(await page.locator('tr').filter({hasText:'CG-DEMO-1004'}).count(),0,'received batch leaves the acceptance queue');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'.verification/inventory-operations-mobile.png',fullPage:true,animations:'disabled'});assert.deepEqual(apiCalls,[]);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(out,{recursive:true,force:true});}
});

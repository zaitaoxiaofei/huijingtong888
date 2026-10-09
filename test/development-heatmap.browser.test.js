import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';

test('development heatmap uses priority quadrants, granular task points, click-to-order planning and stable pan/zoom', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1'}, async()=>{
 const entry=`import {createApp,h} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Heatmap from '/frontend/admin/components/team/DevelopmentHeatmap.vue';createApp({render:()=>h(Heatmap,{onOpenTask:payload=>{window.openedTask=payload.task.id;window.openedModelIndex=payload.modelIndex;window.openedDimension=payload.dimension}})}).use(ElementPlus).mount('#app');`;
 const output = await fs.mkdtemp(path.join(os.tmpdir(), 'heatmap-browser-'));
 await build({ configFile:false, root:process.cwd(), logLevel:'error', plugins:[vue(), {
   name:'heatmap-fixture', resolveId(id){if(id==='virtual:heatmap')return '\0heatmap';}, load(id){if(id==='\0heatmap')return entry;}
 }], build:{outDir:output, cssCodeSplit:false, rollupOptions:{input:'virtual:heatmap',output:{entryFileNames:'entry.js'}}} });
 let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1000}}); page.setDefaultTimeout(15000); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8788/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/admin.html') return route.fulfill({contentType:'text/html',body:'<html><head><link rel="stylesheet" href="/style.css"></head><body style="margin:24px;background:#edf2f7;font-family:Arial"><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
    const file = url.pathname === '/style.css' ? (await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css')) : null;
    const filePath = file ? path.join(output,'assets',file) : path.join(output,url.pathname);
    await route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(filePath)});
  });
  let fail=false;
  const today=new Date().toISOString();
  const tasks=[];
  const brands=['TENET','HAVAL','CHERY','GEELY','LADA','CHANGAN','VOLGA','JELAND'];
  const categories=['汽车钥匙保护壳','门槛条','脚垫','方向盘套','后备箱垫','遮阳帘','气嘴帽','座椅保护套'];
  for(let b=0;b<brands.length;b++)for(let c=0;c<categories.length;c++){
   const id=b*10+c+1;tasks.push({id,type:'product_development',title:`${brands[b]} ${categories[c]}开发`,owner_name:'测试负责人',owner_person_id:b+1,owner_avatar_url:'https://example.test/avatar.png',created_at:today,due_at:'2026-10-31',priority:b===0&&c===0?'urgent_important':'medium',status:b===0&&c===1?'done':'doing',development_plan:{brand:brands[b],category:categories[c],models:[{model_id:b+1,model:['T7','JOLION','TIGGO 7','MONJARO','VESTA','CS55','K50','J6'][b],target:30,drafts:[{id,count:Math.max(0,40-b*4-c*3),created_at:today}]}]}});
  }
  tasks.push({id:200,type:'product_development',title:'收纳袋开发',created_at:today,development_plan:{brand:'非汽车',scope:'non_automotive',category:'收纳袋',models:[{model_id:0,model:'非汽车',target:20,drafts:[{id:200,count:9,created_at:today}]}]}});
  let savedPlans=[];
  await page.route('**/api/team/development-heatmap-orders**',async route=>{if(route.request().method()==='PUT'){const body=route.request().postDataJSON();savedPlans=[...savedPlans,...body.entries];return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,saved:body.entries.length})});}return route.fulfill({contentType:'application/json',body:JSON.stringify(savedPlans)});});
  await page.route('**/api/team/tasks',route=>route.fulfill({status:fail?500:200,contentType:'application/json',body:JSON.stringify(fail?{error:'测试加载失败'}:tasks)}));
  await page.goto('http://localhost:8788/admin.html');
  const cell=page.getByRole('button',{name:'汽车钥匙保护壳 · TENET · T7：1 个任务',exact:true});await cell.waitFor();
  const urgentStyle=await cell.evaluate(node=>({background:getComputedStyle(node).backgroundImage,accent:getComputedStyle(node).borderLeftColor}));assert.match(urgentStyle.background,/linear-gradient/);assert.match(urgentStyle.accent,/rgb\(220, 53, 69\)/);
  assert.equal(await page.locator('.quadrant-10 .quadrant-point').count(),1);
  assert.ok(await page.locator('.quadrant-7 .quadrant-point').count()>0);
  const completedCell=page.getByRole('button',{name:'门槛条 · TENET · T7：1 个任务',exact:true});const completedStyle=await completedCell.evaluate(node=>({background:getComputedStyle(node).backgroundImage,accent:getComputedStyle(node).borderLeftColor}));assert.match(completedStyle.background,/linear-gradient/);assert.match(completedStyle.accent,/rgb\(34, 160, 107\)/);
  await cell.hover();await page.getByText('TENET 汽车钥匙保护壳开发',{exact:true}).waitFor();
  const viewportBox=await page.locator('.heatmap-viewport').boundingBox();await page.mouse.move(viewportBox.x+viewportBox.width/2,viewportBox.y+viewportBox.height/2);await page.mouse.wheel(0,-120);await page.getByText('106%',{exact:true}).waitFor();
  for(let i=0;i<8;i++)await page.getByRole('button',{name:'放大热力图'}).click();const viewport=page.locator('.heatmap-viewport');const beforePan=await viewport.evaluate(node=>node.scrollLeft);const cellBox=await cell.boundingBox();await page.mouse.move(cellBox.x+cellBox.width/2,cellBox.y+cellBox.height/2);await page.mouse.down();await page.mouse.move(cellBox.x+cellBox.width/2-100,cellBox.y+cellBox.height/2);await page.mouse.up();const panState=await viewport.evaluate(node=>({left:node.scrollLeft,top:node.scrollTop,width:node.scrollWidth,clientWidth:node.clientWidth,classes:node.className}));assert.ok(panState.left>beforePan||panState.top>0,JSON.stringify({beforePan,panState}));await page.getByRole('button',{name:'重置'}).click();
  await page.getByRole('button',{name:'人工排程'}).click();await cell.hover();assert.match(await cell.evaluate(node=>getComputedStyle(node).animationName),/plan-point-pulse/);await cell.click({force:true});await page.getByText(/已选 1 个车型 · 1 个任务/).waitFor();assert.ok((await cell.getAttribute('class')).includes('selected'));assert.equal(await cell.locator('.point-sequence').textContent(),'1');
  const secondPoint=page.locator('.quadrant-point[aria-label*="门槛条 · TENET · T7"]');await secondPoint.click({force:true});await page.getByText(/已选 1 个车型 · 2 个任务/).waitFor();assert.equal(await page.locator('.quadrant-point.selected .point-sequence').count(),2);
  await cell.click({button:'right',force:true});await page.getByText(/已选 1 个车型 · 1 个任务/).waitFor();assert.equal(await secondPoint.locator('.point-sequence').textContent(),'1');
  await cell.click({force:true});assert.equal(await cell.locator('.point-sequence').textContent(),'2');await page.getByRole('button',{name:'保存排程'}).click();await page.locator('.point-sequence').filter({hasText:'1'}).waitFor();assert.deepEqual(savedPlans.map(plan=>plan.sequence),[2,1]);
  await page.getByRole('button',{name:'退出排程'}).click();
  await page.screenshot({path:'/tmp/development-heatmap.png',fullPage:true});
  const updatedCell=page.getByRole('button',{name:'汽车钥匙保护壳 · TENET · T7：1 个任务',exact:true});await updatedCell.click();assert.equal(await page.evaluate(()=>window.openedTask),1);assert.equal(await page.evaluate(()=>window.openedModelIndex),0);assert.equal(await page.evaluate(()=>window.openedDimension),'model');
  await page.getByText('按品牌',{exact:true}).click();const brandCell=page.getByRole('button',{name:'汽车钥匙保护壳 · TENET：1 个任务',exact:true});await brandCell.waitFor();await page.getByRole('button',{name:'人工排程'}).click();await brandCell.click();await page.getByText(/已选 1 个品牌 · 1 个任务/).waitFor();await page.getByRole('button',{name:'退出排程'}).click();
  await page.locator('.el-select').filter({has:page.getByRole('combobox',{name:'开发范围',exact:true})}).click();await page.getByRole('option',{name:'非汽车',exact:true}).click();
  assert.equal(await page.locator('.quadrant-point').count(),1);
  await page.getByRole('button',{name:'收纳袋 · 非汽车：1 个任务',exact:true}).waitFor();
  await page.locator('.el-select').filter({has:page.getByRole('combobox',{name:'统计数量'})}).click();await page.getByRole('option',{name:'计划开发 SKU',exact:true}).click();
  await page.getByRole('button',{name:'收纳袋 · 非汽车：20 个 SKU',exact:true}).waitFor();
  await page.getByText('自定义',{exact:true}).click();
  await page.getByPlaceholder('开始日期').fill('2025-01-01');await page.getByPlaceholder('结束日期').fill('2025-01-31');await page.getByPlaceholder('结束日期').press('Enter');
  await page.getByText('当前范围暂无可归类的开发记录，可调整时间或新增开发任务',{exact:true}).waitFor();
  fail=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('button',{name:'重新加载',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

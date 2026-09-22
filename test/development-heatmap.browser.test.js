import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright-core';

test('development heatmap supports metrics, brand aggregation, time, non-car and task details', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1'}, async()=>{
 const entry=`import {createApp,h} from 'vue';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Heatmap from '/frontend/admin/components/team/DevelopmentHeatmap.vue';createApp({render:()=>h(Heatmap,{onOpenTask:row=>window.openedTask=row.id})}).use(ElementPlus).mount('#app');`;
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
   const id=b*10+c+1;tasks.push({id,type:'product_development',title:`${brands[b]} ${categories[c]}开发`,owner_name:'测试负责人',created_at:today,due_at:'2026-12-31',development_plan:{brand:brands[b],category:categories[c],models:[{model_id:b+1,model:['T7','JOLION','TIGGO 7','MONJARO','VESTA','CS55','K50','J6'][b],target:30,drafts:[{id,count:Math.max(0,40-b*4-c*3),created_at:today}]}]}});
  }
  tasks.push({id:200,type:'product_development',title:'收纳袋开发',created_at:today,development_plan:{brand:'非汽车',scope:'non_automotive',category:'收纳袋',models:[{model_id:0,model:'非汽车',target:20,drafts:[{id:200,count:9,created_at:today}]}]}});
  await page.route('**/api/team/tasks',route=>route.fulfill({status:fail?500:200,contentType:'application/json',body:JSON.stringify(fail?{error:'测试加载失败'}:tasks)}));
  await page.goto('http://localhost:8788/admin.html');
  const cell=page.getByRole('button',{name:'TENET · T7 · 汽车钥匙保护壳：40 个 SKU',exact:true});await cell.waitFor();
  await page.screenshot({path:'/tmp/development-heatmap.png',fullPage:true});
  await cell.click();await page.getByRole('dialog').getByRole('button',{name:'查看任务'}).click();assert.equal(await page.evaluate(()=>window.openedTask),1);
  await page.getByText('按品牌',{exact:true}).click();await page.getByRole('button',{name:'TENET · 汽车钥匙保护壳：40 个 SKU',exact:true}).waitFor();
  await page.locator('.el-select').filter({has:page.getByRole('combobox',{name:'开发范围',exact:true})}).click();await page.getByRole('option',{name:'非汽车',exact:true}).click();
  assert.equal(await page.locator('.heatmap-scroll tbody tr').count(),1);
  await page.getByRole('button',{name:'非汽车 · 收纳袋：9 个 SKU',exact:true}).waitFor();
  await page.locator('.el-select').filter({has:page.getByRole('combobox',{name:'统计数量'})}).click();await page.getByRole('option',{name:'计划开发 SKU',exact:true}).click();
  await page.getByRole('button',{name:'非汽车 · 收纳袋：20 个 SKU',exact:true}).waitFor();
  await page.getByText('自定义',{exact:true}).click();
  await page.getByPlaceholder('开始日期').fill('2025-01-01');await page.getByPlaceholder('结束日期').fill('2025-01-31');await page.getByPlaceholder('结束日期').press('Enter');
  await page.getByText('当前范围暂无可归类的开发记录，可调整时间或新增开发任务',{exact:true}).waitFor();
  fail=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('button',{name:'重新加载',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

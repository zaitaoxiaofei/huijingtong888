import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {demoUser} from './fixtures/inventory-role-workspace.js';

test('bundle purchase review only needs quantity and a single total', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'bundle-review-browser-'));let browser;
 const posts=[],errors=[];
 const components=[{id:10,product_id:10,name:'演示配件甲',inventory_number:'DEMO-10',per_set_quantity:1,quantity:50,purchase_cost:3},{id:11,product_id:11,name:'演示配件乙',inventory_number:'DEMO-11',per_set_quantity:1,quantity:50,purchase_cost:1.875}];
 const context={revision:'revision-A',product:{name:'演示配件甲套装'},batch:{id:901,quantity:50,amount:225,shipping_amount:3},components};
 try{
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'bundle-total-fixture',resolveId(id){if(id==='virtual:bundle-total')return '\0bundle-total';},load(id){if(id==='\0bundle-total')return `import {createApp,h} from 'vue';import {createPinia} from 'pinia';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import Queue from '/frontend/admin/components/procurement/InventoryPurchaseBatchQueue.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const pinia=createPinia(),app=createApp({render:()=>h(Queue,{status:'open',filters:{}})});app.use(pinia);const auth=useAuthStore();auth.user=${JSON.stringify(demoUser)};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('bundle-review-fixture');app.use(ElementPlus).mount('#app');`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:bundle-total',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1080}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(request.method()==='POST'){assert.equal(url.pathname,'/api/inventory-workflow/purchase-bundle');posts.push(request.postDataJSON());return json({ok:true});}
   if(url.pathname==='/api/inventory-workflow/purchase-arrivals')return json({rows:[{id:901,product_id:99,product_name:'演示配件甲套装',quantity:50,review_required:true,is_bundle:true,components,affected_bundles:[],purchased_at:'2026-11-01 01:00:00'}],total:1,summary:{open:1},days:[{date:'2026-11-01',open:1,arrived:0,total:1}],selected_day:'2026-11-01'});
   if(url.pathname==='/api/inventory-workflow/purchase-bundle')return json(context);
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return json({rows:[]});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html');await page.getByRole('button',{name:'核对套装采购内容',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'核对套装采购内容',exact:true}).filter({has:page.locator('.bundle-review')});await dialog.waitFor();
  await dialog.getByText('仅历史按整套登记、尚未明确实际配件的采购批次需要核对；核对完成后才能确认到货或验收入库。',{exact:true}).waitFor();
  assert.equal(await dialog.locator('.el-input-number').count(),2);assert.equal(await dialog.locator('.el-collapse-item__wrap').isVisible(),false);
  await dialog.getByRole('spinbutton',{name:'购买套数',exact:true}).fill('40');await dialog.getByRole('spinbutton',{name:'购买套数',exact:true}).blur();
  await dialog.getByRole('spinbutton',{name:'采购总费用',exact:true}).fill('228');await dialog.getByRole('spinbutton',{name:'采购总费用',exact:true}).blur();
  await dialog.getByRole('button',{name:'确认保存',exact:true}).click();await page.locator('.el-message-box').getByRole('button',{name:'确认保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'核对套装采购内容',exact:true}).click();await dialog.waitFor();await dialog.getByText('只买了部分配件',{exact:true}).click();
  await dialog.getByRole('checkbox',{name:'购买演示配件甲',exact:true}).locator('..').click();await dialog.getByRole('spinbutton',{name:'演示配件甲购买数量',exact:true}).fill('7');await dialog.getByRole('spinbutton',{name:'演示配件甲购买数量',exact:true}).blur();
  await dialog.getByRole('spinbutton',{name:'采购总费用',exact:true}).fill('35');await dialog.getByRole('spinbutton',{name:'采购总费用',exact:true}).blur();
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/purchase-bundle-review-renamed.png',fullPage:true,animations:'disabled'});
  await dialog.getByRole('button',{name:'确认保存',exact:true}).click();await page.locator('.el-message-box').getByRole('button',{name:'确认保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(posts.length,2);assert.equal(posts[0].set_quantity,40);assert.equal(posts[0].total_amount,228);assert.equal(posts[0].allocation_mode,'total');
  assert.equal(posts[1].mode,'parts');assert.equal(posts[1].total_amount,35);assert.equal(posts[1].confirm_amount_change,true);assert.deepEqual(posts[1].items,[{product_id:10,quantity:7}]);assert.ok(posts[1].note);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

import test from 'node:test';import assert from 'node:assert/strict';
import {build} from 'vite';import vue from '@vitejs/plugin-vue';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {chromium} from 'playwright-core';
import {demoUser,demoRows,demoLedgers,demoForecasts,demoOpportunities} from './fixtures/inventory-role-workspace.js';
import {inventoryWorkspacePage} from '../src/shared/inventory-workspace.js';
test('role workspace previews real views, preserves printing, opens receipt/stock/FBP workflows and clears tenant scope', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'role-workspace-browser-'));let browser;
 try{
  await fs.mkdir('.verification',{recursive:true});
  await build({configFile:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'workspace-fixture',
   resolveId(id){if(id==='virtual:workspace')return '\0workspace';},
   load(id){
    if(id==='\0workspace')return `import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createMemoryHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import 'element-plus/theme-chalk/dark/css-vars.css';import Orders from '/frontend/admin/views/orders/OrdersView.vue';import Procurement from '/frontend/admin/views/procurement/ProcurementWorkspaceView.vue';import Operations from '/frontend/admin/views/inventory/InventoryFbpOpportunitiesPage.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});const pinia=createPinia();app.use(pinia);const auth=useAuthStore();const user=${JSON.stringify(demoUser)};auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('preview-token');currentApiCacheScope();window.previewAuth=auth;window.previewScope=()=>{auth.user={...user,id:2,personId:2,tenant:{id:3,slug:'other',role:'owner'}};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));setAuthToken('other-preview-token');};const router=createRouter({history:createMemoryHistory(),routes:[{path:'/orders',component:Orders},{path:'/procurement/workspace',component:Procurement},{path:'/inventory/fbp-opportunities',component:Operations}]});window.previewRouter=router;app.use(ElementPlus).use(router);await router.push('/orders');await router.isReady();app.mount('#app');`;
   }}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:workspace',output:{entryFileNames:'entry.js',chunkFileNames:'chunks/[name]-[hash].js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1600,height:1060}}),errors=[],posts=[];let otherScope=false,workspaceReads=0,workspaceFail=false,manualRefresh=false,snapshotMode='ready',forceReads=0,statusReads=0,currentCovered=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://localhost:8788/**',async route=>{
   const url=new URL(route.request().url()),json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:var(--el-bg-color-page);font-family:Arial,sans-serif;color:var(--el-text-color-primary)}.preview-banner{padding:12px 28px;background:#15253c;color:#c9defa;font-size:13px}#app{padding:24px;max-width:1550px;margin:auto;box-sizing:border-box}</style></head><body><div class="preview-banner">爆单 ERP · 库存联动开发预览 · 以下均为演示数据，不连接生产</div><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname.includes('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" rx="6" fill="#e5edf6"/><path d="M15 30h34v30H15zM15 30l17-10 17 10-17 9zM32 39v21" fill="#a9bfd9" stroke="#6685aa"/><text x="32" y="76" font-size="9" text-anchor="middle" fill="#6685aa">预览图</text></svg>'});
   const id=Number(url.searchParams.get('product_id'))||101,ledger=demoLedgers.get(id)||demoLedgers.get(101),forecast=demoForecasts.get(id)||demoForecasts.get(101);
   if(url.pathname.startsWith('/api/')&&route.request().method()!=='GET'){const body=route.request().postDataJSON();posts.push({path:url.pathname,body});if(url.pathname==='/api/inventory-flow/sync')return json({ok:true,background:true,task:{status:'completed'}});return json({ok:true,notified:2,rows:[],status:'completed'});}
   if(url.pathname==='/api/inventory-workflow/alerts'){workspaceReads++;if(url.searchParams.get('refresh')==='1'){forceReads++;snapshotMode='updating';}if(workspaceFail){manualRefresh=url.searchParams.get('refresh')==='1';return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'系统繁忙，请稍后重试'})});}return json({...(['warming','error'].includes(snapshotMode)?{rows:[],total:null,meta:{required:null,advisory:null,incoming:null,review:null}}:inventoryWorkspacePage(otherScope?[]:demoRows,Object.fromEntries(url.searchParams))),snapshot:{status:snapshotMode,available:!['warming','error'].includes(snapshotMode),error:snapshotMode==='error'?'后台核算失败，已保留上次成功结果，可点击重新核算重试':null,refreshing:['warming','updating'].includes(snapshotMode),stale:snapshotMode!=='ready',calculated_at:'2026-10-30T02:00:00Z'}});}
   if(url.pathname==='/api/inventory-workflow/receipts')return json({rows:[{id:301,quantity:18,order_no:'PO-DEMO-102'}]});
   if(url.pathname==='/api/inventory-workflow'&&url.searchParams.get('view')==='status'){statusReads++;if(currentCovered)return json({rows:[{product_id:id,supply_plan:{known:true,required_purchase:0,optional_purchase:0}}]});}
   if(url.pathname==='/api/inventory-workflow')return json({rows:[{...demoRows.find(r=>r.product_id===id)?.workflow,product_id:id,forecast,skus:forecast.skus}]});
   if(['/api/inventory/ledger','/api/procurement/ledger'].includes(url.pathname))return json(ledger);
   if(url.pathname==='/api/inventory-flow/sync-status')return json({task:{status:'completed'},status:'completed'});
   if(url.pathname==='/api/fbp-opportunities')return json({rows:demoOpportunities,total:demoOpportunities.length,summary:{}});
   if(url.pathname==='/api/people')return json([{id:1,name:'演示采购',active:1,role:'procurement'}]);
   if(url.pathname==='/api/shops')return json([{id:20,name:'演示店铺 M'},{id:21,name:'演示店铺 Z'}]);
   if(url.pathname==='/api/products')return json({rows:demoRows.map(r=>({id:r.product_id,name:r.product_name,code:r.inventory_number})),total:3});
   if(url.pathname.startsWith('/api/'))return json({rows:[],total:0});
   const asset=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(n=>n.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:asset.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,asset))});
  });
  await page.goto('http://localhost:8788/admin.html');
  await page.locator('.vue-orders-shell').waitFor();await page.evaluate(()=>{window.printElement=document.querySelector('.vue-orders-shell');});
  await page.getByText('库存管理',{exact:true}).first().click();
  await page.getByText(demoRows[0].product_name,{exact:true}).first().waitFor();
  assert.equal(await page.locator('.vue-orders-shell').isVisible(),false,'print workflow is retained but hidden in inventory mode');
  await page.getByText('打印与日常发货',{exact:true}).click();
  assert.equal(await page.evaluate(()=>window.printElement===document.querySelector('.vue-orders-shell')),true,'the existing daily-print component stays mounted across mode switches');
  await page.getByText('库存管理',{exact:true}).first().click();await page.getByRole('button',{name:'查看全部库存'}).click();
  await page.getByText(demoRows[1].product_name,{exact:true}).waitFor();
  await page.screenshot({path:'.verification/role-orders-inventory-light.png',fullPage:true,animations:'disabled'});
  await page.locator('tr').filter({hasText:demoRows[1].product_name}).getByRole('button',{name:'验货入库'}).click();
  await page.getByRole('dialog',{name:'登记入库',exact:true}).waitFor();
  await page.getByRole('dialog',{name:'登记入库',exact:true}).getByText('PO-DEMO-102',{exact:true}).waitFor();
  await page.screenshot({path:'.verification/role-warehouse-receipt.png',fullPage:true,animations:'disabled'});
  await page.getByRole('dialog',{name:'登记入库',exact:true}).getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('.el-overlay-dialog:visible').getByRole('button',{name:'Close this dialog'}).last().click();
  await page.locator('tr').filter({hasText:demoRows[0].product_name}).getByRole('button',{name:'反馈缺口'}).click();
  await page.getByPlaceholder('例如：核实只有12件，尚有5件订单缺口；已联系供应商补货').fill('实物核对后确认缺4件，请采购关注。');
  await page.getByRole('button',{name:'反馈并通知相关人员'}).click();
  assert.equal(posts.filter(p=>p.path==='/api/inventory-workflow/feedback').length,1);
  await page.evaluate(()=>window.previewRouter.push('/procurement/workspace'));
  await page.getByRole('heading',{name:'按库存统一采购'}).waitFor();
  await page.getByRole('button',{name:'查看全部库存'}).click();await page.getByText(demoRows[2].product_name,{exact:true}).waitFor();
  await page.locator('.el-message').first().waitFor({state:'hidden'});
  const beforeEvents=workspaceReads;await page.evaluate(()=>{for(let i=0;i<10;i++)window.dispatchEvent(new CustomEvent('erp:system-notification'));});await page.waitForTimeout(800);assert.equal(workspaceReads-beforeEvents,1,'a burst of scoped notifications coalesces into one inventory refresh');
  workspaceFail=true;await page.getByRole('button',{name:'刷新库存需求'}).click();await page.getByText('当前保留上次成功结果',{exact:false}).waitFor();assert.equal(manualRefresh,false);assert.equal(await page.getByText(demoRows[0].product_name,{exact:true}).count(),1,'failed refresh retains last successful inventory');workspaceFail=false;await page.getByRole('button',{name:'刷新库存需求'}).click();await page.locator('.el-alert--error').waitFor({state:'hidden'});
  const normalForces=forceReads;await page.getByRole('button',{name:'重新核算',exact:true}).click();await page.getByText('后台正在核对最新需求',{exact:false}).waitFor();assert.equal(forceReads,normalForces+1);assert.equal(await page.getByText(demoRows[0].product_name,{exact:true}).count(),1);snapshotMode='ready';await page.getByRole('button',{name:'刷新库存需求'}).click();
  await page.screenshot({path:'.verification/role-procurement-light.png',fullPage:true,animations:'disabled'});
  await page.evaluate(()=>{document.documentElement.classList.add('dark');document.documentElement.dataset.theme='dark';document.body.dataset.theme='dark';});
  await page.screenshot({path:'.verification/role-procurement-dark.png',fullPage:true,animations:'disabled'});
  await page.evaluate(()=>{document.documentElement.classList.remove('dark');document.documentElement.dataset.theme='light';document.body.dataset.theme='light';});
  await page.locator('tr').filter({hasText:demoRows[0].product_name}).getByRole('button',{name:'登记采购',exact:true}).click();
  const buying=page.getByRole('dialog').last();await buying.waitFor();
  assert.ok(statusReads>0,'purchase reads the latest single-product demand before prefilling');
  assert.ok((await buying.locator('input[role="spinbutton"]').evaluateAll(inputs=>inputs.map(input=>input.value))).includes('24'),'purchase prefill includes required work only, excluding optional safety');
  await page.screenshot({path:'.verification/role-procurement-create.png',fullPage:true,animations:'disabled'});
  await buying.getByRole('button',{name:'取消',exact:true}).click();
  currentCovered=true;await page.locator('tr').filter({hasText:demoRows[0].product_name}).getByRole('button',{name:'登记采购',exact:true}).click();await page.getByText('最新核对显示当前货源已覆盖需求，无需重复采购',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);currentCovered=false;
  for(const width of [1366,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'workspace keeps wide inventory table inside its own scroll area');await page.screenshot({path:`.verification/role-procurement-${width}.png`,fullPage:true,animations:'disabled'});}
  await page.setViewportSize({width:1600,height:1060});

  await page.evaluate(()=>window.previewRouter.push('/inventory/fbp-opportunities'));
  await page.getByRole('button',{name:'同库存一起备货'}).first().waitFor();
  await page.getByRole('button',{name:'同库存一起备货'}).first().click();
  await page.getByRole('button',{name:'创建FBP备货申请',exact:true}).click();
  const fbp=page.getByRole('dialog',{name:'创建FBP备货申请',exact:true});await fbp.waitFor();
  await fbp.getByText('SKU-101-2',{exact:true}).waitFor();
  await fbp.locator('.el-checkbox').first().click();
  await fbp.getByText('本次实物需求',{exact:true}).waitFor();
  await fbp.locator('.el-checkbox').nth(1).click();await fbp.getByText('44 件',{exact:true}).waitFor();
  await fbp.locator('.el-checkbox').nth(1).click();await fbp.getByText('24 件',{exact:true}).waitFor();
  await page.screenshot({path:'.verification/role-operations-grouped-fbp.png',fullPage:true,animations:'disabled'});
  await fbp.getByRole('button',{name:'提交备货申请',exact:true}).click();
  const submitted=posts.find(p=>p.path==='/api/inventory-workflow/fbp');assert.equal(submitted.body.rows.length,1,'unselected related SKU is not copied into a request');assert.equal(submitted.body.submit,true);
  await page.evaluate(()=>window.previewRouter.push('/orders?mode=inventory'));
  await page.getByText(demoRows[0].product_name,{exact:true}).first().waitFor();
  otherScope=true;await page.evaluate(()=>window.previewScope());
  await page.getByText(demoRows[0].product_name,{exact:true}).first().waitFor({state:'hidden'});
  assert.equal(await page.getByRole('dialog').count(),0,'tenant switch closes old product workflows');
  workspaceFail=true;await page.getByRole('button',{name:'刷新库存需求'}).click();await page.getByText('库存需求加载失败，请重试；这不代表没有采购需求',{exact:true}).waitFor();
  workspaceFail=false;snapshotMode='warming';await page.getByRole('button',{name:'刷新库存需求'}).click();await page.getByText('首次需求快照正在生成',{exact:false}).waitFor();assert.deepEqual(await page.locator('.supply-task strong').allTextContents(),['—','—','—','—']);assert.equal(await page.locator('.supply-workspace>.el-pagination').count(),0);
  snapshotMode='error';await page.getByRole('button',{name:'刷新库存需求'}).click();await page.getByText('尚无成功核算结果，请重新核算；不代表没有采购需求',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

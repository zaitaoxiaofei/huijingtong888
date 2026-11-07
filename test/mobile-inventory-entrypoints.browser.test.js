import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('mobile inventory list, readonly details and warehouse pending cards share stable edit/history entries',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'mobile-inventory-entries-'));let browser;
 const reads=[],writes=[],errors=[],date='2026-11-01';
 let serial=0;
 let product={id:101,name:'门槛条 旧款 1个',inventory_number:'1-3-101',component_count:0,product_type:'main',selection_status:'listed',owner_person_id:7,updated_at:'2026-11-06 01:23:45',purchase_cost:17.5,domestic_shipping:2.3,handling_fee:.8,purchase_quantity:4,stock_unit:'个',package_weight_g:321,length_cm:32,width_cm:21,height_cm:11,exchange_rate:11.3,return_rate:.05,source_platform:'1688',purchase_url:'https://detail.1688.com/old.html',composition_items:[],structured_naming:{category:'门槛条',accessory:'旧款',quantity:1,stock_unit:'个',fitment_type:'universal',vehicle_brand:'',vehicle_models:[],colors:[],materials:[],package_mode:'single'}};
 const originalCosts={purchase_cost:product.purchase_cost,domestic_shipping:product.domestic_shipping,handling_fee:product.handling_fee};
 const batch={id:501,product_id:101,quantity:80,physical_quantity:80,status:'pending_arrival',received_at:'2026-11-06 02:00:00',updated_at:'2026-11-06 01:00:00',purchased_at:`${date} 01:00:00`,order_no:'PO-501',components:[]};
 const entry=`import{createApp,h}from'vue';import{createPinia}from'pinia';import{createRouter,createWebHashHistory,RouterView}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import'/frontend/admin/styles/index.css';import'/frontend/admin/styles/erp-theme.css';import Layout from'/frontend/admin/layouts/MobileLayout.vue';import Inventory from'/frontend/admin/views/mobile/MobileInventoryView.vue';import{useAuthStore}from'/frontend/admin/stores/auth.js';import{setAuthToken}from'/frontend/admin/utils/api.js';const app=createApp({render:()=>h(RouterView)});app.use(createPinia());const auth=useAuthStore(),user={id:7,personId:7,name:'库存入口验证',roles:['procurement'],tenant:{id:2,slug:'a',role:'member'}};auth.user=user;localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('inventory-entry-fixture');window.entryRoles=roles=>{auth.user={...auth.user,roles};localStorage.setItem('baodanAuthUser',JSON.stringify(auth.user));};const router=createRouter({history:createWebHashHistory(),routes:[{path:'/mobile',component:Layout,children:[{path:'inventory',component:Inventory,meta:{title:'手机库存'}}]}]});app.use(router).use(ElementPlus);app.mount('#app');`;
 try{
  await build({configFile:false,root:process.cwd(),publicDir:false,logLevel:'error',plugins:[vue(),{name:'mobile-inventory-entry-fixture',resolveId(id){if(id==='virtual:inventory-entry')return'\0inventory-entry';},load(id){if(id==='\0inventory-entry')return entry;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:inventory-entry',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),reply=value=>route.fulfill({json:value});
   if(url.origin!=='http://localhost:8788')return route.abort();
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/entry.js"></script>'});
   if(request.method()!=='GET'){
    const body=request.postDataJSON();writes.push({path:url.pathname,method:request.method(),body});assert.equal(url.pathname,'/api/products/101');assert.equal(request.method(),'PUT');
    const style=body.structured_naming.accessory;product={...product,...body,name:`门槛条 ${style} 1个`,inventory_number:`1-3-${201+serial++}`,updated_at:'2026-11-07 01:00:00'};
    return reply({ok:true,product}); // Match the actual catalog API, including its envelope.
   }
   if(url.pathname.startsWith('/api/'))reads.push(url.pathname+url.search);
   if(url.pathname==='/api/products')return reply({rows:[product],page:Number(url.searchParams.get('page')||1),total:60});
   if(url.pathname==='/api/products/101')return reply(product);
   if(url.pathname==='/api/inventory-workflow')return reply({rows:[{product_id:101,physical_stock:7,workflow_free:5}]});
   if(url.pathname==='/api/inventory/ledger')return reply({revision:'ledger-current',physical_estimate:7,open_order_demand:2,fbp_reserved:0,flow_summary:{safety:0},orders:[],actions:[]});
   if(url.pathname==='/api/inventory-workflow/purchase-arrivals')return reply({rows:[{...batch,product_name:product.name,inventory_number:product.inventory_number}],days:[{date,open:0,arrived:1,arrived_quantity:80}],selected_day:date,page:1,total:1});
   if(url.pathname==='/api/products/101/edit-history')return reply({current:{id:101,name:product.name,inventory_number:product.inventory_number},number_aliases:[{number:'1-3-101',recorded_at:'2026-11-06 16:00:00'}],name_aliases:[],history_notice:'旧编号与旧名称分别留存，不代表同一次修改。',total:1,page:1,rows:[{id:1,recorded_at:'2026-11-06 16:00:00',actor:{id:7,name:'库存负责人'},source:'catalog_edit',source_label:'库存资料编辑',changed_fields:['name'],before:{name:'门槛条 旧款 1个'},after:{name:product.name}}]});
   if(url.pathname==='/api/people')return reply([{id:7,name:'库存负责人',active:1}]);
   if(url.pathname==='/api/suppliers')return reply({rows:[]});
   if(url.pathname==='/api/logistics-rules')return reply([]);
   if(url.pathname==='/api/inventory-product-naming/options'){
    const type=url.searchParams.get('type'),values=type==='category'?['门槛条']:type==='accessory'?['旧款','新款','详情改款','验收改款']:type==='quantity'?['1']:[];return reply({rows:values.map(value=>({value,label:value}))});
   }
   if(url.pathname.endsWith('/image'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="84"><rect width="64" height="84" fill="#779bbb"/></svg>'});
   if(url.pathname.startsWith('/api/'))return reply({rows:[],total:0,brands:[]});
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):decodeURIComponent(url.pathname.slice(1));return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/mobile/inventory');
  const card=page.locator('.mobile-inventory-page>.mobile-list-scroll>.mobile-record').first(),editor=page.locator('.selection-form-dialog--mobile');
  await card.getByRole('button',{name:'编辑库存',exact:true}).waitFor();await card.getByRole('button',{name:'历史版本',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'搜索内容',exact:true}).fill('1-3-101');await page.getByRole('button',{name:'查询',exact:true}).click();await page.getByRole('button',{name:'下一页',exact:true}).click();
  await page.waitForFunction(()=>{const input=document.querySelector('.mobile-inventory-page>.mobile-list-footer input');return input?.value==='2'&&!input.disabled;});
  const saveStyle=async(style,button)=>{
   await button.click();await editor.waitFor();await editor.getByRole('tab',{name:'名称规格',exact:true}).click();
   const input=editor.locator('.el-form-item').filter({has:page.locator('.el-form-item__label').getByText('款式',{exact:true})});await input.locator('.el-select__wrapper').click();await page.getByRole('option',{name:style,exact:true}).click();
   await editor.getByRole('tab',{name:'采购物流',exact:true}).click();await editor.getByPlaceholder('https://detail.1688.com/...',{exact:true}).waitFor();
   await editor.locator('.el-dialog__footer').getByRole('button',{name:'保存',exact:false}).click();await editor.waitFor({state:'hidden'});
  };
  await saveStyle('新款',card.getByRole('button',{name:'编辑库存',exact:true}));
  await card.getByRole('heading',{name:'门槛条 新款 1个',exact:true}).waitFor();assert.equal(await page.getByRole('spinbutton',{name:'当前页',exact:true}).inputValue(),'2');
  await fs.mkdir('.verification',{recursive:true});for(const width of [320,375,430]){await page.setViewportSize({width,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(width===375)await page.screenshot({path:'.verification/mobile-inventory-list-entries-375.png',animations:'disabled'});}
  let listRead=reads.filter(url=>url.startsWith('/api/products?')).at(-1),params=new URL(listRead,'http://localhost:8788').searchParams;assert.equal(params.get('page'),'2');assert.equal(params.get('query'),'1-3-101');assert.equal(params.get('includeStock'),'0');
  await card.getByRole('button',{name:'库存明细',exact:true}).click();const detail=page.locator('.mobile-stocktake-dialog');await detail.getByRole('heading',{name:'门槛条 新款 1个',exact:true}).waitFor();const ledgerReads=reads.filter(url=>url.startsWith('/api/inventory/ledger')).length;
  await saveStyle('详情改款',detail.getByRole('button',{name:'编辑库存',exact:true}));
  await detail.getByRole('heading',{name:'门槛条 详情改款 1个',exact:true}).waitFor();await detail.getByText('库存 1-3-202',{exact:true}).waitFor();await card.getByRole('heading',{name:'门槛条 详情改款 1个',exact:true}).waitFor();
  assert.equal(reads.filter(url=>url.startsWith('/api/inventory/ledger')).length,ledgerReads+1);assert.equal(await detail.getByRole('button',{name:'确认更新',exact:true}).count(),0);
  await fs.mkdir('.verification',{recursive:true});
  for(const width of [320,375,430]){await page.setViewportSize({width,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`.verification/mobile-inventory-detail-entries-${width}.png`,animations:'disabled'});}
  await detail.getByRole('button',{name:'历史版本',exact:true}).click();const history=page.locator('.inventory-history-dialog');await history.getByText('历史库存编号',{exact:true}).waitFor();await history.getByText('留存时间 2026/11/07 00:00:00',{exact:true}).waitFor();await history.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>window.entryRoles(['packing']));assert.equal(await detail.getByRole('button',{name:'编辑库存',exact:true}).count(),0);assert.equal(await detail.getByRole('button',{name:'历史版本',exact:true}).count(),1);await detail.getByRole('button',{name:'返回',exact:true}).click();
  assert.equal(await card.getByRole('button',{name:'编辑库存',exact:true}).count(),0);assert.equal(await card.getByRole('button',{name:'更新库存',exact:true}).count(),0);assert.equal(await card.getByRole('button',{name:'历史版本',exact:true}).count(),1);
  await page.getByRole('button',{name:'核验收货',exact:true}).click();const pending=page.locator('.mobile-work-queue .mobile-list-scroll>.mobile-record').first();await pending.getByRole('button',{name:'拍照验收入库',exact:true}).waitFor();
  assert.equal(await pending.getByRole('button',{name:'编辑库存',exact:true}).count(),0);await pending.getByRole('button',{name:'历史版本',exact:true}).click();await history.waitFor();await history.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>window.entryRoles(['procurement']));await pending.getByText('选择此批次',{exact:true}).click();await saveStyle('验收改款',pending.getByRole('button',{name:'编辑库存',exact:true}));await pending.getByRole('heading',{name:'门槛条 验收改款 1个',exact:true}).waitFor();
  assert.equal(batch.quantity,80);assert.equal(batch.physical_quantity,80);assert.equal(await pending.getByRole('checkbox',{name:'选择采购批次 501',exact:true}).isChecked(),false,'the existing post-save reload clears stale selection');
  const arrivalRead=reads.filter(url=>url.startsWith('/api/inventory-workflow/purchase-arrivals')).at(-1),arrivalParams=new URL(arrivalRead,'http://localhost:8788').searchParams;assert.equal(arrivalParams.get('status'),'arrived');assert.equal(arrivalParams.get('purchase_day'),date);
  assert.equal(writes.length,3);for(const write of writes){assert.equal(write.path,'/api/products/101');assert.equal(write.body.id,101);for(const key of Object.keys(originalCosts))assert.equal(write.body[key],originalCosts[key]);assert.equal(write.body.purchase_quantity,4);assert.equal(write.body.stock_unit,'个');assert.equal(write.body.package_weight_g,321);}
  assert.equal(reads.some(url=>url.startsWith('/api/products/501')),false,'an inbound batch ID never becomes a product edit target');assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('WB records show product facts, preview photos, sync real SKU/barcodes, edit drafts and delete local history',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000
},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'wb-publish-records-browser-')),reads=[],writes=[],pageErrors=[];
 const variant={images:['https://media.example.test/main.svg','https://media.example.test/detail.svg'],card:{title:'Frozen key cover',vendorCode:'WF-RED',sizes:[{price:258,skus:['submitted-only']}]}};
 const record={id:31,draft_id:11,draft_revision:4,shop_id:13,shop_name:'WB 测试店铺',publisher_name:'测试上架人',category_name:'汽车钥匙保护套',status:'completed',message:'商品内容已确认',created_at:'2026-11-13 01:00:00',published_at:'2026-11-13 01:00:00',updated_at:'2026-11-13 02:00:00',payload:{currency:'CNY',variants:[variant],card:variant.card,images:variant.images},state:{items:[{vendor_code:'WF-RED',nm_id:1001,phase:'done'}]},products:[{title:'Online key cover',vendor_code:'WF-RED',images:variant.images,nm_id:1001,barcodes:[],price:258,price_source:'submitted',currency:'CNY',score:90,score_source:'erp_completeness',score_label:'ERP资料完整度',online_status:'not_synced',synced_at:null}]};
 const active={...structuredClone(record),id:32,draft_id:12,status:'processing',message:'等待 WB 返回商品',products:[{title:'Processing blue cover',vendor_code:'WF-BLUE',images:[],nm_id:null,barcodes:[],price:300,currency:'CNY',score:null}]};
 let records=[record,active],browser,page;
 const html='<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>html,body,#app{margin:0;min-height:100%;font-family:Arial,sans-serif}#app{padding:16px;box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>';
 try{
  await build({configFile:false,publicDir:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'wb-records-fixture',resolveId(id){if(id==='virtual:wb-records')return '\0wb-records';},load(id){if(id==='\0wb-records')return `import {createApp,h} from 'vue';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import zhCn from 'element-plus/es/locale/lang/zh-cn';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import Records from '/frontend/admin/views/inventory/WbPublishRecordsView.vue';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';localStorage.setItem('baodanAuthUser',JSON.stringify({id:1,personId:1,tenant:{id:2,slug:'wb-test'}}));setAuthToken('wb-records-test-only');currentApiCacheScope();const router=createRouter({history:createWebHashHistory(),routes:[{path:'/listing-publish-records',name:'listing-publish-records',component:Records},{path:'/listing-automation',name:'listing-automation',component:{render:()=>h('div','Draft editor')}}]});const app=createApp({render:()=>h(RouterView)});app.use(router);app.use(ElementPlus,{locale:zhCn});router.isReady().then(()=>app.mount('#app'));`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:wb-records',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  page=await browser.newPage({viewport:{width:1680,height:1000}});page.on('pageerror',error=>pageErrors.push(error.message));
  await page.route('https://media.example.test/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900"><rect width="700" height="900" fill="#c4a08e"/><text x="80" y="460" font-size="52">WB product</text></svg>'}));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:html});
   if(url.pathname.startsWith('/api/')){
    if(request.method()==='GET')reads.push(url.pathname);else writes.push({path:url.pathname,body:request.postDataJSON()});
    if(url.pathname==='/api/wb/publish-records')return json({rows:records});
    if(url.pathname==='/api/wb/publish-records/sync'){record.products[0]={...record.products[0],barcodes:['2234567890123'],price:280,price_source:'online',online_status:'in_catalog',published_at:'2026-11-13T01:01:00Z',synced_at:'2026-11-13T03:00:00Z'};return json({job:record});}
    if(url.pathname==='/api/wb/publish-records/delete'){records=records.filter(row=>row.id!==request.postDataJSON().job_id);return json({ok:true});}
    throw Error('Unexpected fixture API: '+request.method()+' '+url.pathname);
   }
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/listing-publish-records?platform=wb');
  const table=page.locator('.records-table'),row=()=>table.locator('.el-table__body-wrapper tbody tr').filter({hasText:'WF-RED'}),activeRow=()=>table.locator('.el-table__body-wrapper tbody tr').filter({hasText:'WF-BLUE'});
  await row().getByText('Online key cover',{exact:true}).waitFor();
  for(const label of ['WB 类目','上架人','内容评分','线上 SKU','售价','上架时间（北京）','更新时间（北京）'])assert.ok(await table.getByText(label,{exact:true}).count());
  await row().getByText('ERP资料完整度',{exact:true}).waitFor();await row().getByText('2026/11/13 09:00:00',{exact:true}).waitFor();
  const box=await row().locator('.product-thumb').boundingBox();assert.equal(Math.round(box.width),64);assert.equal(Math.round(box.height),84);
  await row().locator('.product-thumb').click();await page.locator('.el-image-viewer__wrapper').waitFor();await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:/归档|恢复原商品/}).count(),0);
  assert.equal(await activeRow().getByRole('button',{name:'删除',exact:true}).isDisabled(),true);
  await row().getByRole('button',{name:'查看',exact:true}).click();const sku=page.getByRole('dialog',{name:'WB 线上 SKU 与条码',exact:true});await sku.getByText('1001',{exact:true}).waitFor();await sku.getByText('未同步返回',{exact:true}).waitFor();
  assert.equal(writes.length,0,'viewing cached SKU does not trigger a business request');
  await sku.getByRole('button',{name:'同步线上资料',exact:true}).click();await sku.getByText('2234567890123',{exact:true}).waitFor();await sku.getByText('在商品库',{exact:true}).waitFor();await sku.getByText('2026/11/13 11:00:00',{exact:true}).waitFor();
  assert.deepEqual(writes,[{path:'/api/wb/publish-records/sync',body:{job_id:31}}]);await sku.locator('.el-drawer__close-btn').click();
  await page.getByPlaceholder('商品名 / 货号 / 线上 SKU / 条码').fill('2234567890123');assert.equal(await activeRow().count(),0);await page.getByPlaceholder('商品名 / 货号 / 线上 SKU / 条码').fill('');
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-publish-records.png',fullPage:true,animations:'disabled'});
  await row().getByRole('button',{name:'编辑',exact:true}).click();await page.waitForURL(/wbDraftId=11/);assert.ok(!page.url().includes('wbRecordId'));await page.goBack();await row().getByText('Online key cover',{exact:true}).waitFor();
  await row().getByRole('button',{name:'删除',exact:true}).click();await page.locator('.el-message-box').getByRole('button',{name:'取消',exact:true}).click();assert.equal(writes.length,1);
  await row().getByRole('button',{name:'删除',exact:true}).click();await page.locator('.el-message-box').getByRole('button',{name:'删除记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.records-table')?.textContent.includes('WF-RED'));
  assert.deepEqual(writes.map(write=>write.path),['/api/wb/publish-records/sync','/api/wb/publish-records/delete']);assert.ok(reads.every(read=>read==='/api/wb/publish-records'));assert.deepEqual(pageErrors,[]);
 }finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

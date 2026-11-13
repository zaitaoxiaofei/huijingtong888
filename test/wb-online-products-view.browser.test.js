import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {shanghaiDateTimeText} from '../frontend/admin/utils/shanghai-date.js';

test('WB online rows display numeric stock and actual size identities, with local inventory actions and isolated shop resets',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000
},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'wb-online-products-browser-')),reads=[],writes=[],errors=[];
 const shops=[{id:13,name:'WB 店铺 A',status:'active',environment:'production'},{id:14,name:'WB 店铺 B',status:'active',environment:'production'}];
 const sizes=[{chrtID:501,techSize:'M',skus:['12345678901']},{chrtID:502,techSize:'L',skus:['12345678902']}];
 const rowsA=[{id:1,nm_id:101,shop_id:13,shop_name:'WB 店铺 A',online_status:'in_catalog',title:'WB 多规格商品',vendor_code:'WB-ARTICLE-A',rating:4.8,published_at:'2026-11-13T01:00:00Z',synced_at:'2026-11-13T02:00:00Z',stock_synced_at:'2026-11-13T02:00:00Z',fbs_stock:0,stock_info:{sizes:[{chrt_id:501,amount:0},{chrt_id:502,amount:0}]},price_info:{currency:'CNY',sizes:[{chrt_id:502,price:300,original_price:400},{chrt_id:501,price:200,original_price:280}]},card:{title:'WB 多规格商品',brand:'示例品牌',subjectName:'钥匙套',subjectID:101,sizes,photos:[{big:'https://media.example.test/main.jpg'}],dimensions:{length:13,width:20,height:10,weightBrutto:0.215}},mappings:[{ozon_sku:'WB-501',product_id:9,product_name:'已有库存 M',inventory_number:'1-9'}]},
 {id:2,nm_id:102,shop_id:13,shop_name:'WB 店铺 A',online_status:'archived',title:'WB 未知库存商品',vendor_code:'WB-ARTICLE-B',rating:null,published_at:null,synced_at:'2026-11-13T02:00:00Z',fbs_stock:null,stock_synced_at:null,stock_error:'库存尚未同步',price_info:null,card:{sizes:[{chrtID:503,techSize:'0',skus:['12345678903']}],photos:[],dimensions:{}},mappings:[]}];
 const rowsB=[{id:3,nm_id:201,shop_id:14,shop_name:'WB 店铺 B',online_status:'in_catalog',title:'B 店铺商品',vendor_code:'WB-B',rating:null,published_at:null,synced_at:'2026-11-13T02:00:00Z',fbs_stock:null,price_info:null,card:{sizes:[{chrtID:601,techSize:'0',skus:['22345678901']}],photos:[],dimensions:{}},mappings:[]}];
 let browser,page,holdProducts=false,heldProducts;
 try{
  await build({configFile:false,publicDir:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'wb-online-products-fixture',resolveId(id){if(id==='virtual:wb-online-products')return '\0wb-online-products';},load(id){if(id==='\0wb-online-products')return `import {createApp,h} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import zhCn from 'element-plus/es/locale/lang/zh-cn';import 'element-plus/dist/index.css';import View from '/frontend/admin/views/inventory/WbOnlineProductsView.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';const user={id:1,personId:1,roles:['operations'],tenant:{id:2,slug:'wb-view',role:'member'}};localStorage.setItem('baodanAuthUser',JSON.stringify(user));setAuthToken('wb-online-browser-only');currentApiCacheScope();const app=createApp({render:()=>h(RouterView)}),pinia=createPinia(),router=createRouter({history:createWebHashHistory(),routes:[{path:'/online-products',component:View}]});app.use(pinia);useAuthStore().user=user;app.use(router);app.use(ElementPlus,{locale:zhCn});router.isReady().then(()=>app.mount('#app'));`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:wb-online-products',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  page=await browser.newPage({viewport:{width:1600,height:1050}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{font-family:Arial,sans-serif;margin:20px;color:#303133}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname==='/api/image-proxy')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900"><rect width="700" height="900" fill="#e3b99d"/><text x="70" y="450" font-size="60">WB Product</text></svg>'});
   if(url.pathname.startsWith('/api/')){
    if(request.method()==='GET')reads.push(url.pathname+url.search);else writes.push({path:url.pathname,body:request.postDataJSON()});
    if(url.pathname==='/api/wb/shops')return json(shops);
    if(url.pathname==='/api/wb/products'){if(holdProducts&&url.searchParams.get('shop_id')==='14'){heldProducts=route;holdProducts=false;return;}return json({rows:url.searchParams.get('shop_id')==='13'?rowsA:rowsB});}
    if(url.pathname==='/api/products')return json({rows:[{id:91,name:'现有库存 L',inventory_number:'1-91'}]});
    if(url.pathname==='/api/wb/products/bind'){const body=request.postDataJSON();rowsA.find(row=>row.nm_id===body.nm_id).mappings.push({ozon_sku:'WB-'+body.chrt_id,product_id:body.product_id,product_name:'现有库存 L',inventory_number:'1-91'});return json({ok:true});}
    if(url.pathname==='/api/wb/products/create-inventory'){const body=request.postDataJSON();rowsA.find(row=>row.nm_id===body.nm_id).mappings.push({ozon_sku:'WB-'+body.chrt_id,product_id:92,product_name:body.name,inventory_number:'1-92'});return json({ok:true,product_id:92});}
    if(url.pathname==='/api/wb/products/refresh'){rowsA[1].fbs_stock=7;rowsA[1].stock_error='';rowsA[1].stock_synced_at='2026-11-13T03:00:00Z';rowsA[1].stock_info={sizes:[{chrt_id:503,amount:7}]};return json({ok:true,rows:rowsA,warnings:[]});}
    throw Error('Unexpected fixture API: '+request.method()+' '+url.pathname);
   }
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/online-products?platform=wb');
  const row=nm=>page.locator('.el-table__body-wrapper tbody tr').filter({has:page.getByText('WB 商品编号：'+nm,{exact:true})});
  await row(101).waitFor();assert.equal(writes.length,0,'rendering local snapshots makes no remote POST requests');
  assert.ok(!reads.some(url=>url.startsWith('/api/wb/prices')||url.startsWith('/api/wb/stocks')));
  assert.equal(await row(101).locator('.stock-number').innerText(),'0');assert.equal(await row(102).locator('.stock-number').innerText(),'未同步');
  assert.equal(await row(101).getByText('已有库存 M',{exact:true}).count(),1);assert.equal(await row(101).getByText('未绑定库存产品',{exact:true}).count(),1);
  await row(101).getByText('200 CNY',{exact:true}).waitFor();await row(101).getByText('300 CNY',{exact:true}).waitFor();
  await row(101).getByText('215 g',{exact:true}).waitFor();await row(101).getByText(shanghaiDateTimeText('2026-11-13T01:00:00Z'),{exact:true}).waitFor();
  const headers=await page.locator('.erp-data-table .el-table__header-wrapper thead th .cell').allTextContents();
  const columns=['店铺 / 状态','WB SKU / 条码','主图','在线商品信息','售价','绑定库存','FBS 库存','上架时间（北京）','包装尺寸 / 重量','最后同步（北京）','操作'];assert.deepEqual(headers.map(value=>value.trim()),columns);
  assert.equal(await page.getByRole('button',{name:'查看库存',exact:true}).count(),0);assert.equal(await page.getByRole('columnheader',{name:'商品属性',exact:true}).count(),0);
  assert.equal(await row(102).getByText('未返回',{exact:true}).count()>0,true,'missing publication time remains unknown');
  await row(102).getByRole('button',{name:'同步库存',exact:true}).click();await row(102).getByText('7',{exact:true}).waitFor();
  assert.deepEqual(writes[0],{path:'/api/wb/products/refresh',body:{shop_id:13,nm_id:102}});

  await row(101).getByRole('button',{name:'绑定库存',exact:true}).click();
  const binding=page.getByRole('dialog',{name:'绑定 SKU 到库存产品',exact:true});
  await binding.getByText('L · 502',{exact:true}).waitFor();
  await binding.locator('.el-select').nth(1).click();await page.getByRole('option',{name:'1-91 · 现有库存 L',exact:true}).click();
  await binding.getByRole('button',{name:'保存绑定',exact:true}).click();await row(101).getByText('现有库存 L',{exact:true}).waitFor();
  assert.deepEqual(writes.find(write=>write.path==='/api/wb/products/bind').body,{shop_id:13,nm_id:101,chrt_id:502,product_id:91,vendor_code:'WB-ARTICLE-A'});
  assert.equal(await row(101).getByRole('button',{name:'创建库存',exact:true}).isDisabled(),true,'each returned size is now independently bound');

  await row(102).getByRole('button',{name:'创建库存',exact:true}).click();
  const creation=page.getByRole('dialog',{name:'根据 WB 商品创建库存',exact:true});
  await creation.getByText('通用 · 503',{exact:true}).waitFor();await creation.locator('input[maxlength="200"]').fill('新建本地库存');
  assert.equal(await creation.getByRole('button',{name:'创建并绑定',exact:true}).isDisabled(),true,'missing online packaging must be supplied explicitly for the local inventory product');
  for(const [index,value] of ['16','8','5','215'].entries()){await creation.locator('.creation-package input').nth(index).fill(value);await creation.locator('.creation-package input').nth(index).press('Tab');}
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-online-products-create-inventory.png',fullPage:true,animations:'disabled'});
  await creation.getByRole('button',{name:'创建并绑定',exact:true}).click();await row(102).getByText('新建本地库存',{exact:true}).waitFor();
  assert.deepEqual(writes.find(write=>write.path==='/api/wb/products/create-inventory').body,{shop_id:13,nm_id:102,chrt_id:503,name:'新建本地库存',length_cm:16,width_cm:8,height_cm:5,package_weight_g:215});
  assert.deepEqual(rowsA[1].card.dimensions,{},'local package entry does not modify the online WB card');
  assert.ok(writes.every(write=>['/api/wb/products/refresh','/api/wb/products/bind','/api/wb/products/create-inventory'].includes(write.path)),'local inventory actions never invoke standalone WB writes');
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-online-products-stock-bindings.png',fullPage:true,animations:'disabled'});
  await page.locator('.erp-data-table .el-table__body-wrapper .el-scrollbar__wrap').evaluate(node=>node.scrollLeft=0);
  await page.screenshot({path:'.verification/wb-online-products-desktop.png',fullPage:true,animations:'disabled'});

  const selectShop=async name=>{await page.locator('.wb-filters>.el-select').first().click();await page.getByRole('option',{name,exact:true}).click();};
  holdProducts=true;await selectShop('WB 店铺 B');await row(101).waitFor({state:'hidden'});
  await selectShop('WB 店铺 A');await row(101).waitFor();
  assert.ok(heldProducts);await heldProducts.fulfill({json:{rows:rowsB}});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await row(201).count(),0,'late previous-shop results cannot replace the selected shop');
  await selectShop('WB 店铺 B');await row(201).waitFor();assert.equal(await row(101).count(),0);
  assert.equal(await row(201).locator('.stock-number').innerText(),'未同步');assert.equal(await row(201).getByText('未绑定库存产品',{exact:true}).count(),1);
  assert.deepEqual(errors,[]);
 }catch(error){if(page){await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-online-products-failure.png',fullPage:true,animations:'disabled'});}throw error;}
 finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

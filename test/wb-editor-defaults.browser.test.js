import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

test('WB generic listing fields work before category selection and survive category-dependent schema changes',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:150000
},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'wb-editor-defaults-browser-'));
 const reads=[],writes=[],errors=[];let browser,page;
 const categories=[{subjectID:101,subjectName:'汽车钥匙套',parentName:'汽车用品'},{subjectID:202,subjectName:'收纳套',parentName:'家居用品'}];
 try{
  await build({configFile:false,publicDir:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'wb-editor-defaults-fixture',resolveId(id){if(id==='virtual:wb-editor-defaults')return '\0wb-editor-defaults';},load(id){if(id==='\0wb-editor-defaults')return `import {createApp,h} from 'vue';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import zhCn from 'element-plus/es/locale/lang/zh-cn';import 'element-plus/dist/index.css';import Workbench from '/frontend/admin/views/inventory/WbListingReviewView.vue';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';localStorage.setItem('baodanAuthUser',JSON.stringify({id:1,personId:1,tenant:{id:2,slug:'wb-editor-test'}}));setAuthToken('wb-editor-defaults-test');currentApiCacheScope();const router=createRouter({history:createWebHashHistory(),routes:[{path:'/listing-automation',name:'listing-automation',component:Workbench}]});const app=createApp({render:()=>h(RouterView)});app.use(router);app.use(ElementPlus,{locale:zhCn});router.isReady().then(()=>app.mount('#app'));`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:wb-editor-defaults',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  page=await browser.newPage({viewport:{width:1600,height:1050}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://media.example.test/**',route=>route.fulfill({contentType:route.request().url().endsWith('.mp4')?'video/mp4':'image/svg+xml',body:route.request().url().endsWith('.mp4')?'':'<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900"><rect width="700" height="900" fill="#b0c5da"/></svg>'}));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:'<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>html,body,#app{margin:0;height:100%;font-family:Arial,sans-serif}#app{padding:16px;box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'});
   if(url.pathname.startsWith('/api/')){
    if(request.method()==='GET')reads.push({path:url.pathname,query:Object.fromEntries(url.searchParams)});else writes.push({path:url.pathname,body:request.postDataJSON()});
    if(url.pathname==='/api/wb/shops')return json([{id:13,name:'WB 测试店铺',status:'active',environment:'production'}]);
    if(url.pathname==='/api/wb/workbench-drafts')return json({rows:[]});
    if(url.pathname==='/api/wb/catalog/parents')return json({data:[{id:1,name:'汽车用品'},{id:2,name:'家居用品'}]});
    if(url.pathname==='/api/wb/catalog/categories')return json({data:categories,next_offset:null,cache:{stale:false}});
    if(url.pathname==='/api/wb/catalog/schema'){
     const subject=Number(url.searchParams.get('subject_id'));assert.ok([101,202].includes(subject));
     return json({subject_id:subject,template_id:subject+1000,category_name:categories.find(row=>row.subjectID===subject).subjectName,environment:'production',attributes:[{charcID:subject===101?7:8,name:subject===101?'材质':'用途',charcType:1,maxCount:1,required:false}],defaults:{characteristics:subject===101?[{id:7,value:['Leather']}]:[]}});
    }
    if(url.pathname==='/api/wb/catalog/brands'){assert.ok(Number(url.searchParams.get('subject_id'))>0);return json({data:['Generic Brand']});}
    if(url.pathname==='/api/wb/listing-drafts/save')return json({ok:true,draft_id:51,revision:1});
    throw Error('Unexpected fixture request: '+request.method()+' '+url.pathname);
   }
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/listing-automation?platform=wb');
  const header=page.locator('.copy-header'),table=page.locator('.variant-table');
  const vendor=()=>page.locator('.offer-id-cell input'),title=()=>table.locator('textarea[maxlength="60"]');
  await vendor().first().waitFor();
  for(const name of ['商品信息','媒体','规格与价格','包装','内容'])assert.equal(await table.getByText(name,{exact:true}).count(),1);
  assert.equal(reads.filter(row=>/schema|brands|options/.test(row.path)).length,0,'no category-dependent calls are made for the unselected schema');
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-editor-empty-generic.png',fullPage:true,animations:'disabled'});
  await vendor().first().fill('GENERIC-1');await title().first().fill('Generic title');
  await table.locator('textarea:not([placeholder]):not([maxlength])').first().fill('Generic description');
  await page.getByPlaceholder('商品尺码',{exact:true}).fill('M');await page.getByPlaceholder('WB 尺码（适用时填写）',{exact:true}).fill('44');
  await page.getByPlaceholder('商品条码，每行一个',{exact:true}).fill('12345678901');
  const numbers=table.getByRole('spinbutton');for(const [index,value] of ['228','12','8','4','0.22'].entries()){await numbers.nth(index).fill(value);await numbers.nth(index).press('Tab');}
  await page.getByPlaceholder('HTTPS 视频地址',{exact:true}).fill('https://media.example.test/generic.mp4');
  await page.getByPlaceholder('填写品牌',{exact:true}).fill('Generic Brand');
  assert.equal(reads.filter(row=>row.path.includes('/brands')).length,0,'brands can be entered without requesting subject 0');
  await page.getByRole('button',{name:'编辑图片（0）',exact:true}).click();
  const imageDialog=page.getByRole('dialog',{name:'编辑商品图片 · 变体 1',exact:true});
  await imageDialog.getByRole('button',{name:'添加图片链接',exact:true}).click();
  await page.getByPlaceholder('填写图片地址',{exact:true}).fill('https://media.example.test/generic.jpg');
  await page.getByRole('button',{name:'添加图片',exact:true}).click();
  await imageDialog.getByRole('button',{name:'完成编辑',exact:true}).click();
  await page.getByRole('button',{name:'＋ 添加变体',exact:true}).click();
  await vendor().nth(1).fill('GENERIC-2');await title().nth(1).fill('Second title');
  await header.getByRole('button',{name:'保存草稿',exact:true}).click();
  await page.getByText(/产品类目：请在顶部选择 WB 产品类目/).first().waitFor();
  await header.getByRole('button',{name:'提交 WB',exact:true}).click();
  assert.equal(writes.length,0,'missing category blocks save and publish before any request');
  await header.getByRole('button',{name:'预览与校验',exact:true}).click();
  const preview=page.getByRole('dialog',{name:'WB 商品预览与发布',exact:true});
  await preview.getByText(/产品类目：请在顶部选择 WB 产品类目/).waitFor();
  await preview.getByRole('button',{name:'返回修改',exact:true}).click();
  assert.equal(writes.length,0,'unselected-category preview stays local');
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-editor-before-category.png',fullPage:true,animations:'disabled'});
  await page.locator('.workbench-settings .el-form-item').filter({has:page.getByText('上架店铺',{exact:true})}).locator('.el-select').click();
  await page.getByRole('option',{name:'WB 测试店铺',exact:true}).click();
  const choose=async label=>{await page.locator('.wb-category-select .el-select').nth(1).click();await page.getByRole('option',{name:label,exact:true}).click();};
  await choose('汽车用品 / 汽车钥匙套');
  await table.getByText('材质',{exact:true}).waitFor();
  assert.equal(await vendor().nth(0).inputValue(),'GENERIC-1');assert.equal(await vendor().nth(1).inputValue(),'GENERIC-2');
  assert.equal(await title().first().inputValue(),'Generic title');
  await choose('家居用品 / 收纳套');await page.locator('.el-message-box').getByRole('button',{name:'确定',exact:true}).click();
  await table.getByText('用途',{exact:true}).waitFor();
  assert.equal(await table.getByText('材质',{exact:true}).count(),0);
  await header.getByRole('button',{name:'保存草稿',exact:true}).click();
  await page.waitForURL(/wbDraftId=51/);
  const saved=writes.find(row=>row.path==='/api/wb/listing-drafts/save').body;
  assert.equal(saved.shop_id,13);assert.equal(saved.payload.subject_id,202);assert.equal(saved.payload.template_id,1202);
  assert.equal(saved.payload.variants.length,2);const row=saved.payload.variants[0];
  assert.equal(row.card.vendorCode,'GENERIC-1');assert.equal(row.card.title,'Generic title');assert.equal(row.card.brand,'Generic Brand');assert.equal(row.card.description,'Generic description');
  assert.deepEqual(row.card.dimensions,{length:12,width:8,height:4,weightBrutto:.22});
  assert.deepEqual(row.card.sizes,[{techSize:'M',wbSize:'44',price:228,skus:['12345678901']}]);
  assert.deepEqual(row.images,['https://media.example.test/generic.jpg']);assert.equal(row.video_url,'https://media.example.test/generic.mp4');
  assert.ok(saved.payload.variants.every(row=>row.subject_id===202&&row.template_id===1202&&!row.card.characteristics.length));
  assert.equal(saved.payload.variants[1].card.vendorCode,'GENERIC-2');assert.equal(saved.payload.variants[1].card.title,'Second title');
  assert.deepEqual(saved.payload.card,row.card);assert.deepEqual(saved.payload.images,row.images);
  assert.ok(!reads.some(row=>['0','null','undefined'].includes(row.query.subject_id)));
  assert.deepEqual(errors,[]);
 }catch(error){await fs.mkdir('.verification',{recursive:true});await page?.screenshot({path:'.verification/wb-editor-defaults-failure.png',fullPage:true,animations:'disabled'});throw error;}finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

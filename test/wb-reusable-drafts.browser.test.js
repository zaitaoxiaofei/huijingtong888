import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {wbListingValidation} from '../src/shared/wb-listing-validation.js';

test('WB published drafts can become editable templates and preview leads to a fresh confirmed publication',{
 skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000
},async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'wb-reusable-drafts-browser-'));
 const shops=[{id:13,name:'模板来源店铺',status:'active',environment:'production'},{id:14,name:'新上架店铺',status:'active',environment:'production'}];
 const categories=[{subjectID:101,subjectName:'钥匙套',parentName:'汽车用品'},{subjectID:202,subjectName:'收纳套',parentName:'家居用品'}];
 const attributes=id=>[{charcID:id===101?7:8,charcType:1,name:id===101?'材质':'适用场景',required:false,maxCount:1}];
 const makeVariant=(vendorCode,index)=>({card:{nmID:900+index,imtID:800,title:'Reusable product '+index,vendorCode,brand:'Без бренда',description:'Reusable description '+index,dimensions:{length:12+index,width:20,height:10,weightBrutto:0.22},characteristics:[{id:7,value:['Leather']}],sizes:[{chrtID:700+index,price:258+index,skus:['1234567890'+index]}]},images:[`https://media.example.test/variant-${index}.jpg`,`https://media.example.test/detail-${index}.jpg`],video_url:`https://media.example.test/variant-${index}.mp4`});
 const variants=[makeVariant('SOURCE-A',1),makeVariant('SOURCE-B',2)];
 const source={id:11,shop_id:13,shop_name:shops[0].name,status:'published',revision:4,vendor_code:'SOURCE-A',category_name:'钥匙套',created_at:'2026-11-12 01:00:00',updated_at:'2026-11-12 02:00:00',payload:{template_id:1001,subject_id:101,currency:'CNY',strategy:'independent',variants,card:variants[0].card,images:variants[0].images,video_url:variants[0].video_url}};
 const initialSource=structuredClone(source),drafts=new Map([[source.id,structuredClone(source)]]),writes=[],reads=[],pageErrors=[];
 let nextDraftId=51,browser,page,holdNextDraftList=false,heldDraftList=null,secondSource=null;
 const html='<html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>html,body,#app{margin:0;height:100%;font-family:Arial,sans-serif}body{color:#303133}#app{padding:16px;box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>';
 try{
  await build({configFile:false,publicDir:false,root:process.cwd(),logLevel:'error',plugins:[vue(),{name:'wb-reusable-drafts-fixture',resolveId(id){if(id==='virtual:wb-reusable-drafts')return '\0wb-reusable-drafts';},load(id){if(id==='\0wb-reusable-drafts')return `import {createApp,h} from 'vue';import {createRouter,createWebHashHistory,RouterView} from 'vue-router';import ElementPlus from 'element-plus';import zhCn from 'element-plus/es/locale/lang/zh-cn';import 'element-plus/dist/index.css';import Drafts from '/frontend/admin/views/inventory/WbDraftsView.vue';import Workbench from '/frontend/admin/views/inventory/WbListingReviewView.vue';import {setAuthToken,currentApiCacheScope} from '/frontend/admin/utils/api.js';localStorage.setItem('baodanAuthUser',JSON.stringify({id:1,personId:1,tenant:{id:2,slug:'wb-test'}}));setAuthToken('wb-browser-test-only');currentApiCacheScope();const router=createRouter({history:createWebHashHistory(),routes:[{path:'/listing-records',name:'listing-records',component:Drafts},{path:'/listing-automation',name:'listing-automation',component:Workbench}]});const app=createApp({render:()=>h(RouterView)});app.use(router);app.use(ElementPlus,{locale:zhCn});router.isReady().then(()=>app.mount('#app'));`;}}],build:{outDir:output,cssCodeSplit:false,rollupOptions:{input:'virtual:wb-reusable-drafts',output:{entryFileNames:'entry.js'}}}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true});
  page=await browser.newPage({viewport:{width:1600,height:1050}});
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.route('https://media.example.test/**',route=>route.fulfill({contentType:route.request().url().endsWith('.mp4')?'video/mp4':'image/svg+xml',body:route.request().url().endsWith('.mp4')?'':'<svg xmlns="http://www.w3.org/2000/svg" width="700" height="900"><rect width="700" height="900" fill="#deba94"/><text x="70" y="440" font-size="50">WB template</text></svg>'}));
  await page.route('http://localhost:8788/**',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:html});
   if(url.pathname.startsWith('/api/')){
    if(request.method()==='GET')reads.push({path:url.pathname,query:Object.fromEntries(url.searchParams)});
    else writes.push({path:url.pathname,body:request.postDataJSON()});
    if(url.pathname==='/api/wb/shops')return json(shops);
    if(url.pathname==='/api/wb/workbench-drafts'){if(holdNextDraftList){holdNextDraftList=false;heldDraftList=route;return;}return json({rows:[...drafts.values()]});}
    if(url.pathname==='/api/wb/catalog/parents')return json({data:[{id:1,name:'汽车用品'},{id:2,name:'家居用品'}]});
    if(url.pathname==='/api/wb/catalog/categories')return json({data:categories,next_offset:null,cache:{stale:false}});
    if(url.pathname==='/api/wb/catalog/schema'){const subject=Number(url.searchParams.get('subject_id'));return json({subject_id:subject,template_id:subject===101?1001:1002,category_name:categories.find(c=>c.subjectID===subject).subjectName,environment:'production',attributes:attributes(subject),defaults:{currency:'CNY',characteristics:[]}});}
    if(url.pathname==='/api/wb/catalog/brands')return json({data:['Без бренда']});
    if(url.pathname==='/api/wb/listing-preview'){const body=request.postDataJSON();return json({...wbListingValidation(body.payload,attributes(Number(body.payload.subject_id))),review_only:true});}
    if(url.pathname==='/api/wb/listing-drafts/save'){
     const body=request.postDataJSON(),id=Number(body.draft_id)||nextDraftId++,previous=drafts.get(id),revision=previous?previous.revision+1:1;
     drafts.set(id,{id,shop_id:body.shop_id,shop_name:shops.find(s=>s.id===body.shop_id).name,revision,status:'draft',vendor_code:body.payload.card.vendorCode,category_name:categories.find(c=>c.subjectID===Number(body.payload.subject_id)).subjectName,payload:structuredClone(body.payload)});
     return json({ok:true,draft_id:id,revision});
    }
    if(url.pathname==='/api/wb/publish-jobs')return json({rows:[{id:31,draft_id:11,shop_id:13,status:'completed',payload:initialSource.payload,state:{createStarted:true}},...(secondSource?[{id:32,draft_id:12,shop_id:13,status:'completed',payload:secondSource.payload,state:{createStarted:true}}]:[])]});
    if(url.pathname==='/api/wb/listing-publish/review'){
     const body=request.postDataJSON(),draft=drafts.get(Number(body.draft_id)),validation=wbListingValidation(draft.payload,attributes(Number(draft.payload.subject_id)));
     return json({...validation,draft_id:draft.id,revision:draft.revision,shop_id:draft.shop_id,shop_name:draft.shop_name,currency:'CNY',review_hash:'review-'+draft.id+'-'+draft.revision,variants:draft.payload.variants.map(v=>({vendor_code:v.card.vendorCode,title:v.card.title,sizes:v.card.sizes,images:v.images,video_url:v.video_url}))});
    }
    if(url.pathname==='/api/wb/listing-publish/submit')return json({ok:true,job:{id:91,status:'queued',message:'Test publication queued'}});
    if(url.pathname==='/api/wb/publish-job')return json({job:{id:91,status:'completed',message:'Test publication completed',state:{items:[]},payload:{variants:[]}}});
    if(url.pathname==='/api/wb/product-operation/review')return json({ok:false,errors:['请核对原商品身份'],message:'原商品操作需要核对身份',shop_name:shops[0].name,revision:drafts.get(12).revision,variants:[],targets:[]});
    throw Error('Unexpected fixture API: '+request.method()+' '+url.pathname);
   }
   const file=url.pathname==='/style.css'?path.join('assets',(await fs.readdir(path.join(output,'assets'))).find(name=>name.endsWith('.css'))):url.pathname.slice(1);
   return route.fulfill({contentType:file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript',body:await fs.readFile(path.join(output,file))});
  });
  await page.goto('http://localhost:8788/admin.html#/listing-records?platform=wb');
  await page.getByText('SOURCE-A',{exact:true}).waitFor();
  await page.locator('.el-table__body-wrapper tbody tr').filter({hasText:'SOURCE-A'}).getByRole('button',{name:'作为模板新建',exact:true}).click();
  await page.waitForURL(/wbTemplateId=11/);
  const vendors=()=>page.locator('.offer-id-cell input'),barcodes=()=>page.getByPlaceholder('商品条码，每行一个');
  await vendors().first().waitFor();
  assert.notEqual(await vendors().nth(0).inputValue(),'SOURCE-A');
  assert.notEqual(await vendors().nth(1).inputValue(),'SOURCE-B');
  assert.equal(await vendors().first().isEditable(),true);
  assert.equal(await barcodes().nth(0).inputValue(),'');
  assert.equal(await barcodes().nth(1).inputValue(),'');
  assert.equal(writes.length,0,'creating a template does not save or generate platform barcodes');
  await vendors().nth(0).fill('TEMPLATE-A');await vendors().nth(1).fill('TEMPLATE-B');
  await page.locator('.workbench-settings .el-form-item').filter({has:page.getByText('上架店铺',{exact:true})}).locator('.el-select').click();
  await page.getByRole('option',{name:shops[1].name,exact:true}).click();
  await page.locator('.wb-category-select .el-select').nth(1).click();
  await page.getByRole('option',{name:'家居用品 / 收纳套',exact:true}).click();
  await page.locator('.el-message-box').getByRole('button',{name:'确定',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.wb-category-select')?.textContent.includes('收纳套'));
  assert.equal(await vendors().first().inputValue(),'TEMPLATE-A','category changes preserve edited vendor codes');
  await page.locator('.copy-header').getByRole('button',{name:'预览与校验',exact:true}).click();
  const preview=page.getByRole('dialog',{name:'WB 商品预览与发布',exact:true});
  await preview.getByText(/目标店铺：新上架店铺 · 类目：收纳套/).waitFor();
  await preview.getByText(/请补全以下提示/).waitFor();
  assert.equal(await preview.getByRole('button',{name:'核对并发布',exact:true}).isDisabled(),true);
  assert.equal(writes.filter(w=>w.path==='/api/wb/listing-drafts/save').length,0,'preview does not implicitly save');
  await preview.getByRole('button',{name:'返回修改',exact:true}).click();
  await barcodes().nth(0).fill('22345678901');await barcodes().nth(1).fill('22345678902');
  await page.locator('.copy-header').getByRole('button',{name:'预览与校验',exact:true}).click();
  await preview.getByText(/资料校验通过/).waitFor();
  await preview.getByRole('button',{name:'核对并发布',exact:true}).click();
  await preview.getByRole('button',{name:'确认提交 WB',exact:true}).waitFor();
  assert.equal(writes.filter(w=>w.path==='/api/wb/listing-publish/submit').length,0,'review requires a separate final confirmation');
  const saved=writes.find(w=>w.path==='/api/wb/listing-drafts/save').body;
  assert.equal(saved.draft_id,null);assert.equal(saved.shop_id,14);assert.equal(saved.payload.subject_id,202);
  assert.deepEqual(saved.payload.variants.map(v=>v.card.vendorCode),['TEMPLATE-A','TEMPLATE-B']);
  for(const [index,variant] of saved.payload.variants.entries()){
   assert.equal(variant.card.nmID,undefined);assert.equal(variant.card.imtID,undefined);assert.equal(variant.card.sizes[0].chrtID,undefined);
   assert.deepEqual(variant.images,initialSource.payload.variants[index].images);assert.equal(variant.video_url,initialSource.payload.variants[index].video_url);
   assert.equal(variant.card.title,initialSource.payload.variants[index].card.title);assert.deepEqual(variant.card.dimensions,initialSource.payload.variants[index].card.dimensions);
   assert.equal(variant.card.sizes[0].price,initialSource.payload.variants[index].card.sizes[0].price);assert.deepEqual(variant.card.characteristics,[]);
  }
  assert.deepEqual(drafts.get(11),initialSource,'template reuse leaves the published source unchanged');
  assert.ok(!writes.some(w=>w.path==='/api/wb/listing-barcodes'));
  await preview.getByRole('button',{name:'返回修改',exact:true}).click();
  await page.locator('.variant-table textarea[maxlength="60"]').first().fill('Revised after review');
  await page.locator('.copy-header').getByRole('button',{name:'预览与校验',exact:true}).click();
  await preview.getByText(/资料校验通过/).waitFor();
  assert.equal(await preview.getByRole('button',{name:'确认提交 WB',exact:true}).count(),0,'editing invalidates the old final confirmation');
  await preview.getByRole('button',{name:'核对并发布',exact:true}).click();
  await preview.getByRole('button',{name:'确认提交 WB',exact:true}).waitFor();
  assert.equal(writes.filter(w=>w.path==='/api/wb/listing-publish/review').length,2);
  await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-reusable-draft-preview.png',fullPage:true,animations:'disabled'});
  await preview.getByRole('button',{name:'确认提交 WB',exact:true}).click();
  await preview.getByText('任务编号：91',{exact:true}).waitFor();
  assert.equal(writes.filter(w=>w.path==='/api/wb/listing-publish/submit').length,1);
  assert.equal(writes.find(w=>w.path==='/api/wb/listing-publish/submit').body.shop_id,14);
  assert.equal(writes.find(w=>w.path==='/api/wb/listing-publish/submit').body.draft_id,51);
  assert.equal(writes.find(w=>w.path==='/api/wb/listing-publish/submit').body.revision,2);
  assert.equal(writes.find(w=>w.path==='/api/wb/listing-publish/submit').body.review_hash,'review-51-2');
  await preview.locator('.el-drawer__close-btn').click();
  const beforeHeaderTemplate=writes.length;
  await page.locator('.copy-header').getByRole('button',{name:'作为模板新建',exact:true}).click();
  await page.waitForURL(/wbTemplateId=51/);
  assert.notEqual(await vendors().first().inputValue(),'TEMPLATE-A');
  assert.equal(await page.locator('.variant-table textarea[maxlength="60"]').first().inputValue(),'Revised after review');
  assert.equal(await barcodes().first().inputValue(),'');
  assert.equal(writes.length,beforeHeaderTemplate,'header template reuse also stays local until save');

  secondSource=structuredClone(initialSource);secondSource.id=12;secondSource.vendor_code='SOURCE-X';
  for(const [index,variant] of secondSource.payload.variants.entries()){variant.card.vendorCode=index?'SOURCE-Y':'SOURCE-X';delete variant.card.nmID;delete variant.card.imtID;delete variant.card.sizes[0].chrtID;}
  secondSource.payload.card=secondSource.payload.variants[0].card;drafts.set(12,structuredClone(secondSource));
  await page.goto('http://localhost:8788/admin.html#/listing-automation?platform=wb&wbDraftId=12');
  await page.waitForFunction(()=>document.querySelector('.offer-id-cell input')?.value==='SOURCE-X');
  await vendors().nth(0).fill('REUSE-A');await vendors().nth(1).fill('REUSE-B');
  holdNextDraftList=true;
  await page.locator('.copy-header').getByRole('button',{name:'提交 WB',exact:true}).click();
  await preview.getByRole('button',{name:'确认提交 WB',exact:true}).waitFor();
  const lastReview=writes.filter(w=>w.path==='/api/wb/listing-publish/review').at(-1);
  assert.equal(lastReview.body.draft_id,12,'a different vendor reaches a new review instead of the original product operation');
  assert.ok(!writes.some(w=>w.path.includes('product-operation')));
  assert.ok(heldDraftList,'the save-triggered list refresh is still pending');
  await preview.getByRole('button',{name:'返回修改',exact:true}).click();
  await page.locator('.copy-header').getByRole('button',{name:'作为模板新建',exact:true}).click();
  await page.waitForURL(/wbTemplateId=12/);
  const copiedVendor=await vendors().first().inputValue(),refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/wb/workbench-drafts');
  await heldDraftList.fulfill({json:{rows:[...drafts.values()]}});await refreshed;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.match(page.url(),/wbTemplateId=12/,'an earlier save callback cannot replace the new template route');
  assert.ok(!page.url().includes('wbDraftId='));assert.equal(await vendors().first().inputValue(),copiedVendor);

  await page.goto('http://localhost:8788/admin.html#/listing-automation?platform=wb&wbDraftId=12&wbRecordId=32');
  await page.waitForFunction(()=>document.querySelector('.offer-id-cell input')?.value==='REUSE-A');
  assert.ok(page.url().includes('wbRecordId=32'),'opening an explicit publish record retains its original operation context');
  await page.locator('.copy-header').getByRole('button',{name:'提交 WB',exact:true}).click();
  await page.getByRole('dialog',{name:'恢复原商品并重新上架',exact:true}).getByText('请核对原商品身份',{exact:true}).waitFor();
  assert.equal(writes.find(w=>w.path==='/api/wb/product-operation/review').body.source_job_id,32);
  assert.deepEqual(pageErrors,[]);
 }catch(error){if(page){await fs.mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/wb-reusable-draft-failure.png',fullPage:true,animations:'disabled'});error.message+='\nBrowser text: '+(await page.locator('body').innerText()).slice(-5000);}throw error;}finally{await browser?.close();await fs.rm(output,{recursive:true,force:true});}
});

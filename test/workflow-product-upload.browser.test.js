import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {keyCaseWorkflow} from '../src/shared/product-workflow.js';
import {keyCaseProductionWorkflow} from '../src/shared/key-case-production-workflow.js';
import {starterWorkflow} from '../src/shared/workflow-starter.js';

// Real Vue controls and parent upload/submission logic; all resources and APIs are
// fulfilled in memory. No listener, production database or AI requests are used.
test('workflow main photos batch into independent drafts across presets and sample; uploads preserve row boundaries',{skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:180000},async()=>{
const root=process.cwd();
const output=path.resolve(process.env.WORKFLOW_BROWSER_ARTIFACT_DIR||'.deploy-artifacts/workflow-product-upload-browser');
await fs.mkdir(output,{recursive:true});
const category={templateId:7,descriptionCategoryId:100,typeId:200,name:'演示类目',attributes:[]};
const basic=keyCaseWorkflow();basic.name='基础钥匙壳流程';basic.category=category;basic.nodes.find(n=>n.type==='listing').templateId=7;
const production=keyCaseProductionWorkflow(category);production.name='双角度产品流程';
const product=production.nodes.find(n=>n.id==='product');product.count=2;product.slots=['正面主图','背面补充'];
production.nodes.find(n=>n.id==='color').required=true;
const generic=starterWorkflow(category);generic.name='自定义产品图字段流程';
const renameId='custom_product_photo';for(const n of generic.nodes){if(n.id==='product')n.id=renameId;n.inputs=n.inputs?.map(id=>id==='product'?renameId:id)||[];}
for(const b of Object.values(generic.bindings||{}))for(const s of b.sources||[])if(s.nodeId==='product')s.nodeId=renameId;
const starter=starterWorkflow(category,{sample:true});
const fixtures=[basic,production,generic,starter].map((payload,index)=>{for(const n of payload.nodes)if(n.type==='images'&&n.valueSource==='engineer')n.defaultValue=Array.from({length:n.count},(_,i)=>`http://localhost:8788/media/style-${i}.png`);return {id:`fixture-${index+1}`,revision:1,name:payload.name,payload};});
const entry=`import{createApp,h,ref}from'vue';import{createRouter,createWebHashHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import Workspace from'/frontend/admin/views/listing/ProductWorkflowView.vue';import{setAuthToken}from'/frontend/admin/utils/api.js';const target=ref(null);window.__workflow=target;setAuthToken('fixture-only');const app=createApp({setup(){return()=>h(Workspace,{ref:target})}});app.use(ElementPlus);app.use(createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]}));app.mount('#app');`;
const bundle=await build({configFile:false,root,publicDir:false,logLevel:'error',plugins:[{
 name:'expose-workflow-fixture-state',enforce:'pre',transform(code,id){if(id.replaceAll('\\','/').endsWith('/views/listing/ProductWorkflowView.vue'))return code.replace('</script>',`defineExpose({definition,sharedValues,variants,productionMode,productionOpen,busy});\n</script>`);}
},vue(),{name:'workflow-upload-fixture',resolveId(id){if(id==='virtual:workflow-upload')return '\0workflow-upload';},load(id){if(id==='\0workflow-upload')return entry;}}],build:{write:false,cssCodeSplit:false,rollupOptions:{input:'virtual:workflow-upload',output:{entryFileNames:'entry.js'}}}});
const assets=new Map(bundle.output.map(item=>[item.fileName,item.type==='asset'?item.source:item.code]));
const css=[...assets.keys()].find(k=>k.endsWith('.css'));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium'),headless:true});
const results=[],pageErrors=[],unexpected=[],writes=[],uploads=[],layoutMetrics=[];
let failSecondRun=false,runAttempts=0,keyCandidates=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);
 page.on('pageerror',e=>pageErrors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),json=data=>route.fulfill({json:data});
  if(u.origin!=='http://localhost:8788'){unexpected.push(req.url());return route.abort();}
  if(u.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/${css}"><style>html,body,#app{height:100%;margin:0}*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`});
  if(u.pathname==='/api/product-workflows/templates')return json(u.searchParams.has('id')?fixtures.find(f=>f.id===u.searchParams.get('id')):{items:fixtures,total:fixtures.length,page:1});
  if(u.pathname==='/api/product-workflows/runs'&&req.method()==='POST'){
   const data=req.postDataJSON();writes.push(data);runAttempts++;
   if(failSecondRun&&runAttempts===2)return route.fulfill({status:400,json:{error:'模拟第二件提交失败'}});
   return json({id:`run-${data.requestId}`,revision:1,payload:data.payload});
  }
  if(u.pathname==='/api/listing/media/upload'){
   const file=/filename="([^"]+)"/.exec(req.postDataBuffer()?.toString()||'')?.[1]||'unknown.png';uploads.push(file);
   if(file==='bad.png')return route.fulfill({status:400,json:{error:'模拟图片上传失败'}});
   return json({ok:true,publishUrl:`http://localhost:8788/media/${encodeURIComponent(file)}`});
  }
  if(u.pathname==='/api/ai-variant-lab/vehicle-catalog')return json({brands:[]});
  if(u.pathname==='/api/product-workflows/key-model-matches')return json(keyCandidates);
  if(u.pathname.startsWith('/api/'))return json([]);
  if(u.pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="108" height="144"><rect width="108" height="144" fill="#95b2cd"/></svg>'});
  const body=assets.get(u.pathname.slice(1));if(body!==undefined)return route.fulfill({contentType:u.pathname.endsWith('.css')?'text/css':'text/javascript',body});
  unexpected.push(req.url());return route.abort();
 });
 const state=()=>page.evaluate(()=>{const s=window.__workflow.value;return JSON.parse(JSON.stringify({definition:s.definition,sharedValues:s.sharedValues,rows:s.variants,mode:s.productionMode,busy:s.busy,open:s.productionOpen}));});
 const idle=()=>page.waitForFunction(()=>window.__workflow.value&&!window.__workflow.value.busy);
 let navigation=0;
 const open=async index=>{await page.goto(`http://localhost:8788/admin.html?case=${navigation++}#/product-workflows`);await page.getByRole('button',{name:'使用流程生产',exact:true}).nth(index).click();await page.locator('.production-form').waitFor();await idle();assert.equal((await state()).mode,'batch');};
 const close=async()=>{const button=page.locator('.production-dialog').getByRole('button',{name:'取消',exact:true});if(await button.count())await button.click();};
 const files=names=>names.map(name=>({name,mimeType:'image/png',buffer:Buffer.from('fixture-png')}));
 const upload=async(names,selector='input[aria-label="批量选择产品图片"]')=>{await page.locator(selector).first().setInputFiles(files(names));await idle();};
 const waitRows=count=>page.waitForFunction(count=>window.__workflow.value.variants.length===count&&!window.__workflow.value.busy,count);
 const mainUrls=s=>{const node=s.definition.nodes.find(n=>n.type==='images'&&n.scope!=='shared'&&n.referenceRole==='product');return s.rows.map(r=>r.values[node.id]?.[0]);};
 const complete=()=>page.evaluate(()=>{const s=window.__workflow.value;for(const n of s.definition.nodes){if(!['field','attribute','images'].includes(n.type))continue;const values=n.scope==='shared'?[s.sharedValues]:s.variants.map(r=>r.values);for(const v of values){if(n.type==='images'){if(!Array.isArray(v[n.id]))v[n.id]=[];for(let i=0;i<n.count;i++)v[n.id][i]||=`http://localhost:8788/media/${n.id}-${i}.png`;}else if(n.inputFormat!=='number')v[n.id]||=n.id==='model'?'HAVAL H3':'已核实信息';}}});
 const submit=async()=>{await complete();await page.locator('.production-dialog .el-dialog__footer').getByRole('button',{name:/开始生成/}).click();await idle();};

 for(let index=0;index<4;index++){
  await open(index);assert.equal(await page.locator('.production-form .el-radio-group').count(),0);
  if(index===1){const required=page.locator('.product-card:first-child .production-field').filter({hasText:'颜色'}).locator('input');assert.equal(await required.isVisible(),true,'required per-product facts stay visible without opening supplementary details');assert.equal(await required.evaluate(node=>Boolean(node.closest('details'))),false);await required.fill('蓝色');assert.equal((await state()).rows[0].values.color,'蓝色');}
  const old=(await state()).rows[0].id;
  await upload([`t${index}-1.png`,`t${index}-2.png`,`t${index}-3.png`]);await waitRows(3);
  const s=await state();assert.equal(s.rows[0].id,old);assert.deepEqual(mainUrls(s),[1,2,3].map(i=>`http://localhost:8788/media/t${index}-${i}.png`));
  const begin=writes.length;await submit();assert.equal(writes.length-begin,3,await page.locator('.el-message').allTextContents());const requests=writes.slice(begin);assert.ok(requests.every(r=>r.payload.variants.length===1&&r.payload.productionMode==='batch'));assert.equal(new Set(requests.map(r=>r.requestId)).size,3);const id=s.definition.nodes.find(n=>n.type==='images'&&n.scope!=='shared'&&n.referenceRole==='product').id;assert.deepEqual(requests.map(r=>r.payload.variants[0].values[id][0]),mainUrls(s));
  results.push({case:`template-${index+1}-multi-select-independent`,pass:true,requests:3});
 }

 await open(1);
 const originalId=(await state()).rows[0].id;
 await page.evaluate(()=>{const r=window.__workflow.value.variants[0];r.label='保留人工备注';r.values.color='红色';r.promptOverrides.main='保留人工要求';});
 await upload(['card-a.png','card-b.png','card-c.png'],'.product-card .product-upload-trigger input[type="file"]');await waitRows(3);
 let s=await state();assert.equal(s.rows[0].id,originalId);assert.equal(s.rows[0].label,'保留人工备注');assert.equal(s.rows[0].values.color,'红色');assert.equal(s.rows[0].promptOverrides.main,'保留人工要求');
 const before=uploads.length;await upload(['back.png'],'.product-card:first-child .upload-slot:nth-child(2) input[type="file"]');s=await state();assert.equal(s.rows.length,3);assert.equal(s.rows[0].values.product[1],'http://localhost:8788/media/back.png');assert.equal(uploads.length,before+1);assert.equal(s.rows[1].values.product[1],'');
 const capture=async(name,width,height)=>{await page.setViewportSize({width,height});await page.locator('.batch-drop').evaluate(node=>{const body=node.closest('.el-dialog__body');body.scrollTop+=node.getBoundingClientRect().top-body.getBoundingClientRect().top-80;});assert.ok(await page.locator('.production-dialog .el-dialog__body').evaluate(node=>node.scrollWidth<=node.clientWidth+1),`no modal horizontal overflow at ${width}px`);await page.screenshot({path:path.join(output,`batch-upload-${name}.png`),fullPage:true,style:'.el-message{visibility:hidden}'});};
 await capture('desktop',1440,1100);await capture('laptop',1366,900);await capture('small',900,1000);await page.setViewportSize({width:1440,height:1100});
 results.push({case:'card-main-multiple-preserves-facts-and-secondary-angle',pass:true});await close();

 await open(3);
 await page.locator('.batch-drop').evaluate(node=>{const transfer=new DataTransfer();for(let i=1;i<=3;i++)transfer.items.add(new File(['drop'],`drop-${i}.png`,{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
 await waitRows(3);assert.deepEqual(mainUrls(await state()),[1,2,3].map(i=>`http://localhost:8788/media/drop-${i}.png`));results.push({case:'global-native-multi-file-drop',pass:true});await close();

 await open(3);await upload(['success-a.png','bad.png','success-c.png']);await waitRows(2);s=await state();assert.deepEqual(mainUrls(s),['success-a.png','success-c.png'].map(n=>`http://localhost:8788/media/${n}`));await page.getByText(/1 张图片上传失败，其他成功图片已保留/).waitFor();results.push({case:'failed-upload-retains-successes-and-continues',pass:true});await close();

 await open(3);const uploadBeforeLimit=uploads.length,snapshotBefore=await state();await upload(Array.from({length:21},(_,i)=>`limit-${i}.png`));await page.getByText(/本批最多 20 件产品/).waitFor();assert.equal(uploads.length,uploadBeforeLimit);assert.deepEqual((await state()).rows,snapshotBefore.rows);
 await upload(Array.from({length:20},(_,i)=>`ok-${i}.png`));await waitRows(20);const uploadBeforeExtra=uploads.length;await upload(['overflow.png']);assert.equal(uploads.length,uploadBeforeExtra);assert.equal((await state()).rows.length,20);results.push({case:'whole-selection-capacity-check-and-exactly-twenty',pass:true});await close();

 await open(3);await page.evaluate(()=>{window.__workflow.value.variants[0].submissionStarted=true;});await page.waitForFunction(()=>document.querySelector('.batch-drop')?.getAttribute('aria-disabled')==='true');assert.equal(await page.locator('input[aria-label="批量选择产品图片"]').isDisabled(),true);assert.equal(await page.locator('.product-card .product-upload-trigger input').count(),0);assert.equal(await page.getByRole('button',{name:'＋ 添加产品 / 变体',exact:true}).isDisabled(),true);results.push({case:'submitted-inputs-locked',pass:true});await close();

 await open(3);await upload(['merge-a.png','merge-b.png','merge-c.png']);await waitRows(3);await page.getByRole('button',{name:'更多设置：草稿合并与其他属性'}).click();await page.locator('.draft-grouping .el-checkbox').click();const beforeMerge=writes.length;await submit();assert.equal(writes.length-beforeMerge,1);assert.equal(writes.at(-1).payload.variants.length,3);assert.equal(writes.at(-1).payload.productionMode,'variants');results.push({case:'optional-merged-multi-variant-draft',pass:true});

 await open(3);await upload(['retry-a.png','retry-b.png','retry-c.png']);await waitRows(3);failSecondRun=true;runAttempts=0;const retryBefore=writes.length;await submit();s=await state();assert.equal(s.open,true);assert.ok(s.rows[0].submittedId);assert.equal(s.rows[1].submittedId,null);assert.equal(s.rows[1].submissionStarted,true);assert.equal((await page.locator('.product-card:nth-child(1) .submitted-hint').innerText()).trim(),'已提交');assert.equal((await page.locator('.product-card:nth-child(2) .submitted-hint').innerText()).trim(),'提交待确认');assert.equal(await page.locator('.product-card:nth-child(1) input[type=file]').count(),0);assert.equal(await page.locator('.product-card:nth-child(2) input[type=file]').count(),0);await upload(['retry-c-replaced.png'],'.product-card:nth-child(3) .upload-slot:first-child input[type=file]');s=await state();assert.equal(s.rows[2].values.product[0],'http://localhost:8788/media/retry-c-replaced.png');assert.equal(s.rows[0].values.product[0],'http://localhost:8788/media/retry-a.png');failSecondRun=false;await submit();const retryCalls=writes.slice(retryBefore);assert.equal(retryCalls.length,4);assert.equal(retryCalls[1].requestId,retryCalls[2].requestId);assert.equal(new Set(retryCalls.map(r=>r.requestId)).size,3);assert.equal(retryCalls.at(-1).payload.variants[0].values.product[0],'http://localhost:8788/media/retry-c-replaced.png');results.push({case:'partial-submit-locks-started-allows-unstarted-image-and-retries-key',pass:true});

 const measureLayout=()=>page.evaluate(()=>{
  const q=selector=>document.querySelector(selector),rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
  const list=q('.product-cards'),body=q('.production-dialog .el-dialog__body'),key=q('.production-form .key-picker'),footer=q('.production-dialog .el-dialog__footer');
  return {viewport:{width:innerWidth,height:innerHeight},count:document.querySelectorAll('.product-card').length,key:rect(key),list:rect(list),listScroll:{clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,overflowY:getComputedStyle(list).overflowY},body:{clientHeight:body.clientHeight,scrollHeight:body.scrollHeight,clientWidth:body.clientWidth,scrollWidth:body.scrollWidth},footer:rect(footer),pageScrollWidth:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.product-card')].map(rect)};
 });
 const assertLayout=metric=>{
  assert.ok(metric.pageScrollWidth<=metric.viewport.width+1,'page has no horizontal overflow');
  assert.ok(metric.body.scrollWidth<=metric.body.clientWidth+1,'modal has no horizontal overflow');
  assert.ok(metric.footer.y>=0&&metric.footer.bottom<=metric.viewport.height,'generation controls stay inside the viewport');
  assert.ok(metric.rows.every(row=>Math.abs(row.x-metric.rows[0].x)<1),'each product occupies a full row');
  for(let i=1;i<metric.rows.length;i++)assert.ok(metric.rows[i].y>=metric.rows[i-1].bottom-1,'product rows do not overlap');
  if(metric.viewport.width>=900)assert.ok(metric.rows.every(row=>row.height<=150),'product rows remain compact at desktop widths');
  assert.ok(metric.list.height<=600,'large batches have a bounded product region');
  if(metric.count===20){assert.ok(metric.listScroll.scrollHeight>metric.listScroll.clientHeight,'twenty products scroll within the bounded region');assert.match(metric.listScroll.overflowY,/auto|scroll/);}
 };
 await open(1);await upload(Array.from({length:5},(_,i)=>`layout-${i}.png`));await waitRows(5);
 for(const size of [{width:1440,height:1100},{width:1366,height:900},{width:900,height:1000},{width:390,height:844}]){
  await page.setViewportSize(size);await page.locator('.production-dialog .el-dialog__body').evaluate(node=>node.scrollTop=0);
  const metric={stage:'five-empty-key',...await measureLayout()};layoutMetrics.push(metric);assertLayout(metric);
  if(size.width>=900)assert.ok(metric.key.height<=160,'empty key upload no longer occupies a tall panel');
  await page.screenshot({path:path.join(output,`compact-five-empty-key-${size.width}.png`),fullPage:true,style:'.el-message{visibility:hidden}'});
 }
 await page.setViewportSize({width:1440,height:1100});
 await upload(['key-layout.png'],'.production-form .key-picker input[type=file]');
 const filled={stage:'five-filled-key',...await measureLayout()};layoutMetrics.push(filled);assertLayout(filled);assert.ok(filled.key.height<=190,'a selected key retains a compact preview and actions');
 await page.locator('.production-form .key-picker .el-image').first().click();await page.locator('.el-image-viewer__wrapper').waitFor();await page.keyboard.press('Escape');await page.locator('.el-image-viewer__wrapper').waitFor({state:'hidden'});
 await upload(['key-replacement.png'],'.production-form .key-picker input[type=file]');assert.equal((await state()).sharedValues.key[0],'http://localhost:8788/media/key-replacement.png');
 await page.locator('.production-form .key-picker .upload-slot').getByRole('button',{name:'移除',exact:true}).click();assert.equal((await state()).sharedValues.key[0],'');
 await upload(['key-final.png'],'.production-form .key-picker input[type=file]');
 await page.locator('.product-card:first-child .el-image').first().click();await page.locator('.el-image-viewer__wrapper').waitFor();await page.keyboard.press('Escape');await page.locator('.el-image-viewer__wrapper').waitFor({state:'hidden'});
 await page.locator('.product-card:first-child .upload-slot').first().getByRole('button',{name:'移除',exact:true}).click();assert.equal((await state()).rows[0].values.product[0],'');
 await upload(['main-replacement.png'],'.product-card:first-child .product-upload-trigger input[type=file]');assert.equal((await state()).rows[0].values.product[0],'http://localhost:8788/media/main-replacement.png');assert.equal((await state()).rows.length,5);
 await page.locator('.product-card:first-child .product-upload-trigger').evaluate(node=>{const transfer=new DataTransfer();for(const name of ['card-drop-main.png','card-drop-extra.png'])transfer.items.add(new File(['drop'],name,{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});await waitRows(6);assert.equal((await state()).rows[0].values.product[0],'http://localhost:8788/media/card-drop-main.png');assert.equal((await state()).rows[5].values.product[0],'http://localhost:8788/media/card-drop-extra.png');
 await page.locator('.product-card:last-child .product-row-actions').getByRole('button',{name:'移除',exact:true}).click();await waitRows(5);
 await page.locator('.product-card:first-child details summary').click();await page.locator('.product-card:first-child details').getByPlaceholder('选填，只写这件产品的差异要求').first().fill('保留本产品补充要求');assert.equal((await state()).rows[0].promptOverrides.main,'保留本产品补充要求');await page.locator('.product-card:first-child details summary').click();
 await page.setViewportSize({width:1440,height:1300});await page.locator('.production-dialog .el-dialog__body').evaluate(node=>node.scrollTop=0);
 await page.locator('.product-cards').evaluate(node=>node.scrollTop=0);
 await page.screenshot({path:path.join(output,'compact-five-with-key-overview.png'),fullPage:true,style:'.el-message{visibility:hidden}'});
 results.push({case:'five-compact-product-rows-key-preview-replace-remove-and-responsive-layout',pass:true});
 await upload(Array.from({length:15},(_,i)=>`more-${i}.png`));await waitRows(20);
 for(const size of [{width:1440,height:1100},{width:1366,height:900},{width:900,height:1000},{width:390,height:844}]){await page.setViewportSize(size);const metric={stage:'twenty-filled-key',...await measureLayout()};layoutMetrics.push(metric);assertLayout(metric);}
 const firstId=(await state()).rows[0].id;
 await page.locator('.product-cards').evaluate(node=>node.scrollTop=node.scrollHeight);await page.locator('.product-card:last-child input[aria-label="产品备注名称"]').fill('末行独立备注');assert.equal((await state()).rows.at(-1).label,'末行独立备注');assert.equal((await state()).rows[0].id,firstId);
 await page.setViewportSize({width:1366,height:900});await page.locator('.product-cards').evaluate(node=>node.scrollTop=0);await page.locator('.production-dialog .el-dialog__body').evaluate(node=>node.scrollTop=0);await page.screenshot({path:path.join(output,'compact-twenty-scroll-region.png'),fullPage:true,style:'.el-message{visibility:hidden}'});
 results.push({case:'twenty-product-rows-use-bounded-scroll-and-retain-last-row-edits',pass:true});

 for(const count of [2,8]){
  keyCandidates=Array.from({length:3},(_,index)=>({id:`key-${count}-${index}`,kind:'key_model',revision:3,name:`适配候选 ${index+1}`,payload:{label:`${count} 槽钥匙候选 ${index+1}`,brand:'HAVAL',model:'H3',reviewStatus:'verified',bindings:[{brand:'HAVAL',models:['H3']}],images:Array.from({length:8},(_,i)=>`http://localhost:8788/media/key-${count}-${index}-${i}.png`)}}));
  await open(1);await page.evaluate(count=>{const s=window.__workflow.value,node=s.definition.nodes.find(node=>node.id==='key');node.count=count;node.slots=Array.from({length:count},(_,i)=>`适配钥匙角度 ${i+1}`);s.sharedValues.key=Array(count).fill('');s.sharedValues.model='HAVAL H3';},count);
  await page.waitForFunction(()=>document.querySelectorAll('.key-suggestions>article').length===3);assert.equal((await state()).sharedValues.__keyModelId,undefined,'ambiguous matches are not auto-selected');
  for(const size of [{width:1440,height:1100},{width:1366,height:900},{width:900,height:1000},{width:390,height:844}]){
   await page.setViewportSize(size);const metric={stage:`key-${count}-slots-three-candidates`,...await measureLayout()};layoutMetrics.push(metric);assertLayout(metric);if(size.width>=900)assert.ok(metric.key.height<=380,'candidate and input regions remain bounded');
   const scroll=await page.locator('.key-picker-input').evaluate(node=>({clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,overflowY:getComputedStyle(node).overflowY}));assert.ok(scroll.clientHeight<=132);if(count===8){assert.ok(scroll.scrollHeight>scroll.clientHeight,'eight key slots scroll inside their input area');assert.match(scroll.overflowY,/auto|scroll/);}
   if(size.width===390){const suggestions=await page.locator('.key-suggestions').evaluate(node=>({clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,overflowY:getComputedStyle(node).overflowY}));assert.ok(suggestions.clientHeight<=180);assert.ok(suggestions.scrollHeight>suggestions.clientHeight,'three candidates scroll on a narrow screen');assert.match(suggestions.overflowY,/auto|scroll/);}
  }
  const lastCandidate=page.locator('.key-suggestions>article').last();await lastCandidate.locator('.el-image').last().click();await page.locator('.el-image-viewer__wrapper').waitFor();assert.ok((await page.locator('.el-image-viewer__img').getAttribute('src')).includes(`key-${count}-2-7.png`));await page.keyboard.press('Escape');await page.locator('.el-image-viewer__wrapper').waitFor({state:'hidden'});
  await lastCandidate.getByRole('button',{name:'选用此模具',exact:true}).click();s=await state();assert.equal(s.sharedValues.__keyModelId,`key-${count}-2`);assert.equal(s.sharedValues.__keyModelRevision,3);assert.deepEqual(s.sharedValues.key,keyCandidates[2].payload.images.slice(0,count));await lastCandidate.getByRole('button',{name:'已选用',exact:true}).waitFor();
  await page.locator('.key-picker-input .el-image').last().click();await page.locator('.el-image-viewer__wrapper').waitFor();assert.ok((await page.locator('.el-image-viewer__img').getAttribute('src')).includes(`key-${count}-2-${count-1}.png`));await page.keyboard.press('Escape');await page.locator('.el-image-viewer__wrapper').waitFor({state:'hidden'});
  await page.setViewportSize({width:1366,height:900});await page.locator('.production-dialog .el-dialog__body').evaluate(node=>node.scrollTop=0);await page.screenshot({path:path.join(output,`compact-key-${count}-slots-candidates.png`),fullPage:true,style:'.el-message{visibility:hidden}'});
  results.push({case:`key-${count}-slots-three-candidates-scroll-preview-and-explicit-selection`,pass:true});
 }

 assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpected,[]);
 await fs.writeFile(path.join(output,'result.json'),JSON.stringify({results,layoutMetrics,counts:{checks:results.length,uploads:uploads.length,runPostRequests:writes.length},pageErrors,unexpected,allPass:true},null,2),'utf8');
 console.log(JSON.stringify({ok:true,checks:results.length,artifacts:output,pageErrors,unexpected}));
}catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,results,layoutMetrics,pageErrors,unexpected},null,2),'utf8');throw error;}
finally{await browser.close();}

});

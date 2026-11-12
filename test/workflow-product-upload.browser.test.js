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
const results=[],pageErrors=[],unexpected=[],writes=[],uploads=[];
let failSecondRun=false,runAttempts=0;
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

 await open(3);await upload(['retry-a.png','retry-b.png','retry-c.png']);await waitRows(3);failSecondRun=true;runAttempts=0;const retryBefore=writes.length;await submit();s=await state();assert.equal(s.open,true);assert.ok(s.rows[0].submittedId);assert.equal(s.rows[1].submittedId,null);assert.equal(s.rows[1].submissionStarted,true);assert.equal(await page.locator('.product-card:nth-child(1) input[type=file]').count(),0);assert.equal(await page.locator('.product-card:nth-child(2) input[type=file]').count(),0);await upload(['retry-c-replaced.png'],'.product-card:nth-child(3) .upload-slot:first-child input[type=file]');s=await state();assert.equal(s.rows[2].values.product[0],'http://localhost:8788/media/retry-c-replaced.png');assert.equal(s.rows[0].values.product[0],'http://localhost:8788/media/retry-a.png');failSecondRun=false;await submit();const retryCalls=writes.slice(retryBefore);assert.equal(retryCalls.length,4);assert.equal(retryCalls[1].requestId,retryCalls[2].requestId);assert.equal(new Set(retryCalls.map(r=>r.requestId)).size,3);assert.equal(retryCalls.at(-1).payload.variants[0].values.product[0],'http://localhost:8788/media/retry-c-replaced.png');results.push({case:'partial-submit-locks-started-allows-unstarted-image-and-retries-key',pass:true});

 assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpected,[]);
 await fs.writeFile(path.join(output,'result.json'),JSON.stringify({results,counts:{checks:results.length,uploads:uploads.length,runPostRequests:writes.length},pageErrors,unexpected,allPass:true},null,2),'utf8');
 console.log(JSON.stringify({ok:true,checks:results.length,artifacts:output,pageErrors,unexpected}));
}catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,results,pageErrors,unexpected},null,2),'utf8');throw error;}
finally{await browser.close();}

});

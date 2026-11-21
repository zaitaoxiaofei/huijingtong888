import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';
import {starterWorkflow} from '../src/shared/workflow-starter.js';

test('workflow loads visible data on demand and regenerates only explicitly confirmed nodes', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000}, async()=>{
 const output=path.resolve('.deploy-artifacts/workflow-loading-regeneration-browser');await fs.mkdir(output,{recursive:true});
 const category={templateId:7,descriptionCategoryId:100,typeId:200,categoryName:'测试类目',attributes:[]};
 const templates=Array.from({length:4},(_,i)=>({id:`template-${i}`,name:`通用模板 ${i+1}`,revision:1,payload:{...starterWorkflow(category),name:`通用模板 ${i+1}`}}));
 const fixture=()=>({id:'fixture-run',name:'恢复验证',revision:1,payload:{definition:{name:'恢复验证',category:{categoryName:'测试类目'},nodes:[
  {id:'main',type:'image',inputs:[],role:'main',label:'已完成主图',ratio:'3:4'},
  {id:'detail',type:'image',inputs:['main'],role:'detail',label:'未知详情图',ratio:'3:4'},
  {id:'copy',type:'copy',inputs:[],target:'description',label:'失败文案'},
  {id:'video',type:'video',inputs:['main'],label:'取消视频'},
  {id:'material',type:'image',imageMode:'material',inputs:[],label:'资料图片',ratio:'3:4'},
  {id:'active',type:'image',inputs:['main'],label:'运行中详情',ratio:'3:4'},
  {id:'missing-task',type:'copy',inputs:[],target:'title',label:'无回执文案'}
 ]},variants:[{id:'variant-a',label:'商品 A',values:{}}],outputs:{'variant-a':{
  main:{status:'done',approved:true,url:'/media/main.png',taskId:'retained-main'},detail:{status:'unknown',taskId:'original-detail',submissionKey:'original-submit',error:'原任务结果未知'},copy:{status:'failed',taskId:'original-copy',text:{}},video:{status:'cancelled',taskId:'original-video'},material:{status:'failed'},active:{status:'running',taskId:'active-task'},'missing-task':{status:'unknown'}
 }}}});
 const entry=`import{createApp,h,ref}from'vue';import{createRouter,createWebHashHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import View from'/frontend/admin/views/listing/ProductWorkflowView.vue';import{setAuthToken}from'/frontend/admin/utils/api.js';setAuthToken('fixture-only');const target=ref(null);window.__workflow=target;const app=createApp({setup(){return()=>h(View,{ref:target});}});app.use(ElementPlus);app.use(createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]}));app.mount('#app');`;
 const bundle=await build({configFile:false,root:process.cwd(),publicDir:false,logLevel:'error',plugins:[{name:'expose-loading-regeneration',enforce:'pre',transform(code,id){if(id.replaceAll('\\','/').endsWith('/views/listing/ProductWorkflowView.vue'))return code.replace('</script>','defineExpose({busy,runOpen,runDocument,editorOpen,selectedCategory,selectedCategoryKey});\n</script>');}},vue(),{name:'loading-regeneration-entry',resolveId(id){if(id==='virtual:loading-regeneration')return '\0loading-regeneration';},load(id){if(id==='\0loading-regeneration')return entry;}}],build:{write:false,cssCodeSplit:false,rollupOptions:{input:'virtual:loading-regeneration',output:{entryFileNames:'entry.js'}}}});
 const assets=new Map(bundle.output.map(item=>[item.fileName,item.type==='asset'?item.source:item.code]));const css=[...assets.keys()].find(name=>name.endsWith('.css'));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium'),headless:true});
 const requests=[],writes=[],errors=[],unexpected=[],checks=[],gates=[];let hangBackground=true,shopsFailOnce=true,regenerateFailOnce=false,serverRecord=fixture(),runStatus='awaiting_review';
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
   if(url.origin!=='http://localhost:8788'){unexpected.push(request.url());return route.abort();}
   if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}</style></head><body style="margin:0"><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`});
   if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,query:url.search,method:request.method()});
   const background=url.pathname==='/api/product-workflows/runs'&&!url.searchParams.has('id')||['/api/listing/templates','/api/shops'].includes(url.pathname);
   if(background&&hangBackground)await new Promise(resolve=>gates.push(resolve));
   if(url.pathname==='/api/product-workflows/templates')return json(url.searchParams.has('id')?templates.find(item=>item.id===url.searchParams.get('id')):{items:templates,total:4,page:1});
   if(url.pathname==='/api/product-workflows/category')return json(category);
   if(url.pathname==='/api/listing/templates')return json([{id:7,ozon_category_id:'100:200'}]);
   if(url.pathname==='/api/shops'){if(shopsFailOnce){shopsFailOnce=false;return route.fulfill({status:503,json:{error:'模拟店铺读取失败，请重试'}});}return json([{id:1,name:'测试店铺',status:'active',platform:'ozon'}]);}
   if(url.pathname==='/api/product-workflows/runs')return json(url.searchParams.has('id')?serverRecord:{items:[{id:'fixture-run',name:'恢复验证',revision:1,variant_count:1}],total:1,page:1});
   if(url.pathname==='/api/product-workflows/job-states')return json([{run_id:'fixture-run',status:runStatus}]);
   if(url.pathname==='/api/product-workflows/run-action'&&request.method()==='POST'){
    const body=request.postDataJSON();writes.push(body);
    if(body.action==='regenerate'){if(regenerateFailOnce){regenerateFailOnce=false;return route.fulfill({status:503,json:{error:'模拟响应中断，可重试同一确认'}});}serverRecord.payload.outputs['variant-a'].detail={status:'running',taskId:'new-detail-task',submissionKey:'new-submit-key'};runStatus='running';}
    return json(serverRecord);
   }
   if(url.pathname.startsWith('/api/')){if(request.method()!=='GET')unexpected.push(`${request.method()} ${url.pathname}`);return json([]);}
   if(url.pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#afc6d7"/></svg>'});
   const body=assets.get(url.pathname.slice(1));if(body!==undefined)return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body});unexpected.push(request.url());return route.abort();
  });
  const idle=()=>page.waitForFunction(()=>window.__workflow.value&&!window.__workflow.value.busy);
  const count=pathname=>requests.filter(item=>item.path===pathname).length;
  await page.goto('http://localhost:8788/admin.html#/product-workflows');await idle();assert.equal(await page.locator('.flow-library .flow-card').count(),4);
  assert.equal(count('/api/product-workflows/runs'),0);assert.equal(count('/api/product-workflows/job-states'),0);assert.equal(count('/api/listing/templates'),0);assert.equal(count('/api/shops'),0);assert.equal(gates.length,0);checks.push({case:'four-template-library-does-not-request-or-wait-for-unrelated-suspended-endpoints',pass:true});
  await page.screenshot({path:path.join(output,'four-template-first-load.png'),fullPage:true});hangBackground=false;gates.splice(0).forEach(resolve=>resolve());
  await page.getByRole('tab',{name:'任务管理',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#pane-tasks .el-table__body tr'));
  assert.equal(requests.filter(item=>item.path==='/api/product-workflows/runs'&&item.query.includes('section=tasks')).length,1);assert.equal(requests.filter(item=>item.path==='/api/product-workflows/runs'&&item.query.includes('section=results')).length,0);
  await page.getByRole('tab',{name:'生产结果',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#pane-results .el-table__body tr'));assert.equal(requests.filter(item=>item.path==='/api/product-workflows/runs'&&item.query.includes('section=results')).length,1);checks.push({case:'task-and-result-pages-load-only-when-selected',pass:true});
  await page.getByRole('tab',{name:/^任务管理/}).click();hangBackground=true;const beforeRecovery=requests.length;await page.locator('#pane-tasks').getByRole('button',{name:'查看',exact:true}).click();await idle();await page.locator('.task-recovery .blocked-node').filter({hasText:'未知详情图'}).getByRole('button',{name:'核对并恢复原任务',exact:true}).click();await idle();
  assert.equal(requests.slice(beforeRecovery).filter(item=>item.path==='/api/product-workflows/runs'&&!item.query.includes('id=')).length,0);assert.equal(writes.at(-1).action,'retry');checks.push({case:'recovery-does-not-wait-for-previously-visited-hidden-lists',pass:true});hangBackground=false;await page.keyboard.press('Escape');gates.splice(0).forEach(resolve=>resolve());writes.length=0;
  await page.getByRole('tab',{name:'已有流程',exact:true}).click();await page.locator('.flow-library').getByRole('button',{name:'使用流程生产',exact:true}).first().click();await page.locator('.production-form').waitFor();await idle();assert.equal(count('/api/shops'),0);assert.equal(count('/api/listing/templates'),0);await page.locator('.production-dialog').getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('.flow-library').getByRole('button',{name:'编辑',exact:true}).first().click();await idle();assert.equal(count('/api/product-workflows/category'),1);assert.equal(count('/api/shops'),0);
  await page.getByRole('tab',{name:'风格与店铺',exact:true}).click();await page.getByText('模拟店铺读取失败，请重试',{exact:true}).waitFor();assert.equal(count('/api/shops'),1);await page.getByRole('tab',{name:'图片模板',exact:true}).click();await page.getByRole('tab',{name:'风格与店铺',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.general-settings .el-select').length>0);await page.waitForTimeout(100);assert.equal(count('/api/shops'),2);
  await page.getByRole('button',{name:'更换',exact:true}).click();await page.evaluate(()=>{window.__workflow.value.selectedCategory={ozon_category_id:'100:200',category_name_zh:'测试类目'};window.__workflow.value.selectedCategoryKey='100:200';});await page.getByRole('button',{name:'载入类目字段',exact:true}).click();await idle();assert.equal(count('/api/listing/templates'),1);checks.push({case:'production-and-editor-load-only-required-category-and-shop-dependencies-with-failure-retry',pass:true});
  const priorRequests=requests.length;hangBackground=true;
  await page.goto('http://localhost:8788/admin.html?case=run#/product-workflows?runId=fixture-run&tab=tasks');await idle();await page.locator('.review-grid').waitFor();
  const runRequests=requests.slice(priorRequests);assert.ok(runRequests.some(item=>item.path==='/api/product-workflows/runs'&&item.query.includes('id=fixture-run')));assert.equal(runRequests.filter(item=>item.path==='/api/product-workflows/templates'||item.path==='/api/listing/templates'||item.path==='/api/shops'||item.path==='/api/product-workflows/runs'&&!item.query.includes('id=')).length,0);checks.push({case:'direct-run-opens-before-unrelated-lists',pass:true});
  const card=label=>page.locator('.review-grid article').filter({has:page.getByRole('heading',{name:label,exact:true})});
  await card('未知详情图').getByRole('button',{name:'核对并恢复原任务',exact:true}).waitFor();await card('未知详情图').getByRole('button',{name:'重新生成',exact:true}).waitFor();
  assert.equal(await card('失败文案').getByRole('button',{name:'重新生成',exact:true}).count(),1);assert.equal(await card('失败文案').getByRole('button',{name:'核对并恢复原任务',exact:true}).count(),0);assert.equal(await card('取消视频').getByRole('button',{name:'重新生成',exact:true}).count(),1);assert.equal(await card('资料图片').getByRole('button',{name:'重新生成',exact:true}).count(),0);assert.equal(await card('运行中详情').getByRole('button',{name:'重新生成',exact:true}).count(),0);assert.equal(await card('无回执文案').getByRole('button',{name:'核对并恢复原任务',exact:true}).count(),0);
  const mainBefore=await page.evaluate(()=>JSON.parse(JSON.stringify(window.__workflow.value.runDocument.payload.outputs['variant-a'].main)));
  await card('未知详情图').getByRole('button',{name:'重新生成',exact:true}).click();const confirm=page.locator('.el-message-box');await confirm.getByRole('button',{name:'确认重新生成',exact:true}).waitFor();const warning=await confirm.innerText();assert.match(warning,/新的费用/);assert.match(warning,/原任务仍可能返回/);assert.match(warning,/后续结果将清除/);await confirm.getByRole('button',{name:'取消',exact:true}).click();await idle();assert.equal(writes.length,0);checks.push({case:'independent-regeneration-is-available-only-for-unfinished-ai-nodes-and-cancel-has-no-write',pass:true});
  regenerateFailOnce=true;await card('未知详情图').getByRole('button',{name:'重新生成',exact:true}).click();await confirm.getByRole('button',{name:'确认重新生成',exact:true}).click();await page.getByText('模拟响应中断，可重试同一确认',{exact:true}).waitFor();await idle();assert.equal(writes.length,1);
  await card('未知详情图').getByRole('button',{name:'重新生成',exact:true}).click();await confirm.getByRole('button',{name:'确认重新生成',exact:true}).click();await idle();await page.waitForFunction(()=>window.__workflow.value.runDocument.payload.outputs['variant-a'].detail.taskId==='new-detail-task');
  assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);const sent=writes[0];assert.match(sent.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.deepEqual({...sent,requestId:'id'},{id:'fixture-run',action:'regenerate',variantId:'variant-a',nodeId:'detail',requestId:'id',expectedTaskId:'original-detail',expectedSubmissionKey:'original-submit',confirmNewGeneration:true});assert.deepEqual(await page.evaluate(()=>JSON.parse(JSON.stringify(window.__workflow.value.runDocument.payload.outputs['variant-a'].main))),mainBefore);checks.push({case:'confirmed-regeneration-keeps-exact-original-identity-and-reuses-request-after-response-failure',pass:true});
  serverRecord=fixture();runStatus='awaiting_review';await page.goto('http://localhost:8788/admin.html?case=recovery#/product-workflows?runId=fixture-run');await idle();await card('未知详情图').getByRole('button',{name:'核对并恢复原任务',exact:true}).click();await idle();assert.equal(writes.at(-1).action,'retry');assert.equal(writes.at(-1).recoverOnly,true);checks.push({case:'original-recovery-remains-a-retry-of-the-existing-task',pass:true});
  serverRecord=fixture();serverRecord.payload.completionReview={mode:'partial'};await page.goto('http://localhost:8788/admin.html?case=partial#/product-workflows?runId=fixture-run');await idle();assert.equal(await page.locator('.review-grid').getByRole('button',{name:'重新生成',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'整套检查通过，完成生产',exact:true}).isEnabled(),true);checks.push({case:'partial-completion-remains-frozen-and-import-recovery-stays-available',pass:true});
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({allPass:true,checks,requests,writes,pageErrors:errors,unexpected},null,2),'utf8');console.log(JSON.stringify({allPass:true,checks:checks.length,artifacts:output}));
 }catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks,requests,writes,pageErrors:errors,unexpected},null,2),'utf8');throw error;}finally{hangBackground=false;gates.splice(0).forEach(resolve=>resolve());await browser.close();}
});

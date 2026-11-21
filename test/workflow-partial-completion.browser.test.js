import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

// Real parent/component interaction and confirmation controls. All resources
// and API responses stay in memory; no listener, database or AI is called.
test('generic workflow completion requires explicit omission consent and preserves successful outputs', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000}, async()=>{
  const output=path.resolve('.deploy-artifacts/workflow-partial-completion-browser');await fs.mkdir(output,{recursive:true});
  const fixture=()=>({id:'fixture-run',name:'通用流程',revision:1,payload:{definition:{schemaVersion:1,name:'通用流程',reviewMode:'manual',category:{categoryName:'演示类目'},nodes:[
    {id:'main',type:'image',inputs:[],label:'主图',role:'main',ratio:'3:4'},
    {id:'detail',type:'image',inputs:['main'],label:'缺失详情图',role:'detail',ratio:'3:4'},
    {id:'description',type:'copy',inputs:[],label:'缺失简介',target:'description'}
  ]},variants:[{id:'variant-a',label:'商品 A',values:{}}],outputs:{'variant-a':{
    main:{status:'done',approved:true,taskId:'retained-main-task',url:'/media/main.png'},
    detail:{status:'unknown',taskId:'original-detail-task',submissionKey:'saved-submit-key',error:'供应商回执待核对',progressMessage:'正在查询原任务结果，不重复提交'},
    description:{status:'failed',taskId:'original-copy-task',error:'文案服务未返回结果'}
  }}}});
  const entry=`import{createApp,h,ref}from'vue';import{createRouter,createWebHashHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import Workspace from'/frontend/admin/views/listing/ProductWorkflowView.vue';import{setAuthToken}from'/frontend/admin/utils/api.js';setAuthToken('fixture-only');const target=ref(null);window.__workflow=target;const app=createApp({setup(){return()=>h(Workspace,{ref:target});}});app.use(ElementPlus);app.use(createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]}));app.mount('#app');`;
  const bundle=await build({configFile:false,root:process.cwd(),publicDir:false,logLevel:'error',plugins:[{
    name:'expose-partial-completion-state',enforce:'pre',transform(code,id){if(id.replaceAll('\\','/').endsWith('/views/listing/ProductWorkflowView.vue'))return code.replace('</script>','defineExpose({runDocument,runOpen,busy});\n</script>');}
  },vue(),{name:'partial-completion-fixture',resolveId(id){if(id==='virtual:partial-completion')return '\0partial-completion';},load(id){if(id==='\0partial-completion')return entry;}}],build:{write:false,cssCodeSplit:false,rollupOptions:{input:'virtual:partial-completion',output:{entryFileNames:'entry.js'}}}});
  const assets=new Map(bundle.output.map(item=>[item.fileName,item.type==='asset'?item.source:item.code]));const css=[...assets.keys()].find(name=>name.endsWith('.css'));
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium'),headless:true});
  const errors=[],unexpected=[],writes=[],checks=[];let serverRecord=fixture(),jobStatus='failed',detailReads=0,retryReads=0,keepPending=false,failImportOnce=false;
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),json=data=>route.fulfill({json:data});
      if(url.origin!=='http://localhost:8788'){unexpected.push(request.url());return route.abort();}
      if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}</style></head><body style="margin:0"><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`});
      if(url.pathname==='/api/product-workflows/templates')return json({items:[],total:0,page:1});
      if(url.pathname==='/api/product-workflows/runs'){
        if(url.searchParams.has('id')){detailReads++;if(retryReads&&++retryReads>=3&&!keepPending){serverRecord.payload.outputs['variant-a'].detail.status='unknown';serverRecord.payload.outputs['variant-a'].detail.phase=null;serverRecord.payload.outputs['variant-a'].detail.progressMessage=null;jobStatus='awaiting_review';}return json(serverRecord);}
        const list=url.searchParams.get('section')===(serverRecord.payload.draftId?'results':'tasks')?[{id:serverRecord.id,name:serverRecord.name,revision:serverRecord.revision,draft_id:serverRecord.payload.draftId||null,variant_count:1,product_label:'商品 A',category_name:'演示类目'}]:[];
        return json({items:list,total:list.length,page:1});
      }
      if(url.pathname==='/api/product-workflows/job-states')return json([{run_id:serverRecord.id,status:jobStatus}]);
      if(url.pathname==='/api/product-workflows/run-action'&&request.method()==='POST'){
        const body=request.postDataJSON();writes.push({path:url.pathname,body});
        if(body.action==='retry'){
          const prior=structuredClone(serverRecord);serverRecord.payload.outputs['variant-a'].detail.status='running';serverRecord.payload.outputs['variant-a'].detail.phase='provider_pending';serverRecord.payload.outputs['variant-a'].detail.progressMessage='正在查询原任务结果，不重复提交';jobStatus='running';retryReads=1;
          prior.payload.outputs['variant-a'].detail.status='resubmit';return json(prior);
        }
        for(const item of body.incompleteNodes||[])serverRecord.payload.outputs[item.variantId][item.nodeId].completionIgnored=true;
        if(body.ignoreIncomplete)serverRecord.payload.completionReview={mode:'partial'};
        jobStatus='ready';return json(serverRecord);
      }
      if(url.pathname==='/api/product-workflows/import-draft'&&request.method()==='POST'){writes.push({path:url.pathname,body:request.postDataJSON()});if(failImportOnce){failImportOnce=false;serverRecord.payload.draftImportStatus='unknown';return route.fulfill({status:503,json:{error:'保存响应中断，请再次完成保存'}});}serverRecord.payload.draftId=77;jobStatus='imported';return json({id:77});}
      if(url.pathname.startsWith('/api/')){if(request.method()!=='GET')unexpected.push(`${request.method()} ${url.pathname}`);return json([]);}
      if(url.pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#a8c5da"/><text x="150" y="210" text-anchor="middle" font-size="24">SAVED MAIN</text></svg>'});
      const body=assets.get(url.pathname.slice(1));if(body!==undefined)return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body});unexpected.push(request.url());return route.abort();
    });
    let navigation=0;
    const open=async()=>{retryReads=0;await page.goto(`http://localhost:8788/admin.html?case=${navigation++}#/product-workflows?runId=fixture-run&tab=tasks`);await page.waitForFunction(()=>window.__workflow.value?.runOpen&&!window.__workflow.value.busy);await page.getByRole('button',{name:'整套检查通过，完成生产',exact:true}).waitFor();};
    const complete=()=>page.getByRole('button',{name:'整套检查通过，完成生产',exact:true}).click();
    const dialog=()=>page.locator('.el-message-box');
    const snapshot=()=>page.evaluate(()=>JSON.parse(JSON.stringify(window.__workflow.value.runDocument)));
    await open();const initial=await snapshot(),readBefore=detailReads;
    await complete();await dialog().getByRole('button',{name:'忽略这些节点并继续保存',exact:true}).waitFor();
    assert.ok(detailReads>readBefore,'finishing rereads the persisted run before asking for consent');
    await dialog().getByText(/商品 A · 缺失详情图/).waitFor();await dialog().getByText(/商品 A · 缺失简介/).waitFor();
    assert.ok((await dialog().innerText()).includes('供应商回执待核对'));assert.ok((await dialog().innerText()).includes('文案服务未返回结果'));
    await page.screenshot({path:path.join(output,'partial-completion-confirmation.png'),fullPage:true});
    await dialog().getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>!window.__workflow.value.busy);
    assert.deepEqual(writes,[]);assert.deepEqual((await snapshot()).payload.outputs,initial.payload.outputs);checks.push({case:'missing-image-and-copy-list-reasons-cancel-writes-nothing',pass:true});
    await complete();await dialog().getByRole('button',{name:'忽略这些节点并继续保存',exact:true}).click();
    await page.getByRole('button',{name:'Ozon 草稿',exact:true}).first().waitFor();await page.waitForFunction(()=>!window.__workflow.value.busy);
    assert.deepEqual(writes,[{path:'/api/product-workflows/run-action',body:{id:'fixture-run',action:'approve-all',ignoreIncomplete:true,incompleteNodes:[{variantId:'variant-a',nodeId:'detail',taskId:'original-detail-task'},{variantId:'variant-a',nodeId:'description',taskId:'original-copy-task'}]}},{path:'/api/product-workflows/import-draft',body:{id:'fixture-run'}}]);
    const saved=await snapshot();assert.deepEqual(saved.payload.outputs['variant-a'].main,initial.payload.outputs['variant-a'].main);assert.equal(await page.getByText('已忽略',{exact:true}).count(),2);assert.equal(await page.getByRole('button',{name:'核对并恢复原任务',exact:true}).count(),0);
    assert.equal(saved.payload.outputs['variant-a'].detail.progressMessage,'正在查询原任务结果，不重复提交');assert.equal(await page.getByText('正在查询原任务结果，不重复提交',{exact:true}).count(),0,'ignored nodes hide stale progress while retaining its audit value');
    await page.screenshot({path:path.join(output,'partial-completion-saved.png'),fullPage:true});checks.push({case:'explicit-consent-sends-exact-omission-identities-and-retains-successful-main',pass:true});
    serverRecord=fixture();jobStatus='running';serverRecord.payload.outputs['variant-a'].detail.status='running';serverRecord.payload.outputs['variant-a'].detail.phase='provider_pending';await open();
    // The copy completes after opening. Confirmation must use the fresh state.
    serverRecord.payload.outputs['variant-a'].description={status:'done',text:{description:'已补齐文案'}};
    await complete();await dialog().getByRole('button',{name:'忽略这些节点并继续保存',exact:true}).waitFor();
    assert.equal(await dialog().getByText(/商品 A · 缺失简介/).count(),0);await dialog().getByText(/商品 A · 缺失详情图/).waitFor();await dialog().getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>!window.__workflow.value.busy);checks.push({case:'running-pending-can-finish-and-latest-completed-copy-is-not-omitted',pass:true});
    serverRecord=fixture();jobStatus='awaiting_review';serverRecord.payload.outputs['variant-a'].detail={status:'done',url:'/media/detail.png'};serverRecord.payload.outputs['variant-a'].description={status:'done',text:{description:'全部完成'}};await open();const normalStart=writes.length;
    await complete();await dialog().getByRole('button',{name:'确认完成',exact:true}).waitFor();assert.equal(await dialog().getByText(/忽略/).count(),0);await dialog().getByRole('button',{name:'确认完成',exact:true}).click();await page.waitForFunction(()=>!window.__workflow.value.busy&&window.__workflow.value.runDocument.payload.draftId===77);
    assert.deepEqual(writes.slice(normalStart),[{path:'/api/product-workflows/run-action',body:{id:'fixture-run',action:'approve-all'}},{path:'/api/product-workflows/import-draft',body:{id:'fixture-run'}}]);checks.push({case:'complete-run-keeps-normal-confirmation-and-contract',pass:true});
    serverRecord=fixture();jobStatus='awaiting_review';failImportOnce=true;
    serverRecord.payload.outputs['variant-a'].description.text={description:''};
    serverRecord.payload.definition.nodes.push({id:'approval',type:'approval',inputs:['main'],label:'主图人工确认'});
    await open();const interruptedStart=writes.length;
    await complete();await dialog().getByRole('button',{name:'忽略这些节点并继续保存',exact:true}).click();
    await page.waitForFunction(()=>!window.__workflow.value.busy&&window.__workflow.value.runDocument.payload.draftImportStatus==='unknown');
    assert.equal(await page.getByRole('button',{name:'整套检查通过，完成生产',exact:true}).isEnabled(),true);
    assert.equal(await page.locator('.review-grid textarea').isDisabled(),true);
    assert.equal(await page.locator('.review-actions').count(),0);assert.equal(await page.locator('.task-recovery').count(),0);
    assert.equal(await page.getByRole('button',{name:'主图确认，后台继续生成',exact:true}).count(),0);
    await page.getByText('已按确认忽略未完成节点，已完成内容已保留。点击“整套检查通过，完成生产”可继续保存到操作箱。',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'partial-completion-import-recovery.png'),fullPage:true,style:'.el-message{visibility:hidden}'});
    await complete();await dialog().getByRole('button',{name:'确认完成',exact:true}).click();await page.waitForFunction(()=>!window.__workflow.value.busy&&window.__workflow.value.runDocument.payload.draftId===77);
    const interruptedWrites=writes.slice(interruptedStart);assert.equal(interruptedWrites.length,3);assert.deepEqual(interruptedWrites.map(item=>item.path),['/api/product-workflows/run-action','/api/product-workflows/import-draft','/api/product-workflows/import-draft']);assert.equal(interruptedWrites[0].body.action,'approve-all');assert.equal(interruptedWrites[0].body.ignoreIncomplete,true);
    assert.equal((await snapshot()).payload.outputs['variant-a'].main.taskId,'retained-main-task');checks.push({case:'partial-approval-freezes-node-controls-and-retries-unknown-import-without-new-generation',pass:true});
    serverRecord=fixture();jobStatus='awaiting_review';await open();const recover=page.locator('.task-recovery').getByRole('button',{name:'核对并恢复原任务',exact:true});await recover.click();
    await page.waitForFunction(()=>window.__workflow.value.runDocument.payload.outputs['variant-a'].detail.status==='unknown'&&document.querySelector('.run-drawer-header .el-tag')?.textContent==='待人工检查');
    assert.ok(retryReads>=3,'bounded retry refresh must reread the post-worker review state');assert.equal(await page.getByText('正在查询原任务结果，不重复提交',{exact:true}).count(),0);
    const stoppedReads=detailReads;await page.waitForTimeout(1200);assert.equal(detailReads,stoppedReads,'review result ends the directed refresh');checks.push({case:'retry-refreshes-worker-result-without-a-permanent-polling-loop',pass:true});
    serverRecord=fixture();jobStatus='awaiting_review';keepPending=true;await open();await page.locator('.task-recovery').getByRole('button',{name:'核对并恢复原任务',exact:true}).click();await page.waitForFunction(()=>window.__workflow.value.runDocument.payload.outputs['variant-a'].detail.phase==='provider_pending');
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.__workflow.value.runOpen);const closedReads=detailReads;await page.waitForTimeout(1200);assert.equal(detailReads,closedReads,'closing the drawer cancels remaining retry refreshes');checks.push({case:'closing-the-drawer-stops-directed-retry-refresh',pass:true});
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({allPass:true,checks,writes,pageErrors:errors,unexpected},null,2),'utf8');console.log(JSON.stringify({allPass:true,checks:checks.length,artifacts:output}));
  }catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks,writes,pageErrors:errors,unexpected},null,2),'utf8');throw error;}finally{await browser.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';
import vue from '@vitejs/plugin-vue';
import {chromium} from 'playwright-core';

// Real Vue components and controls, with every resource/API fulfilled in
// memory. No listener, database, supplier call or production write is used.
test('workflow reconciliation keeps completed images and exposes original-node recovery with readable records', {skip:process.env.RUN_TASK_BROWSER_TESTS!=='1',timeout:120000}, async()=>{
  const output=path.resolve('.deploy-artifacts/workflow-reconciliation-browser');
  await fs.mkdir(output,{recursive:true});
  const record={id:'fixture-run',payload:{definition:{name:'工作流恢复回归',category:{categoryName:'汽车配件'},nodes:[
    {id:'main',type:'image',inputs:[],label:'主图',role:'main',ratio:'3:4'},
    {id:'detail_1',type:'image',inputs:['main'],label:'材质详情',role:'detail',ratio:'3:4'},
    {id:'detail_4',type:'image',inputs:['main'],label:'对应车型使用场景',role:'detail',ratio:'3:4'}
  ]},variants:[{id:'variant-one',label:'商品 A',values:{}}],outputs:{'variant-one':{
    main:{status:'done',approved:true,taskId:'original-main-task',url:'/media/main.png'},
    detail_1:{status:'done',approved:true,taskId:'original-detail-task',url:'/media/detail.png'},
    detail_4:{status:'unknown',approved:false,taskId:'original-recovery-task',submissionKey:'original-submit-key',phase:null,progressMessage:null,error:'原任务缺少供应商回执，请联系平台管理员核对结果和积分，处理后恢复原任务。'}
  }}}};
  const entry=`import{createApp,h,ref}from'vue';import{createRouter,createWebHashHistory}from'vue-router';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import Review from'/frontend/admin/components/listing/WorkflowRunReview.vue';import Records from'/frontend/admin/views/listing/AiGenerationRecordsView.vue';import{apiClient,setAuthToken}from'/frontend/admin/utils/api.js';
  setAuthToken('fixture-only');const record=ref(${JSON.stringify(record)}),job=ref({status:'awaiting_review',error_message:record.value.payload.outputs['variant-one'].detail_4.error}),busy=ref(false);window.__recovery={record,job,busy};
  const app=createApp({setup(){const onAction=async action=>{busy.value=true;try{record.value=await apiClient.post('/api/product-workflows/run-action',action);}finally{busy.value=false;}};return()=>new URLSearchParams(location.search).has('records')?h(Records):h('main',{style:'padding:24px'},h(Review,{record:record.value,job:job.value,busy:busy.value,onAction}));}});app.use(ElementPlus);app.use(createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:{render:()=>null}}]}));app.mount('#app');`;
  const bundle=await build({configFile:false,root:process.cwd(),publicDir:false,logLevel:'error',plugins:[vue(),{
    name:'workflow-reconciliation-fixture',resolveId(id){if(id==='virtual:workflow-reconciliation')return '\0workflow-reconciliation';},load(id){if(id==='\0workflow-reconciliation')return entry;}
  }],build:{write:false,cssCodeSplit:false,rollupOptions:{input:'virtual:workflow-reconciliation',output:{entryFileNames:'entry.js'}}}});
  const assets=new Map(bundle.output.map(item=>[item.fileName,item.type==='asset'?item.source:item.code]));
  const css=[...assets.keys()].find(name=>name.endsWith('.css'));
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium'),headless:true});
  const errors=[],unexpected=[],writes=[],checks=[];
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!=='http://localhost:8788'){unexpected.push(request.url());return route.abort();}
      if(url.pathname==='/admin.html')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/${css}"><style>*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}</style></head><body style="margin:0"><div id="app"></div><script type="module" src="/entry.js"></script></body></html>`});
      if(url.pathname==='/api/product-workflows/run-action'&&request.method()==='POST'){
        const action=request.postDataJSON();writes.push(action);
        const next=structuredClone(record);next.payload.outputs['variant-one'].detail_4.status='resubmit';
        return route.fulfill({json:next});
      }
      if(url.pathname==='/api/ai-generation/tasks')return route.fulfill({json:[{taskId:'original-recovery-task',fieldKey:'mainImage',sourceModule:'product_workflow',sourceProductId:'对应车型使用场景',status:'reconciliation_required',createdAt:'2026-11-20T06:15:17Z',error:{code:'AI_CREDIT_RECONCILIATION_REQUIRED',message:record.payload.outputs['variant-one'].detail_4.error}}]});
      if(url.pathname.startsWith('/api/')){
        if(request.method()!=='GET')unexpected.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({json:[]});
      }
      if(url.pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="${url.pathname.includes('main')?'#cbb9db':'#aec5dc'}"/><text x="150" y="210" text-anchor="middle" fill="#283544" font-size="24">${url.pathname.includes('main')?'MAIN':'DETAIL'}</text></svg>`});
      const body=assets.get(url.pathname.slice(1));
      if(body!==undefined)return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body});
      unexpected.push(request.url());return route.abort();
    });
    await page.goto('http://localhost:8788/admin.html#/product-workflows');
    const failedCard=page.locator('.review-grid article').filter({has:page.getByRole('heading',{name:'对应车型使用场景',exact:true})});
    await failedCard.getByText('待核对',{exact:true}).waitFor();
    assert.equal(await page.getByText('原任务恢复中',{exact:true}).count(),0);
    assert.equal(await page.getByText('正在查询原任务结果，不重复提交',{exact:true}).count(),0);
    assert.equal(await page.getByText('已生成的内容会保留，请处理以下节点后继续。',{exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'继续执行',exact:true}).count(),0);
    const snapshot=()=>page.evaluate(()=>JSON.parse(JSON.stringify(window.__recovery.record.value)));
    const before=await snapshot();
    const retained=before.payload.outputs['variant-one'];
    assert.equal(await page.locator('.review-grid article .el-image img').count(),2);
    await page.screenshot({path:path.join(output,'workflow-awaiting-reconciliation.png'),fullPage:true});
    const recover=page.locator('.task-recovery').getByRole('button',{name:'核对并恢复原任务',exact:true});
    assert.equal(await recover.isEnabled(),true);
    await recover.click();
    await page.waitForFunction(()=>!window.__recovery.busy.value&&window.__recovery.record.value.payload.outputs['variant-one'].detail_4.status==='resubmit');
    assert.deepEqual(writes,[{id:'fixture-run',action:'retry',nodeId:'detail_4',variantId:'variant-one'}]);
    const after=(await snapshot()).payload.outputs['variant-one'];
    assert.deepEqual(after.main,retained.main);assert.deepEqual(after.detail_1,retained.detail_1);
    assert.equal(after.detail_4.taskId,retained.detail_4.taskId);assert.equal(after.detail_4.submissionKey,retained.detail_4.submissionKey);
    checks.push({case:'pending-review-exposes-original-node-retry-and-retains-completed-images',pass:true});
    await page.goto('http://localhost:8788/admin.html?records=1#/ai-generation-records');
    const row=page.locator('.el-table__body tr').filter({hasText:'对应车型使用场景'});
    await row.getByText('待人工核对',{exact:true}).waitFor();
    assert.equal(await page.getByText('reconciliation_required',{exact:true}).count(),0);
    await page.screenshot({path:path.join(output,'generation-record-reconciliation.png'),fullPage:true});
    await row.getByRole('button',{name:'查看结果',exact:true}).click();
    await page.locator('.el-drawer').getByText(record.payload.outputs['variant-one'].detail_4.error,{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'generation-record-reconciliation-detail.png'),fullPage:true});
    checks.push({case:'records-show-readable-paused-state-and-original-recovery-error',pass:true});
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({allPass:true,checks,writes,pageErrors:errors,unexpected},null,2),'utf8');
    console.log(JSON.stringify({allPass:true,checks:checks.length,artifacts:output}));
  }catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks,writes,pageErrors:errors,unexpected},null,2),'utf8');throw error;}
  finally{await browser.close();}
});

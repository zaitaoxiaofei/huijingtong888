import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowNode} from '../src/shared/product-workflow.js';
import {workflowIncompleteNodes} from '../src/shared/workflow-completion.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_partial_fixture';process.env.DB_USER||='offline_fixture';
const {productWorkflowAction}=await import('../src/services/product-workflow-runner.js');
const {createProductWorkflowStore,importProductWorkflowDraft}=await import('../src/services/product-workflows.js');
const actor={personId:7,roles:['operations'],tenant:{id:2,slug:'fixture-enterprise',role:'member'}};

function runFixture({busy=0}={}){
  const image=(id,label,inputs=['cover_review'])=>({...createWorkflowNode('image',id),label,inputs});
  const definition={schemaVersion:1,name:'通用挂件生产',globalPrompt:'使用当前商品资料',nodes:[
    {...createWorkflowNode('listing','catalog'),templateId:23},
    {...createWorkflowNode('images','owned_photos'),label:'产品图片',count:1,slots:['产品正面']},
    {...image('cover','封面',['owned_photos']),role:'main'},
    {...createWorkflowNode('approval','cover_review'),label:'确认封面',inputs:['cover']},
    image('failed_scene','失败场景'),image('unknown_scene','待核对场景'),image('queued_scene','排队场景'),image('blocked_scene','未开始场景'),
    {...createWorkflowNode('copy','words'),label:'商品文案',inputs:[]},
    {...createWorkflowNode('video','clip'),label:'视频',inputs:['cover']}
  ]};
  const variants=[{id:'product_a',label:'挂件 A',values:{owned_photos:['https://fixture.invalid/product.png']}}];
  let payload={definition,variants,executionMode:'background',outputs:{product_a:{
    cover:{status:'done',taskId:'original-cover',url:'https://fixture.invalid/cover.png',approved:false},
    failed_scene:{status:'failed',taskId:'original-failed',submissionKey:'saved-intent',error:'供应商失败'},
    unknown_scene:{status:'unknown',taskId:'original-unknown',error:'结果待核对'},
    queued_scene:{status:'running',taskId:'original-queued',phase:'queued'},
    words:{status:'done',text:{title:'Подвеска',description:'Описание подвески',tags:['#подвеска']},approved:false}
  }}},revision=4,jobStatus='failed';
  const writes=[];let starts=0,creates=0,body;
  const write=async(sql,params)=>{
    writes.push({sql,params});
    if(sql.startsWith('UPDATE product_workflow_documents')){payload=JSON.parse(params[0]);revision++;}
    if(sql.startsWith('INSERT INTO product_workflow_jobs'))jobStatus=params[3];
    return {affectedRows:1};
  };
  const connection={execute:async(sql,params)=>{
    if(sql.startsWith('SELECT'))assert.equal(params[0],'2','every import/action SQL read stays enterprise scoped');
    if(sql.startsWith('SELECT *,'))return [[{status:jobStatus,busy}]];
    if(sql.startsWith('SELECT * FROM product_workflow_documents'))return [[{payload_json:JSON.stringify(payload),revision}]];
    if(sql.startsWith('SELECT id FROM listing_drafts'))return [[{id:42}]];
    return [await write(sql,params)];
  }};
  const deps={store:{scope:async()=>({tenant:'2',actor}),get:async()=>({id:'fixture-run',payload,revision})},transaction:async operation=>operation(connection),ensureJobs:async()=>{},startRunner:async()=>{starts++;},tasks:async()=>{throw Error('final review must not submit, retry or poll AI');},execute:write};
  const services={listingCategoryTemplateDetail:async()=>({id:23,description_category_id:100,type_id:200,editable_payload:{images:['https://fixture.invalid/stale-template.png'],variants:[{images:['https://fixture.invalid/stale-template.png']}]}}),createListingDraft:async value=>{assert.equal(payload.draftImportStatus,'unknown');creates++;body=value;return {id:42};}};
  const confirmation=()=>({id:'fixture-run',action:'approve-all',ignoreIncomplete:true,incompleteNodes:workflowIncompleteNodes(payload).map(({variantId,nodeId,taskId})=>({variantId,nodeId,taskId}))});
  return {deps,services,writes,confirmation,get payload(){return payload;},get revision(){return revision;},get starts(){return starts;},get creates(){return creates;},get body(){return body;},get jobStatus(){return jobStatus;}};
}

test('partial final approval requires consent to the exact current omitted node identities',async()=>{
  const normal=runFixture();await assert.rejects(productWorkflowAction({id:'fixture-run',action:'approve-all'},actor,normal.deps),/尚未生成完成/);assert.equal(normal.writes.length,0);
  for(const change of [body=>{body.ignoreIncomplete='true';},body=>{delete body.incompleteNodes;},body=>{body.incompleteNodes.pop();},body=>{body.incompleteNodes[0].taskId='new-task';},body=>{body.incompleteNodes[0].variantId='foreign-product';},body=>{body.incompleteNodes[0].nodeId='unknown-node';},body=>{body.incompleteNodes.push(body.incompleteNodes[0]);}]){
    const f=runFixture(),body=f.confirmation();change(body);
    await assert.rejects(productWorkflowAction(body,actor,f.deps));assert.equal(f.writes.length,0);assert.equal(f.starts,0);
  }
});

test('a general workflow final review ignores failed, uncertain, queued and blocked outputs while retaining originals',async()=>{
  const f=runFixture(),before=structuredClone(f.payload.outputs.product_a);
  const request=f.confirmation();request.incompleteNodes.reverse();
  request.incompleteNodes.forEach(item=>{item.reason='untrusted reason';item.nodeLabel='untrusted label';});
  const record=await productWorkflowAction(request,actor,f.deps),results=record.payload.outputs.product_a;
  assert.equal(f.jobStatus,'ready');assert.equal(f.starts,1);
  assert.deepEqual(results.cover,{...before.cover,approved:true});assert.deepEqual(results.words,{...before.words,approved:true});
  for(const id of ['failed_scene','unknown_scene','queued_scene'])assert.deepEqual(results[id],{...before[id],completionIgnored:true,approved:false});
  for(const id of ['blocked_scene','clip'])assert.deepEqual(results[id],{completionIgnored:true,approved:false});
  assert.deepEqual(results.cover_review,{approved:true,approvalMode:'final_review'});
  const review=record.payload.completionReview;
  assert.equal(review.mode,'partial');assert.equal(review.confirmedBy,actor.personId);assert.ok(Number.isFinite(Date.parse(review.confirmedAt)));
  assert.equal(review.ignoredNodes.length,5);assert.ok(review.ignoredNodes.every(item=>item.reason!=='untrusted reason'&&item.nodeLabel!=='untrusted label'));
});

test('partial completion is idempotent and cannot be reopened through start, retry or content actions',async()=>{
  const f=runFixture();await productWorkflowAction(f.confirmation(),actor,f.deps);
  const saved=structuredClone(f.payload),writes=f.writes.length,starts=f.starts;
  await productWorkflowAction({id:'fixture-run',action:'approve-all'},actor,f.deps);
  assert.deepEqual(f.payload,saved);assert.equal(f.writes.length,writes);assert.equal(f.starts,starts);
  for(const action of ['start','retry','save-copy','approve'])await assert.rejects(productWorkflowAction({id:'fixture-run',action,variantId:'product_a',nodeId:'failed_scene'},actor,f.deps),{status:409});
  assert.deepEqual(f.payload,saved);assert.equal(f.writes.length,writes);
  await productWorkflowAction({id:'fixture-run',action:'archive',revision:f.revision},actor,f.deps);
  assert.equal(f.payload.archived,true);assert.deepEqual(f.payload.completionReview,saved.completionReview);
});

test('a held workflow lease still blocks partial final approval before any write',async()=>{
  const f=runFixture({busy:1});await assert.rejects(productWorkflowAction(f.confirmation(),actor,f.deps),{status:409});assert.equal(f.writes.length,0);
});

test('normal final approval remains available without any omission marker and confirms approval nodes',async()=>{
  const f=runFixture(),results=f.payload.outputs.product_a;
  for(const node of f.payload.definition.nodes){
    if(node.type==='image')results[node.id]={status:'done',url:`https://fixture.invalid/${node.id}.png`,approved:false};
    if(node.type==='video')results[node.id]={status:'done',url:'https://fixture.invalid/clip.mp4',approved:false};
  }
  await productWorkflowAction({id:'fixture-run',action:'approve-all'},actor,f.deps);
  assert.equal(f.jobStatus,'ready');assert.equal(f.payload.completionReview,undefined);
  assert.ok(Object.values(f.payload.outputs.product_a).every(state=>state.approved===true&&!state.completionIgnored));
  assert.equal(f.payload.outputs.product_a.cover_review.approvalMode,'final_review');
});

test('clients cannot forge completion review or ignored-result flags through run persistence',async()=>{
  let writes=0;
  const store=createProductWorkflowStore({loadCatalog:null,authorize:async()=>actor,ensureSchema:async()=>{},query:async()=>[],execute:async()=>{writes++;return {affectedRows:1};}});
  for(const forge of [payload=>{payload.completionReview={mode:'partial'};},payload=>{payload.outputs.product_a.failed_scene.completionIgnored=true;}]){
    const f=runFixture();forge(f.payload);
    await assert.rejects(store.save('run',{payload:f.payload},actor),/服务端确认/);
    await assert.rejects(store.save('run',{id:'existing',revision:1,payload:f.payload},actor),/服务端确认/);
  }
  assert.equal(writes,0);
  const f=runFixture();await productWorkflowAction(f.confirmation(),actor,f.deps);
  const previous=structuredClone(f.payload),stripped=structuredClone(previous);delete stripped.completionReview;
  for(const state of Object.values(stripped.outputs.product_a))delete state.completionIgnored;
  const legacyStore=createProductWorkflowStore({loadCatalog:null,authorize:async()=>actor,ensureSchema:async()=>{},query:async()=>[{id:'existing',kind:'run',revision:1,payload_json:JSON.stringify(previous)}],execute:async()=>{writes++;return {affectedRows:1};}});
  await assert.rejects(legacyStore.save('run',{id:'existing',revision:1,payload:stripped},actor),/现有结果完成/);assert.equal(writes,0);
});

test('partial output import saves retained images once and records the confirmed omissions in draft metadata',async()=>{
  const f=runFixture();await productWorkflowAction(f.confirmation(),actor,f.deps);
  assert.deepEqual(await importProductWorkflowDraft('fixture-run',actor,f.services,f.deps),{id:42});
  assert.deepEqual(await importProductWorkflowDraft('fixture-run',actor,f.services,f.deps),{id:42});assert.equal(f.creates,1);
  const rows=f.body.template_payload.editable_payload.variants;
  assert.deepEqual(rows[0].images.map(image=>image.url),['https://fixture.invalid/cover.png']);assert.deepEqual(rows[0].video_urls,[]);
  assert.equal(rows[0].title,'Подвеска');assert.equal(rows[0].description,'Описание подвески');
  assert.ok(!JSON.stringify(f.body).includes('stale-template.png'));
  assert.deepEqual(f.body.ai_payload.completion_review,f.payload.completionReview);
  assert.equal(f.body.ai_payload.workflow_run_id,'fixture-run');
});

test('partial import permits omitted copy with empty authoritative fields and preserves category-change protection',async()=>{
  const f=runFixture();f.payload.outputs.product_a.words={status:'failed',taskId:'copy-task',text:{title:'incomplete bundle'}};
  await productWorkflowAction(f.confirmation(),actor,f.deps);
  await importProductWorkflowDraft('fixture-run',actor,f.services,f.deps);
  const row=f.body.template_payload.editable_payload.variants[0];
  assert.equal(row.title,'');assert.equal(row.description,'');assert.deepEqual(row.tags,[]);
  const changed=runFixture();await productWorkflowAction(changed.confirmation(),actor,changed.deps);
  changed.payload.listingSnapshot={description_category_id:999,type_id:200};
  await assert.rejects(importProductWorkflowDraft('fixture-run',actor,changed.services,changed.deps),/分类已变化/);assert.equal(changed.creates,0);
});

test('multi-variant partial import keeps each products own successful media and omitted identities',async()=>{
  const f=runFixture(),second={id:'product_b',label:'挂件 B',values:{owned_photos:['https://fixture.invalid/product-b.png']}};
  f.payload.variants.push(second);
  f.payload.outputs.product_b={};
  for(const node of f.payload.definition.nodes){
    if(node.type==='image')f.payload.outputs.product_b[node.id]={status:'done',url:`https://fixture.invalid/product-b-${node.id}.png`,approved:false};
    if(node.type==='copy')f.payload.outputs.product_b[node.id]={status:'done',text:{title:'Подвеска B',description:'Описание B',tags:['#подвеска']},approved:false};
    if(node.type==='video')f.payload.outputs.product_b[node.id]={status:'done',url:'https://fixture.invalid/product-b.mp4',approved:false};
  }
  f.payload.outputs.product_b.unknown_scene={status:'unknown',taskId:'b-original-unknown'};
  await productWorkflowAction(f.confirmation(),actor,f.deps);
  assert.ok(f.payload.completionReview.ignoredNodes.some(item=>item.variantId==='product_b'&&item.nodeId==='unknown_scene'&&item.taskId==='b-original-unknown'));
  await importProductWorkflowDraft('fixture-run',actor,f.services,f.deps);
  const rows=f.body.template_payload.editable_payload.variants;
  assert.equal(rows.length,2);assert.deepEqual(rows[0].images.map(image=>image.url),['https://fixture.invalid/cover.png']);
  assert.ok(rows[1].images.every(image=>image.url.includes('product-b-')));assert.ok(rows[1].images.every(image=>!image.url.includes('unknown_scene')));
  assert.equal(rows[1].title,'Подвеска B');assert.deepEqual(rows[1].video_urls,['https://fixture.invalid/product-b.mp4']);
});

test('an interrupted partial import reconciles the existing enterprise draft without creating it again',async()=>{
  const f=runFixture();await productWorkflowAction(f.confirmation(),actor,f.deps);
  const create=f.services.createListingDraft;
  f.services.createListingDraft=async body=>{await create(body);throw Error('fixture: draft response lost');};
  await assert.rejects(importProductWorkflowDraft('fixture-run',actor,f.services,f.deps),/response lost/);
  assert.equal(f.payload.draftImportStatus,'unknown');assert.equal(f.creates,1);
  f.services.createListingDraft=create;
  assert.deepEqual(await importProductWorkflowDraft('fixture-run',actor,f.services,f.deps),{id:42});
  assert.equal(f.creates,1);assert.equal(f.payload.draftImportStatus,'done');assert.equal(f.payload.completionReview.mode,'partial');
});

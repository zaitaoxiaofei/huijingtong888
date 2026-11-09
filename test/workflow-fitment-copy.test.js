import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkflowCopy,normalizeWorkflowTags,WORKFLOW_COPY_RULES} from '../src/shared/workflow-copy-rules.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_unit_test';process.env.DB_USER||='workflow_unit_test';
const {generateProductWorkflowText}=await import('../src/services/product-workflow-text.js');
import {keyCaseProductionWorkflow} from '../src/shared/key-case-production-workflow.js';
import {prepareProductWorkflowRun} from '../src/services/product-workflow-category.js';
import {advanceProductWorkflow,workflowGenerationInput} from '../src/services/product-workflow-execution.js';
import {buildWorkflowDraft} from '../src/shared/product-workflow.js';
const fits=[{brand:'Mercedes-Benz',model:'GLC'},{brand:'Mercedes-Benz',model:'GLE'}];
const category={templateId:7,descriptionCategoryId:100,typeId:200,attributes:[]};
const services={listingCategoryTemplateDetail:async()=>({id:7,description_category_id:100,type_id:200}),listingOzonCategoryAttributes:async()=>[]};
const mold=(id='m')=>({id,kind:'material',revision:1,payload:{name:'三键模具',role:'compatibility',images:['https://example.test/mold.png'],bindings:[{brand:'Mercedes-Benz',models:['GLC','GLE']}],listingCategory:{key:'100:200',name:'钥匙壳'}}});
function input(key=[]){const definition=keyCaseProductionWorkflow(category);definition.nodes.find(n=>n.id==='style').required=false;return {definition,sharedValues:{model:'Mercedes-Benz GLC；Mercedes-Benz GLE',facts:'金色包边，礼盒',key},variants:[{id:'one',label:'产品1',fitments:fits,values:{product:['https://example.test/product.png']}}]};}
test('tags normalize Russian phrases without cutting words and reject overlong or empty tags',()=>{
 assert.deepEqual(normalizeWorkflowTags(['Для женщин','#Для_женщин','подарок-водителю']),['#Для_женщин','#подарок_водителю']);
 assert.throws(()=>normalizeWorkflowTags(['x'.repeat(25)]),/25/);assert.throws(()=>normalizeWorkflowTags(['!!!']),/25/);
 assert.equal(normalizeWorkflowTags(['x'.repeat(24)])[0].length,25);
});
test('title and description must retain confirmed fitments, generic text remains free',()=>{
 assert.throws(()=>validateWorkflowCopy('title','Чехол для ключа с цветами',fits),/GLC/);
 assert.equal(validateWorkflowCopy('title','Чехол для ключа Mercedes-Benz GLC, GLE',fits),'Чехол для ключа Mercedes-Benz GLC, GLE');
 assert.equal(validateWorkflowCopy('text','anything',fits),'anything');
});
test('text generator applies default rules, repairs missing models once and never silently accepts invalid copy',async()=>{
 const calls=[];const result=await generateProductWorkflowText({workflowOutput:'title',sourceContext:{workflowFitments:fits}},async request=>{calls.push(JSON.parse(request.messages[1].content));return {content:JSON.stringify({value:calls.length===1?'Чехол с цветами':'Чехол для ключа Mercedes-Benz GLC GLE'})};});
 assert.equal(calls.length,2);assert.equal(calls[0].rules[0],WORKFLOW_COPY_RULES.title);assert.match(calls[1].rules.at(-1),/GLC/);assert.match(result.title,/GLC/);
 await assert.rejects(generateProductWorkflowText({workflowOutput:'tags'},async()=>({content:JSON.stringify({value:['too_long_'.repeat(10)]})})),/25/);
});
test('manual key wins; unique owned matching mold resolves automatically; multiple molds require choice',async()=>{
 let listCalls=0;const store={list:async kind=>{listCalls++;return kind==='material'?[mold()]:[];},get:async()=>mold()};
 const manual=await prepareProductWorkflowRun(input(['https://example.test/manual.png']),{},services,store);assert.equal(listCalls,0);assert.deepEqual(manual.variants[0].values.key,['https://example.test/manual.png']);
 const matched=await prepareProductWorkflowRun(input(),{},services,store);assert.equal(matched.variants[0].keyModelId,'m');assert.deepEqual(matched.variants[0].values.key,mold().payload.images);
 await assert.rejects(prepareProductWorkflowRun(input(),{},services,{list:async k=>k==='material'?[mold(),mold('m2')]:[]}),/多份/);
 const wrong=mold();wrong.payload.listingCategory.key='100:999';const no=await prepareProductWorkflowRun(input(),{},services,{list:async()=>[wrong]});assert.ok(!no.variants[0].values.key.some(Boolean));
});
test('no mold skips comparison without AI expense, removes its binding and still finishes a draft',async()=>{
 const payload=await prepareProductWorkflowRun(input(),{},services,{list:async()=>[]});payload.definition.reviewMode='automatic';const requests=[],tasks=new Map();
 const deps={guard:async()=>{},commit:async()=>{},findTask:async id=>tasks.get(id),retryTask:async()=>{},createTask:async body=>{requests.push(body);tasks.set(body.taskId,{status:'done',output:body.fieldKey==='mainImage'?{url:'https://example.test/'+body.taskId+'.png'}:{title:'Чехол Mercedes-Benz GLC GLE',tags:['#для_женщин'],description:'Чехол для ключа Mercedes-Benz GLC GLE'}});}};
 let state;for(let i=0;i<100;i++){state=await advanceProductWorkflow({id:'run',payload},deps);if(state.status==='ready')break;}
 assert.equal(state.status,'ready');assert.equal(payload.outputs.one.detail_1.status,'skipped');assert.equal(requests.filter(r=>r.fieldKey==='mainImage').length,5);
 const main=payload.definition.nodes.find(n=>n.id==='main');assert.match(workflowGenerationInput(payload.definition,payload.variants[0],main,{}).finalPrompt,/不展示裸钥匙/);
 const draft=buildWorkflowDraft(payload.definition,payload.variants,payload.outputs,{},'test-run');assert.equal(draft.template_payload.editable_payload.variants[0].images.length,5);
 const description=requests.find(r=>r.input.workflowOutput==='description');assert.ok(Object.values(description.input.sourceContext.workflowFacts).some(value=>value?.title));
});

test('library search pages both legacy molds and new materials beyond 500 records, scoped to tenant',async()=>{
 const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');
 const docs=Array.from({length:530},(_,i)=>({tenant:'1',id:`m${i}`,kind:i%2?'material':'key_model',name:i===529?'奔驰钥匙模具':'包装 '+i,revision:1,payload_json:JSON.stringify({images:[],bindings:[]})}));docs.push({tenant:'2',id:'other',kind:'material',name:'奔驰钥匙模具',revision:1,payload_json:'{}'});
 const calls=[];const store=createProductWorkflowStore({authorize:async s=>s,execute:async()=>({}),query:async(sql,p)=>{calls.push({sql,p});const rows=docs.filter(d=>d.tenant===p[0]&&d.name.includes(p[1].slice(1,-1)));if(sql.includes('COUNT(*)'))return [{total:rows.length}];return rows.slice(p.at(-1),p.at(-1)+p.at(-2));}});
 const a={personId:1,roles:['operations'],tenant:{id:1,slug:'one',role:'member'}},b={personId:2,roles:['operations'],tenant:{id:2,slug:'two',role:'member'}};
 const page=await store.list('library',a,{page:2,pageSize:12});assert.equal(page.total,530);assert.equal(page.items.length,12);assert.equal(page.items[0].id,'m12');
 const found=await store.list('library',a,{keyword:'奔驰',page:1});assert.equal(found.items[0].id,'m529');assert.equal(found.total,1);
 const other=await store.list('library',b,{keyword:'奔驰'});assert.equal(other.items[0].id,'other');
 await store.list('library',a,{keyword:"' OR 1=1",brand:'Mercedes-Benz',model:'GLC',category:'100:200',role:'compatibility'});assert.ok(!calls.at(-1).sql.includes("' OR 1=1"));assert.ok(calls.at(-1).sql.includes('JSON_CONTAINS'));assert.equal(calls.at(-1).p[0],'1');
 const {isTenantPilotRoute}=await import('../src/server/tenant-pilot-routes.js');assert.equal(isTenantPilotRoute('product-workflows/material-library','GET'),true);assert.equal(isTenantPilotRoute('product-workflows/material-library','POST'),false);
});

test('automatic matching searches owned documents without the legacy 500 cap and excludes partial or wrong categories',async()=>{
 const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');let last;
 const good=mold(),partial=mold('partial'),wrong=mold('wrong'),style=mold('style');partial.payload.bindings[0].models=['GLC'];wrong.payload.listingCategory.key='100:999';style.payload.role='style';
 const store=createProductWorkflowStore({authorize:async s=>s,execute:async()=>({}),query:async(sql,p)=>{last={sql,p};return [good,partial,wrong,style].map(r=>({id:r.id,kind:r.kind,name:r.payload.name,revision:1,payload_json:JSON.stringify(r.payload)}));}});
 const actor={personId:1,roles:['operations'],tenant:{id:1,slug:'one',role:'member'}};
 await assert.rejects(store.matchingKeys([null],category,actor),{status:400});
 const found=await store.matchingKeys(fits,category,actor);assert.deepEqual(found.map(r=>r.id),['m']);assert.equal(last.p[0],'1');assert.ok(!last.sql.includes('LIMIT 500'));assert.match(last.sql,/tenant_id = \?/);
});

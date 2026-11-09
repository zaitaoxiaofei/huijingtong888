import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflowMaterial,normalizeWorkflowKeyModel,matchingKeyModels } from '../src/shared/workflow-key-models.js';
import { materialMatches,materialCoversFitments,normalizeMaterialBindings } from '../src/shared/workflow-materials.js';
import { keyCaseWorkflow,validateWorkflow,validateWorkflowVariants,createWorkflowNode } from '../src/shared/product-workflow.js';
import { advanceProductWorkflow } from '../src/services/product-workflow-execution.js';
import { prepareProductWorkflowRun } from '../src/services/product-workflow-category.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_unit_test';process.env.DB_USER||='workflow_unit_test';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');
const category={key:'100:200',name:'钥匙保护套'};
const binding=[{brand:'TENET',models:['T4','T7']},{brand:'CHERY',models:['TIGGO 7']}];
const record={id:'material',kind:'material',revision:1,payload:normalizeWorkflowMaterial({name:'共用钥匙模具',role:'compatibility',images:['https://example.test/key.png'],notes:'按图核对按键',listingCategory:category,bindings:binding})};
test('material library keeps category and many brand/model bindings without duplicating images',()=>{
 assert.equal(record.payload.images.length,1);assert.equal(record.payload.bindings.length,2);
 assert.ok(materialMatches(record,{category:{descriptionCategoryId:100,typeId:200},fitments:[{brand:'TENET',model:'T7'}]}));
 assert.ok(materialMatches(record,{keyword:'chery'}));assert.ok(!materialMatches(record,{category:{key:'100:999'}}));assert.ok(!materialMatches(record,{fitments:[{brand:'TENET',model:'T8'}]}));
 assert.ok(materialCoversFitments(record,[{brand:'TENET',model:'T4'},{brand:'CHERY',model:'TIGGO 7'}]));assert.ok(!materialCoversFitments(record,[{brand:'TENET',model:'T8'}]));
 assert.equal(matchingKeyModels([record],'',[{brand:'TENET',model:'T7'},{brand:'TENET',model:'T4'}]).length,1);
 const general=normalizeWorkflowMaterial({name:'通用礼盒',notes:'黑色礼盒'});assert.equal(general.listingCategory,null);assert.deepEqual(general.bindings,[]);assert.ok(materialMatches(general,{category,fitments:[{brand:'TENET',model:'T8'}]}));
 assert.throws(()=>normalizeMaterialBindings([{brand:'TENET',models:[]}]),/勾选/);assert.throws(()=>normalizeWorkflowMaterial({name:'bad',notes:'x',listingCategory:{key:'fake',name:'fake'}}),/官方类目/);
 const legacy=normalizeWorkflowKeyModel({brand:'JETOUR',model:'Dashing',label:'四键',images:['https://example.test/key.png']});assert.equal(legacy.name,'JETOUR Dashing · 四键');
});
test('direct library image output freezes selected image and never creates an AI task',async()=>{
 const definition=keyCaseWorkflow();definition.nodes.find(n=>n.type==='listing').templateId=7;
 const main=definition.nodes.find(n=>n.id==='main');main.imageMode='material';main.prompt='';main.inputs=[];main.materialRefs=[{id:'material',kind:'material',revision:1,imageIndex:1}];definition.reviewMode='automatic';
 const payload={definition,variants:[{id:'one',label:'产品',values:Object.fromEntries(definition.nodes.filter(n=>['field','images'].includes(n.type)).map(n=>[n.id,n.type==='images'?['https://example.test/input.png']:'confirmed']))}],outputs:{}};
 const services={listingCategoryTemplateDetail:async()=>({id:7,description_category_id:100,type_id:200}),listingOzonCategoryAttributes:async()=>[]};
 const profile={...record,payload:{...record.payload,images:['https://example.test/a.png','https://example.test/ready.png']}};
 const run=await prepareProductWorkflowRun(payload,{},services,{get:async()=>structuredClone(profile)});
 profile.payload.images[1]='changed';let calls=0;
 await advanceProductWorkflow({id:'run',payload:run},{createTask:async()=>{calls++;},findTask:async()=>null,commit:async()=>{},guard:async()=>{}});
 assert.equal(calls,0);assert.equal(run.outputs.one.main.url,'https://example.test/ready.png');assert.equal(run.outputs.one.main.source,'material');assert.equal(run.outputs.one.main.approved,true);
 const stale=structuredClone(payload);stale.definition.nodes.find(n=>n.id==='main').materialRefs[0].imageIndex=7;await assert.rejects(prepareProductWorkflowRun(stale,{},services,{get:async()=>profile}),/所选图片/);
});
test('number input format rejects non numeric material values and retains decimals',()=>{
 const definition=keyCaseWorkflow();definition.nodes.splice(1,0,{...createWorkflowNode('field','pack_width'),inputFormat:'number',label:'包装宽',required:false});validateWorkflow(definition);
 const values=Object.fromEntries(definition.nodes.filter(n=>['field','images'].includes(n.type)).map(n=>[n.id,n.type==='images'?['https://example.test/a.png']:'confirmed']));values.pack_width=1.25;
 assert.equal(validateWorkflowVariants(definition,[{id:'one',label:'产品',values}])[0].values.pack_width,1.25);values.pack_width='abc';assert.throws(()=>validateWorkflowVariants(definition,[{id:'one',label:'产品',values}]),/包装宽.*数字/);
});
test('historical selling points stay scoped to the current enterprise and are deduplicated',async()=>{
 const tenants=[];const store=createProductWorkflowStore({loadCatalog:null,authorize:async s=>s,execute:async()=>({}),query:async(sql,p)=>{tenants.push(p[0]);return p[0]==='1'?[{id:'r1',name:'历史流程',variants_json:JSON.stringify([{id:'v1',label:'黑色',values:{facts:'已确认卖点'}},{id:'v2',values:{facts:'已确认卖点'}}])}]:[];}});
 const a={personId:1,roles:['operations'],tenant:{id:1,slug:'a',role:'member'}},b={personId:2,roles:['operations'],tenant:{id:2,slug:'b',role:'member'}};
 assert.equal((await store.factsHistory(a)).length,1);assert.equal((await store.factsHistory(b)).length,0);assert.deepEqual(tenants,['1','2']);
});

test('fixed image input imports an owned material image and ignores replacement production values',async()=>{
 const definition=keyCaseWorkflow();definition.nodes.find(n=>n.type==='listing').templateId=7;
 const product=definition.nodes.find(n=>n.id==='product');Object.assign(product,{valueSource:'engineer',materialRefs:[{id:'material',revision:1,imageIndex:0}],defaultValue:['']});
 const values=Object.fromEntries(definition.nodes.filter(n=>['field','images'].includes(n.type)).map(n=>[n.id,n.type==='images'?['https://example.test/untrusted.png']:'confirmed']));
 const services={listingCategoryTemplateDetail:async()=>({id:7,description_category_id:100,type_id:200}),listingOzonCategoryAttributes:async()=>[]};
 const run=await prepareProductWorkflowRun({definition,variants:[{id:'one',label:'产品',values}],outputs:{}},{},services,{get:async()=>structuredClone(record)});
 assert.deepEqual(run.variants[0].values.product,['https://example.test/key.png']);
});

test('template search covers records beyond the old first hundred and pagination stays tenant scoped',async()=>{
 const templates=Array.from({length:125},(_,i)=>({tenant:'1',id:`t${i+1}`,kind:'template',name:`Template ${i+1}`,revision:1,payload_json:JSON.stringify({category:{categoryName:i===124?'独有钥匙类目':'钥匙壳'},...(i===0?{previewImage:'https://example.test/cached.png'}:{})})}));
 templates.push({tenant:'2',id:'foreign',name:'Foreign only',kind:'template',revision:1,payload_json:'{}'});
 const previous={templateId:'t13',draftId:10,definition:{nodes:[{id:'custom_main',type:'image',role:'main'}]},variants:[{id:'black'}],outputs:{black:{custom_main:{url:'https://example.test/actual.png'}}}};
 const scopes=[];const store=createProductWorkflowStore({loadCatalog:null,authorize:async s=>s,execute:async()=>({}),query:async(sql,p)=>{scopes.push(p[0]);if(sql.includes("kind = 'run'"))return p[0]==='1'&&p.includes('t13')?[{payload_json:JSON.stringify(previous)}]:[];const needle=p[2].slice(1,-1).toLowerCase();const rows=templates.filter(r=>r.tenant===p[0]&&(r.name.toLowerCase().includes(needle)||JSON.parse(r.payload_json).category?.categoryName.includes(needle)));if(sql.includes('COUNT(*)'))return [{total:rows.length}];return rows.slice(p[5],p[5]+p[4]);}});
 const session={personId:1,roles:['operations'],tenant:{id:1,slug:'a',role:'member'}};
 const first=await store.list('template',session,{page:1,pageSize:12});assert.equal(first.total,125);assert.equal(first.items.length,12);assert.equal(first.items[0].preview_image,'https://example.test/cached.png');
 const second=await store.list('template',session,{page:2,pageSize:12});assert.equal(second.items[0].id,'t13');assert.equal(second.items[0].preview_image,'https://example.test/actual.png');
 const distant=await store.list('template',session,{page:999,pageSize:12});assert.equal(distant.page,11);assert.equal(distant.items.length,5);
 const search=await store.list('template',session,{page:1,pageSize:12,keyword:'独有钥匙类目'});assert.equal(search.total,1);assert.equal(search.items[0].id,'t125');
 const foreign=await store.list('template',session,{page:1,keyword:'Foreign only'});assert.equal(foreign.total,0);assert.ok(scopes.every(tenant=>tenant==='1'));
});

import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeWorkflowKeyModel,matchingKeyModels,applyKeyModel} from '../src/shared/workflow-key-models.js';
process.env.DB_HOST ||= '127.0.0.1';process.env.DB_NAME ||= 'workflow_unit_test';process.env.DB_USER ||= 'workflow_unit_test';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');
import {prepareProductWorkflowRun} from '../src/services/product-workflow-category.js';
import {keyCaseWorkflow} from '../src/shared/product-workflow.js';
import {isWorkflowInput} from '../src/shared/product-workflow-inputs.js';
const profile={brand:'JETOUR',model:'DASHING',label:'四键菱形',images:['https://example.test/key.png'],notes:'核对按键'};
const session=id=>({personId:id,roles:['operations'],tenant:{id,slug:`tenant-${id}`,role:'member'}});
function fixture(){const rows=[];return createProductWorkflowStore({authorize:async s=>s,query:async(sql,p)=>rows.filter(r=>r.tenant_id===p[0]&&r.kind===p[1]&&(sql.includes('LIKE')?r.name.toLowerCase().includes(p[2].slice(1,-1).toLowerCase()):r.id===p[2])),execute:async(sql,p)=>{if(sql.startsWith('CREATE'))return{};if(sql.startsWith('INSERT')){const [id,tenant_id,kind,name,payload_json,created_by]=p;rows.push({id,tenant_id,kind,name,payload_json,created_by,revision:1});return{affectedRows:1};}const [name,payload_json,tenant,kind,id,revision]=p,r=rows.find(r=>r.tenant_id===tenant&&r.kind===kind&&r.id===id&&r.revision===revision);if(!r)return{affectedRows:0};Object.assign(r,{name,payload_json,revision:revision+1});return{affectedRows:1};}});}
test('key images must be uploaded and ambiguous key types remain separate',()=>{
 assert.throws(()=>normalizeWorkflowKeyModel({...profile,images:['data:image/png;base64,x']}),/上传/);
 assert.throws(()=>normalizeWorkflowKeyModel({...profile,brand:''}),/品牌/);
 const one={id:'one',revision:1,payload:normalizeWorkflowKeyModel(profile)},two={id:'two',revision:1,payload:normalizeWorkflowKeyModel({...profile,label:'另一钥匙'})};
 assert.equal(matchingKeyModels([one,two],'jetour dashing').length,2);assert.equal(matchingKeyModels([one],'JETOUR T2').length,0);
 const values={};applyKeyModel(values,one);one.payload.images[0]='changed';assert.equal(values.key[0],profile.images[0]);
});
test('enterprise key library isolates reads and writes, rejects stale edits and supports archiving',async()=>{
 const store=fixture(),a=session(1),b=session(2),saved=await store.save('key_model',{payload:profile},a);
 assert.equal((await store.list('key_model',a,{model:'JETOUR DASHING'})).length,1);assert.equal((await store.list('key_model',b)).length,0);
 await assert.rejects(store.get('key_model',saved.id,b),{status:404});await assert.rejects(store.save('key_model',{id:saved.id,revision:1,payload:profile},b),{status:404});
 const archived=await store.save('key_model',{id:saved.id,revision:1,payload:{...profile,archived:true}},a);assert.equal(archived.revision,2);
 await assert.rejects(store.save('key_model',{id:saved.id,revision:1,payload:profile},a),{status:409});assert.equal((await store.list('key_model',a)).length,0);
});
test('run submission resolves only owned matching key profiles and freezes their images',async()=>{
 const store=fixture(),a=session(1),saved=await store.save('key_model',{payload:profile},a),definition=keyCaseWorkflow();definition.nodes.find(n=>n.type==='listing').templateId=7;
 const values=Object.fromEntries(definition.nodes.filter(isWorkflowInput).map(n=>[n.id,n.type==='images'?['https://example.test/product.png']:'Confirmed']));values.model='JETOUR DASHING';
 const payload={definition,variants:[{id:'one',label:'产品1',values,keyModelId:saved.id,keyModelRevision:1}],outputs:{}};
 const services={listingCategoryTemplateDetail:async()=>({id:7,description_category_id:100,type_id:200}),listingOzonCategoryAttributes:async()=>[]};
 const run=await prepareProductWorkflowRun(structuredClone(payload),a,services,store);assert.deepEqual(run.variants[0].values.key,profile.images);assert.equal(run.variants[0].keyModelRevision,1);
 await assert.rejects(prepareProductWorkflowRun(structuredClone(payload),session(2),services,store),{status:404});
 const wrong=structuredClone(payload);wrong.variants[0].values.model='JETOUR T2';await assert.rejects(prepareProductWorkflowRun(wrong,a,services,store),/不一致/);
 await store.save('key_model',{id:saved.id,revision:1,payload:{...profile,images:['https://example.test/new.png']}},a);assert.deepEqual(run.variants[0].values.key,profile.images);
 await assert.rejects(prepareProductWorkflowRun(structuredClone(payload),a,services,store),/已更新/);
});

test('general enterprise materials allow text references and isolate revisions and tenant access',async()=>{
 const {normalizeWorkflowMaterial}=await import('../src/shared/workflow-key-models.js');
 assert.throws(()=>normalizeWorkflowMaterial({name:'empty'}),/图片或填写/);
 assert.throws(()=>normalizeWorkflowMaterial({name:'local',images:['file:///tmp/x.png']}),/HTTPS/);
 const store=fixture(),a=session(1),b=session(2),payload={name:'黑色礼盒',brand:'JETOUR',model:'Dashing',category:'包装',notes:'已确认礼盒',images:[]};
 const saved=await store.save('material',{payload},a);assert.equal((await store.list('material',a)).length,1);assert.equal((await store.list('material',b)).length,0);
 await assert.rejects(store.get('material',saved.id,b),{status:404});await store.save('material',{id:saved.id,revision:1,payload:{...payload,notes:'已更新'}},a);await assert.rejects(store.save('material',{id:saved.id,revision:1,payload},a),{status:409});
});

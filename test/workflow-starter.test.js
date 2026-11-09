import test from 'node:test';
import assert from 'node:assert/strict';
import {starterWorkflow} from '../src/shared/workflow-starter.js';
import {validateWorkflow} from '../src/shared/product-workflow.js';
import {expandWorkflowVariants} from '../src/shared/product-workflow-inputs.js';
import {workflowGenerationInput} from '../src/services/product-workflow-execution.js';
process.env.DB_HOST ||= '127.0.0.1';process.env.DB_NAME ||= 'workflow_test';process.env.DB_USER ||= 'workflow_test';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');

test('starter provides seven images, three linked Russian outputs and editable commercial inputs',()=>{
 const d=starterWorkflow({templateId:42,descriptionCategoryId:10,typeId:20,attributes:[]});validateWorkflow(d);
 assert.equal(d.nodes.filter(n=>n.type==='image').length,7);
 assert.equal(d.nodes.filter(n=>n.type==='image'&&n.role==='main').length,1);
 for(const k of ['title','tags','description'])assert.deepEqual(d.bindings[k].sources,[{nodeId:`copy_${k}`,output:k}]);
 assert.equal(d.bindings.images.sources.length,7);
 for(const key of ['price','weight','length','width','height']){const n=d.nodes.find(n=>n.id===`input_${key}`);assert.equal(n.valueSource,'user');assert.equal(n.defaultValue,'');}
 assert.deepEqual(d.nodes.find(n=>n.id==='copy_description').inputs.slice(-2),['copy_title','copy_tags']);
});
test('template fixed values expand into every variant without asking the user again',()=>{
 const d=starterWorkflow();const w=d.nodes.find(n=>n.id==='input_weight');w.valueSource='engineer';w.defaultValue=220;
 const variants=expandWorkflowVariants(d,[{id:'v1',label:'one',values:{product:['/uploads/a.png']}},{id:'v2',label:'two',values:{product:['/uploads/b.png']}}],{name:'宠物玩具',facts:'一件'});
 assert.deepEqual(variants.map(v=>v.values.input_weight),[220,220]);
});
test('custom common copy rules reach model input and invalid rules are rejected',()=>{
 const d=starterWorkflow();const node=d.nodes.find(n=>n.id==='copy_title');node.copyRules='只使用已确认的品牌和产品事实';
 const input=workflowGenerationInput(d,{id:'v1',label:'toy',values:{name:'toy',facts:'one'}},node,{});
 assert.equal(input.workflowCopyRules,node.copyRules);node.copyRules={};assert.throws(()=>validateWorkflow(d),/通用规则/);
});
test('first paginated visit seeds once per tenant, never copies private materials or overwrites templates',async()=>{
 const docs=[];const actor=id=>({personId:id,roles:['operations'],tenant:{id,slug:`t-${id}`,role:'member'}});
 const store=createProductWorkflowStore({authorize:async a=>a,loadCatalog:null,ensureSchema:async()=>{},execute:async(sql,p)=>{
  assert.match(sql,/INSERT IGNORE/);const [id,tenant,name,payload,person,,]=p;
  if(!docs.some(d=>d.tenant_id===tenant&&d.kind==='template'))docs.push({id,tenant_id:tenant,kind:'template',name,payload_json:payload,created_by:person,revision:1});return {affectedRows:1};
 },query:async(sql,p)=>{
  const own=docs.filter(d=>d.tenant_id===p[0]);if(sql.includes('COUNT(*)'))return [{total:own.length}];if(sql.includes("kind = 'run'"))return [];return own;
 }});
 await store.list('template',actor(1),{page:1});await store.list('template',actor(1),{page:1});await store.list('template',actor(2),{page:1});
 assert.equal(docs.length,2);assert.notEqual(docs[0].tenant_id,docs[1].tenant_id);
 const sample=JSON.parse(docs[0].payload_json);assert.equal(sample.starterSample,true);assert.equal(sample.nodes.filter(n=>n.type==='image').length,7);assert.ok(!sample.sharedMaterialRefs?.length);assert.ok(sample.nodes.every(n=>!n.materialRefs?.length));
 docs[0].name='user edited';await store.list('template',actor(1),{page:1});assert.equal(docs[0].name,'user edited');
});

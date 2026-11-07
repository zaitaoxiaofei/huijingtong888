import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, buildWorkflowDraft, keyCaseWorkflow, createWorkflowNode } from '../src/shared/product-workflow.js';
import { addDefaultWorkflowBindings, resolveWorkflowBindings, workflowTemplateFields } from '../src/shared/product-workflow-bindings.js';
import { expandWorkflowVariants } from '../src/shared/product-workflow-inputs.js';
import { advanceProductWorkflow } from '../src/services/product-workflow-execution.js';
process.env.DB_HOST ||= '127.0.0.1';process.env.DB_NAME ||= 'workflow_unit_test';process.env.DB_USER ||= 'workflow_unit_test';
const {createProductWorkflowRoutes}=await import('../src/server/routes/productWorkflows.js');
const ref=(nodeId,output)=>({nodeId,output});
function fixture(){
  const definition={schemaVersion:1,name:'通用模板',globalPrompt:'真实产品',category:{templateId:7,descriptionCategoryId:100,typeId:200,attributes:[]},shopIds:[11,12],nodes:[{...createWorkflowNode('listing','listing'),templateId:7},
    {...createWorkflowNode('images','product'),valueSource:'user'},
    {...createWorkflowNode('field','brand'),label:'品牌',valueSource:'engineer',scope:'shared',defaultValue:'Fixed Brand'},
    {...createWorkflowNode('field','title'),label:'标题',valueSource:'user',defaultValue:'标题'},
    {...createWorkflowNode('image','a'),label:'主图',inputs:['product'],role:'main'},
    {...createWorkflowNode('image','b'),label:'详情',inputs:['product']},
    {...createWorkflowNode('copy','text'),label:'自定义简介',target:'text',inputs:['brand']}],
    bindings:{title:{sources:[ref('title','value')]},description:{sources:[ref('text','text')]},images:{sources:[ref('b','image'),ref('a','image')]},richContent:{sources:[ref('a','image'),ref('text','text')]}}};
  const variants=expandWorkflowVariants(definition,['one','two'].map(id=>({id,label:id,values:{title:id,product:[`https://example.test/${id}.png`]}})));
  const outputs=Object.fromEntries(variants.map(v=>[v.id,{a:{url:`https://example.test/${v.id}-a.png`,approved:true},b:{url:`https://example.test/${v.id}-b.png`,approved:true},text:{text:{text:`Description ${v.id}`},approved:true}}]));
  return {definition,variants,outputs};
}
test('field bindings preserve chosen order, compose rich content and reuse nodes across variants',()=>{
  const {definition,variants,outputs}=fixture();validateWorkflow(definition);
  const draft=buildWorkflowDraft(definition,variants,outputs,{editable_payload:{images:['old'],variants:[{images:['old']}] }},'binding-run');
  const rows=draft.template_payload.editable_payload.variants;
  for(const row of rows){
    assert.equal(row.title,row.workflow_variant_id);
    assert.equal(row.description,`Description ${row.workflow_variant_id}`);
    assert.equal(row.primary_image,`https://example.test/${row.workflow_variant_id}-b.png`);
    const block=JSON.parse(row.rich_content_json).content[0].blocks[0];
    assert.equal(block.img.src,`https://example.test/${row.workflow_variant_id}-a.png`);
    assert.equal(block.text.items[0].content,row.description);
  }
  assert.deepEqual(draft.template_payload.editable_payload.workflow_target_shop_ids,[11,12]);
  assert.ok(!JSON.stringify(rows).includes('old'));
});
test('manual-only templates do not require hard-coded AI title or image nodes',()=>{
  const {definition,variants}=fixture();definition.nodes=definition.nodes.filter(n=>!['image','copy'].includes(n.type));
  definition.bindings={title:{sources:[ref('title','value')]},images:{sources:[ref('product','image')]}};
  validateWorkflow(definition);
  const draft=buildWorkflowDraft(definition,variants,{}, {},'manual-run');
  assert.equal(draft.template_payload.editable_payload.variants[1].primary_image,'https://example.test/two.png');
});
test('bindings reject missing outputs, wrong types and invented dictionary choices',()=>{
  const {definition,variants,outputs}=fixture();
  definition.bindings.title.sources=[ref('a','image')];assert.throws(()=>validateWorkflow(definition),/类型/);
  definition.bindings.title.sources=[ref('missing','value')];assert.throws(()=>validateWorkflow(definition),/不存在/);
  definition.bindings.title.sources=[ref('title','value')];
  definition.category.attributes=[{attributeId:8,id:'attr_8',type:'attribute',dictionaryId:9,options:[{id:1,label:'Black'}]}];
  definition.bindings.attribute_8={sources:[ref('text','text')]};
  assert.throws(()=>resolveWorkflowBindings(definition,variants[0],outputs.one),/不在类目选项/);
  outputs.one.text.text.text='Black';assert.deepEqual(resolveWorkflowBindings(definition,variants[0],outputs.one).attribute_8,[1]);
  definition.bindings.attribute_123={sources:[]};assert.throws(()=>validateWorkflow(definition),/不属于当前类目/);
});
test('old templates gain explicit bindings without altering originals or running definitions',()=>{
  const original=keyCaseWorkflow(),definition=addDefaultWorkflowBindings(structuredClone(original));
  assert.equal(original.bindings,undefined);validateWorkflow(definition);
  assert.equal(definition.bindings.images.sources.length,7);
  assert.deepEqual(definition.bindings.richContent.sources,[ref('main','image'),ref('copy','description')]);
});
test('generic text nodes are executed and retain their custom text output',async()=>{
  const {definition,variants}=fixture();definition.nodes=definition.nodes.filter(n=>n.type!=='image');definition.bindings={description:{sources:[ref('text','text')]}};
  const run={id:'generic',payload:{definition,variants:[variants[0]],outputs:{}}};let task;
  const deps={guard:async()=>{},commit:async()=>{},findTask:async()=>task,createTask:async()=>{task={status:'done',output:{description:'Only this text'}};}};
  await advanceProductWorkflow(run,deps);await advanceProductWorkflow(run,deps);
  assert.deepEqual(run.payload.outputs.one.text.text,{text:'Only this text'});
});
test('batch rows create independent jobs; retry of an accepted request does not create another',async()=>{
  const {definition,variants}=fixture(),records=new Map(),queued=[];
  const services={listingCategoryTemplateDetail:async()=>({id:7,description_category_id:100,type_id:200}),listingOzonCategoryAttributes:async()=>[]};
  const store={get:async(kind,id)=>{if(!records.has(id))throw Object.assign(new Error('missing'),{status:404});return records.get(id);},save:async(kind,body)=>{const record={id:body.creationId,payload:body.payload};records.set(record.id,record);return record;}};
  const routes=createProductWorkflowRoutes({readJson:async req=>req.body,services,store,enqueue:async id=>queued.push(id)});
  const submit=routes['POST /api/product-workflows/runs'];
  const ids=['d94faef2-b7d2-414d-a146-f054bd3e36d0','ea2e29d2-d542-4f88-82aa-7ca3b637cb14'];
  for(let i=0;i<variants.length;i++)await submit({body:{requestId:ids[i],payload:{definition:structuredClone(definition),variants:[variants[i]],outputs:{}}}});
  await submit({body:{requestId:ids[0]}});
  assert.equal(records.size,2);assert.equal(records.get(ids[0]).payload.variants.length,1);
  assert.notDeepEqual(records.get(ids[0]).payload.variants[0].values.product,records.get(ids[1]).payload.variants[0].values.product);
  assert.equal(queued.length,3); // enqueue is itself idempotent by tenant/run primary key.
  records.get(ids[0]).payload.definition.name='Changed task';assert.equal(records.get(ids[1]).payload.definition.name,'通用模板');
});

test('custom text prompts do not inherit commerce-copy length or tag-count constraints',async()=>{
  const {generateProductWorkflowText}=await import('../src/services/product-workflow-text.js');
  let request;
  const output=await generateProductWorkflowText({workflowOutput:'text',workflowNodeLabel:'品牌提取',rules:['只输出品牌'],sourceContext:{workflowFacts:{brand:'Example'}}},async input=>{request=input;return {content:'{"value":"Example"}',model:'test'};});
  assert.equal(output.text,'Example');
  assert.ok(!JSON.stringify(request).includes('150-250'));
  const tags=await generateProductWorkflowText({workflowOutput:'tags'},async()=>({content:'{"value":["#one"]}'}));
  assert.deepEqual(tags.tags,['#one']);
  await assert.rejects(generateProductWorkflowText({workflowOutput:'tags'},async()=>({content:'{"value":"not a list"}'})),/标签/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { keyCaseWorkflow, buildWorkflowDraft, validateWorkflowVariants, createWorkflowNode } from '../src/shared/product-workflow.js';
import { expandWorkflowVariants, categoryAttributeNodes } from '../src/shared/product-workflow-inputs.js';
import { advanceProductWorkflow, workflowGenerationInput } from '../src/services/product-workflow-execution.js';
import { prepareProductWorkflowRun } from '../src/services/product-workflow-category.js';

function fixture() {
  const definition=keyCaseWorkflow();definition.nodes.find(n=>n.type==='listing').templateId=7;
  const shared=Object.fromEntries(definition.nodes.filter(n=>n.scope==='shared').map(n=>[n.id,n.type==='images'?Array(n.count).fill(`https://example.test/common-${n.id}.png`):`Confirmed ${n.label}`]));
  const variants=['black','red'].map(id=>({id,label:id,values:{product:[`https://example.test/${id}.png`],color:id},promptOverrides:{}}));
  return {id:'background-run',payload:{definition,variants:expandWorkflowVariants(definition,variants,shared),outputs:{}}};
}
function fakeAi() {
  const tasks=new Map(),calls=[];
  return {tasks,calls,guard:async()=>{},commit:async()=>{},findTask:async id=>tasks.get(id),createTask:async body=>{calls.push(body);if(tasks.has(body.taskId))throw new Error('duplicate');tasks.set(body.taskId,{status:'done',output:body.fieldKey==='mainImage'?{generatedImages:[{url:`https://example.test/output/${body.taskId}.png`}]}:{titles:['Confirmed title'],tags:['#tag'],description:'Confirmed description'}});},retryTask:async()=>{}};
}
test('public references apply to all variants while product images and optional prompts stay isolated',()=>{
  const run=fixture();run.payload.variants[1].promptOverrides.detail_1='Highlight red edging';
  assert.deepEqual(run.payload.variants[0].values.key,run.payload.variants[1].values.key);
  assert.notDeepEqual(run.payload.variants[0].values.product,run.payload.variants[1].values.product);
  const main=run.payload.definition.nodes.find(n=>n.id==='main');
  const input=workflowGenerationInput(run.payload.definition,run.payload.variants[1],main,{});
  assert.ok(input.sourceImageUrls.includes('https://example.test/red.png'));assert.ok(!input.sourceImageUrls.includes('https://example.test/black.png'));
  const detail=run.payload.definition.nodes.find(n=>n.id==='detail_1');
  const detailInput=workflowGenerationInput(run.payload.definition,run.payload.variants[1],detail,{main:{url:'https://example.test/red-main.png'},approve:{approved:true}});
  assert.match(detailInput.finalPrompt,/Highlight red edging/);
});
test('background execution progresses all variant mains without a browser, stops at review and resumes after approval',async()=>{
  const ai=fakeAi();let run=fixture(),status;
  for(let i=0;i<100;i++){status=await advanceProductWorkflow(run,ai);run=JSON.parse(JSON.stringify(run));if(status.status==='awaiting_review')break;}
  assert.equal(status.status,'awaiting_review');
  assert.ok(run.payload.variants.every(v=>run.payload.outputs[v.id].main.url));
  assert.ok(run.payload.variants.every(v=>!run.payload.outputs[v.id].detail_1));
  const before=ai.calls.length;
  for(const variant of run.payload.variants){run.payload.outputs[variant.id].main.approved=true;run.payload.outputs[variant.id].approve={approved:true};}
  for(let i=0;i<100;i++){status=await advanceProductWorkflow(run,ai);run=JSON.parse(JSON.stringify(run));if(status.status==='awaiting_review')break;}
  assert.equal(status.status,'awaiting_review');assert.ok(ai.calls.length>before);
  const completedCount=ai.calls.length;await advanceProductWorkflow(run,ai);assert.equal(ai.calls.length,completedCount);
  for(const results of Object.values(run.payload.outputs))for(const state of Object.values(results))state.approved=true;
  assert.equal((await advanceProductWorkflow(run,ai)).status,'ready');
  const draft=buildWorkflowDraft(run.payload.definition,run.payload.variants,run.payload.outputs,{},run.id);
  const rows=draft.template_payload.editable_payload.variants;
  assert.notDeepEqual(rows[0].images,rows[1].images);
});
test('persisted submit intent recovers the same task after restart and does not double-submit',async()=>{
  const ai=fakeAi(),run=fixture();
  let checkpoint;
  ai.commit=async()=>{checkpoint=JSON.parse(JSON.stringify(run));};
  await advanceProductWorkflow(run,ai);
  const restarted=checkpoint;
  const originalId=ai.calls[0].taskId;
  await advanceProductWorkflow(restarted,ai);
  assert.equal(ai.calls.length,1);assert.equal(restarted.payload.outputs.black.main.taskId,originalId);
  assert.ok(restarted.payload.outputs.black.main.url);
});
test('category properties preserve only chosen dictionary values and map into each variant',()=>{
  const schema=[{id:123,name_zh:'颜色',dictionary_id:9,is_required:true,values:[{id:1,value:'黑色'},{id:2,value:'红色'}]}];
  const [node]=categoryAttributeNodes({attributes:[{attribute_id:123,dictionary_id:9,selected_values:[{dictionary_value_id:1,value:'黑色'}]}]},schema);
  assert.equal(node.defaultValue,1);assert.deepEqual(node.options.map(x=>x.id),[1,2]);
  const run=fixture();run.payload.definition.nodes.splice(1,0,node);
  run.payload.variants[0].values[node.id]=1;run.payload.variants[1].values[node.id]=2;
  validateWorkflowVariants(run.payload.definition,run.payload.variants);
  run.payload.variants[1].values[node.id]=999;assert.throws(()=>validateWorkflowVariants(run.payload.definition,run.payload.variants),/未核实/);
});
test('submission binds the owned category schema without requiring every platform attribute',async()=>{
  const run=fixture();
  const services={listingCategoryTemplateDetail:async()=>({id:7,description_category_id:100,type_id:200,editable_payload:{}}),listingOzonCategoryAttributes:async()=>[{id:55,name_zh:'包装数量',is_required:true}]};
  const partial=await prepareProductWorkflowRun(run.payload,{},services);
  assert.equal(partial.executionMode,'background');
  assert.equal(partial.definition.category.attributes[0].platformRequired,true);
  assert.equal(partial.definition.category.attributes[0].required,false);
  const attr={...createWorkflowNode('attribute','quantity'),attributeId:55,dictionaryId:0,label:'包装数量',scope:'shared',defaultValue:'1',multiple:false};
  run.payload.definition.nodes.splice(1,0,attr);
  const payload=await prepareProductWorkflowRun({...run.payload,sharedValues:{quantity:'1'}},{},services);
  assert.equal(payload.executionMode,'background');assert.equal(payload.listingSnapshot.id,7);
  assert.ok(payload.variants.every(v=>v.values.quantity==='1'));
});
test('lost authorization or lease stops AI submission after the checkpoint',async()=>{
  const run=fixture(),ai=fakeAi();let saved=false;
  ai.commit=async()=>{saved=true;};ai.guard=async()=>{throw new Error('lease lost');};
  await assert.rejects(advanceProductWorkflow(run,ai),/lease lost/);
  assert.equal(saved,true);assert.equal(ai.calls.length,0);
});

test('engineer fixed values cannot be replaced by production inputs',()=>{
  const definition=keyCaseWorkflow();
  const material=definition.nodes.find(n=>n.id==='material');
  material.valueSource='engineer';material.defaultValue='TPU';
  const [variant]=expandWorkflowVariants(definition,[{id:'one',values:{material:'fake'}}],{material:'fake shared'});
  assert.equal(variant.values.material,'TPU');
});

test('generated description mapping and rich content use each variant approved output',()=>{
  const run=fixture();
  run.payload.definition.nodes.splice(1,0,{...createWorkflowNode('attribute','summary'),attributeId:4191,dictionaryId:0,valueSource:'generated',generatedTarget:'description',required:true});
  for(const variant of run.payload.variants){
    run.payload.outputs[variant.id]={};
    for(const node of run.payload.definition.nodes){
      if(node.type==='image')run.payload.outputs[variant.id][node.id]={approved:true,url:`https://example.test/${variant.id}/${node.id}.png`};
      if(node.type==='approval')run.payload.outputs[variant.id][node.id]={approved:true};
      if(node.type==='copy')run.payload.outputs[variant.id][node.id]={approved:true,text:{title:variant.id,tags:['#key'],description:`Description ${variant.id}`}};
    }
  }
  validateWorkflowVariants(run.payload.definition,run.payload.variants);
  const draft=buildWorkflowDraft(run.payload.definition,run.payload.variants,run.payload.outputs,{},run.id);
  for(const row of draft.template_payload.editable_payload.variants){
    const rich=JSON.parse(row.rich_content_json);
    assert.equal(rich.content[0].blocks[0].img.src,row.primary_image);
    assert.equal(rich.content[0].blocks[0].text.items[0].content,row.description);
    assert.equal(row.dynamic_attributes[4191].value,row.description);
  }
});

test('server rejects fabricated dictionary choices and restores authoritative labels',async()=>{
  const run=fixture();
  run.payload.definition.nodes.splice(1,0,{...createWorkflowNode('attribute','choice'),attributeId:55,dictionaryId:5,multiple:false,options:[{id:999,label:'伪造值'}],required:false});
  for(const variant of run.payload.variants)variant.values.choice=999;
  const services={listingCategoryTemplateDetail:async()=>({id:7,description_category_id:100,type_id:200}),listingOzonCategoryAttributes:async()=>[{id:55,name:'颜色',dictionary_id:5}],listingOzonAttributeValues:async()=>[]};
  await assert.rejects(prepareProductWorkflowRun(run.payload,{},services),/不在当前类目字典/);
  services.listingOzonAttributeValues=async()=>[{dictionary_value_id:999,value:'真实颜色'}];
  const prepared=await prepareProductWorkflowRun(run.payload,{},services);
  assert.equal(prepared.definition.nodes.find(n=>n.id==='choice').options[0].label,'真实颜色');
});

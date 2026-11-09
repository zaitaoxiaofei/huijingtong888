import test from 'node:test';
import assert from 'node:assert/strict';
import {keyCaseProductionWorkflow,withWorkflowFitmentMode} from '../src/shared/key-case-production-workflow.js';
import {expandWorkflowVariants,workflowDefault} from '../src/shared/product-workflow-inputs.js';
import {buildWorkflowDraft,validateWorkflow,validateWorkflowVariants} from '../src/shared/product-workflow.js';
import {workflowGenerationInput,advanceProductWorkflow} from '../src/services/product-workflow-execution.js';
const category={templateId:12,descriptionCategoryId:100,typeId:200,categoryName:'真实类目',attributes:[85,8229,7199,10096,7204,7212,4180].map(id=>({id:`attr_${id}`,type:'attribute',attributeId:id,label:`属性 ${id}`,dictionaryId:id===4180?0:9,multiple:false,options:[{id:1,label:'已确认值'}],defaultValue:id===8229?1:'',inputs:[],required:false}))};
function fixture(mode='shared'){
  const definition=withWorkflowFitmentMode(keyCaseProductionWorkflow(category),mode);
  definition.nodes.find(n=>n.id==='style').defaultValue=['https://example.test/style-main.png'];
  definition.nodes.find(n=>n.id==='style_details').defaultValue=Array.from({length:5},(_,i)=>`https://example.test/style-detail-${i}.png`);
  const shared=Object.fromEntries(definition.nodes.filter(n=>n.scope==='shared'&&n.valueSource!=='engineer').map(n=>[n.id,workflowDefault(n)]));
  Object.assign(shared,{model:'Model A',key:['https://example.test/key-a.png'],facts:'Confirmed packaging: 1 case'});
  const variants=expandWorkflowVariants(definition,['one','two'].map((id,i)=>({id,label:id,values:{product:[`https://example.test/product-${id}.png`],...(mode==='individual'?{model:`Model ${i+1}`,key:[`https://example.test/key-${i+1}.png`]}:{})}})),shared);
  return {id:'case-run',payload:{definition,variants,outputs:{}}};
}
test('preset keeps genuine category metadata, reusable style materials and per-shot reference routing',()=>{
  const run=fixture();validateWorkflow(run.payload.definition);validateWorkflowVariants(run.payload.definition,run.payload.variants);
  assert.equal(run.payload.definition.nodes.filter(n=>n.type==='image').length,6);
  assert.equal(run.payload.variants[0].values.material,''); // no unconfirmed TPU assumption
  const node=run.payload.definition.nodes.find(n=>n.id==='detail_3');
  const input=workflowGenerationInput(run.payload.definition,run.payload.variants[0],node,{main:{url:'https://example.test/approved-main.png'},approve:{approved:true}});
  assert.ok(input.sourceImageUrls.includes('https://example.test/style-detail-2.png'));
  assert.ok(!input.sourceImageUrls.includes('https://example.test/style-detail-0.png'));
  assert.ok(input.sourceImageUrls.length<=8);
  const invalid=structuredClone(run.payload.definition);invalid.nodes.find(n=>n.id==='detail_3').referenceSlots.style_details=[8];assert.throws(()=>validateWorkflow(invalid),/槽位/);
});
test('new car fitment and product geometry never inherit another row while saved style is reused',()=>{
  const run=fixture('individual'),main=run.payload.definition.nodes.find(n=>n.id==='main');
  const inputs=run.payload.variants.map(v=>workflowGenerationInput(run.payload.definition,v,main,{}));
  assert.ok(inputs[0].sourceImageUrls.includes('https://example.test/key-1.png'));
  assert.ok(!inputs[0].sourceImageUrls.includes('https://example.test/key-2.png'));
  assert.ok(inputs[1].sourceImageUrls.includes('https://example.test/product-two.png'));
  assert.ok(inputs.every(input=>input.sourceImageUrls.includes('https://example.test/style-main.png')));
  assert.ok(inputs[1].finalPrompt.includes('Model 2'));assert.ok(!inputs[1].finalPrompt.includes('Model 1'));
});
test('fixed style kit is required before paid work and cannot be replaced by production overrides',()=>{
  const run=fixture(),style=run.payload.definition.nodes.find(n=>n.id==='style');style.defaultValue=[''];
  const expanded=expandWorkflowVariants(run.payload.definition,[{id:'one',label:'one',values:{...run.payload.variants[0].values,style:['https://example.test/fake.png']}}],run.payload.variants[0].values);
  assert.throws(()=>validateWorkflowVariants(run.payload.definition,expanded),/固定风格参考/);
});
test('headless production gates main approval then produces five detail shots and mapped listing copy for each car',async()=>{
  const run=fixture('individual'),tasks=new Map(),requests=[];
  const deps={guard:async()=>{},commit:async()=>{},findTask:async id=>tasks.get(id),createTask:async task=>{requests.push(task);tasks.set(task.taskId,{status:'done',output:task.fieldKey==='mainImage'?{generatedImages:[{url:`https://example.test/${task.taskId}.png`}]}:task.input.workflowOutput==='tags'?{tags:['#case']}:{[task.input.workflowOutput]:'Confirmed text'}});}};
  let status;
  for(let i=0;i<100;i++){status=await advanceProductWorkflow(run,deps);if(status.status==='awaiting_review')break;}
  assert.equal(status.status,'awaiting_review');assert.ok(run.payload.variants.every(v=>!run.payload.outputs[v.id].detail_1));
  for(const variant of run.payload.variants){run.payload.outputs[variant.id].main.approved=true;run.payload.outputs[variant.id].approve={approved:true};}
  for(let i=0;i<120;i++){status=await advanceProductWorkflow(run,deps);if(status.status==='awaiting_review')break;}
  for(const result of Object.values(run.payload.outputs))for(const state of Object.values(result))state.approved=true;
  assert.equal((await advanceProductWorkflow(run,deps)).status,'ready');
  const draft=buildWorkflowDraft(run.payload.definition,run.payload.variants,run.payload.outputs,{},run.id),rows=draft.template_payload.editable_payload.variants;
  assert.ok(rows.every(row=>row.images.length===6&&row.tags[0]==='#case'&&JSON.parse(row.rich_content_json).version===0.3));
  assert.notEqual(rows[0].primary_image,rows[1].primary_image);assert.equal(requests.filter(r=>r.fieldKey==='mainImage').length,12);
});

test('first detail gives the bare key priority and the last detail is confirmed packaging',()=>{const run=fixture();const shots=run.payload.definition.nodes.filter(n=>n.type==='image'&&n.role==='detail');assert.equal(shots.length,5);assert.match(shots[0].prompt,/原钥匙为主视觉/);assert.match(shots[0].prompt,/小比例陪衬/);assert.match(shots[4].label,/礼盒/);assert.ok(shots[3].inputs.includes('vehicle_photo'));});

test('missing key no longer silently treats the product picture as a verified mold',()=>{const run=fixture();const expanded=expandWorkflowVariants(run.payload.definition,[{id:'one',label:'one',values:{product:['https://example.test/composite-product.jpg']}}],{model:'DASHING',facts:'black carbon pattern'});assert.ok(!expanded[0].values.key.some(Boolean));validateWorkflowVariants(run.payload.definition,expanded);});

test('commercial fields stay empty until listing and never inherit another SKU price or packaging',()=>{
  const run=fixture();
  for(const v of run.payload.variants){run.payload.outputs[v.id]={};for(const node of run.payload.definition.nodes){if(node.type==='image')run.payload.outputs[v.id][node.id]={approved:true,url:`https://example.test/${v.id}/${node.id}.png`};if(node.type==='approval')run.payload.outputs[v.id][node.id]={approved:true};if(node.type==='copy')run.payload.outputs[v.id][node.id]={approved:true,text:{[node.target]:node.target==='tags'?['#key']:'Чехол для ключа'}};}}
  const base={price:999,cost_price:123,attributes:[{attribute_id:999,value:'old fact'}],editable_payload:{price:{value:999},weight_g:400,length_cm:20,attributes:[{attribute_id:999,value:'old fact'}],source_raw:{price:999}}};
  const draft=buildWorkflowDraft(run.payload.definition,run.payload.variants,run.payload.outputs,base,run.id);
  assert.equal(draft.sale_price,0);assert.equal(draft.weight_g,0);assert.equal(draft.template_payload.price,undefined);assert.equal(draft.template_payload.editable_payload.price,undefined);
  assert.ok(!JSON.stringify(draft).includes('old fact'));assert.equal(draft.template_payload.editable_payload.pending_listing_fields.length,5);
});

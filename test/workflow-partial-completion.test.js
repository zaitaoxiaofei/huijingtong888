import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkflowDraft} from '../src/shared/product-workflow.js';
import {workflowIncompleteNodes, workflowNodeHasOutput} from '../src/shared/workflow-completion.js';
import {advanceProductWorkflow} from '../src/services/product-workflow-execution.js';

function fixture(bindings=true){
 const nodes=[{id:'main',type:'image',label:'主图',role:'main',inputs:[]},{id:'approve',type:'approval',label:'确认主图',inputs:['main']},
  {id:'failed',type:'image',label:'失败详情',inputs:['approve']},{id:'retained',type:'image',label:'已有详情',inputs:['failed']},
  ...['title','tags','description'].map(target=>({id:target,type:'copy',label:target,target,inputs:[]})),
  {id:'video',type:'video',label:'视频',inputs:['main']},{id:'listing',type:'listing',label:'类目',templateId:7,inputs:[]}];
 const definition={schemaVersion:1,name:'通用测试流程',globalPrompt:'',nodes};
 if(bindings)definition.bindings={images:{sources:['main','failed','retained'].map(nodeId=>({nodeId,output:'image'}))},
  ...Object.fromEntries(['title','tags','description'].map(key=>[key,{sources:[{nodeId:key,output:key}]}])),
  richContent:{sources:[{nodeId:'failed',output:'image'},{nodeId:'description',output:'description'}]}};
 const output={main:{status:'done',url:'https://example.test/main.png',approved:true},approve:{approved:true},
  failed:{status:'unknown',taskId:'original-task',submissionKey:'original-intent',error:'原任务缺少回执',approved:false},
  retained:{status:'done',url:'https://example.test/retained.png',approved:true},
  title:{status:'done',text:{title:'Чехол для автомобильного ключа'},approved:true},
  tags:{status:'done',text:{tags:['#чехол_ключа']},approved:true},
  description:{status:'done',text:{description:'Защитный чехол для автомобильного ключа.'},approved:true},video:{status:'failed',error:'视频生成失败',approved:false}};
 return {id:'partial-run',payload:{definition,variants:[{id:'one',label:'当前商品',values:{}}],outputs:{one:output}}};
}
function omitMissing(run){for(const item of workflowIncompleteNodes(run.payload))run.payload.outputs[item.variantId][item.nodeId]={...run.payload.outputs[item.variantId][item.nodeId],completionIgnored:true,approved:false};}
const draft=run=>buildWorkflowDraft(run.payload.definition,run.payload.variants,run.payload.outputs,{primary_image:'https://example.test/stale.png',images:[{url:'https://example.test/stale.png'}],tags:['#old_template'],rich_content_json:'old template rich text',attributes:[{attribute_id:4191,values:[{value:'old template description'}]}],source_raw:{description:'old template source'},editable_payload:{primary_image:'https://example.test/stale.png',tags:['#old_template'],attributes:[{attribute_id:4191,values:[{value:'old template description'}]}],variants:[{images:[{url:'https://example.test/stale.png'}]}]}},run.id);

test('completion preview includes failed, unconfirmed, queued and blocked outputs but not empty copy objects as successes',()=>{
 const run=fixture(),out=run.payload.outputs.one;
 out.title.text={};out.tags.text={tags:[]};out.video.status='running';delete out.retained;
 const missing=workflowIncompleteNodes(run.payload);
 assert.deepEqual(missing.map(item=>item.nodeId),['failed','retained','title','tags','video']);
 assert.equal(missing[0].taskId,'original-task');assert.equal(missing[0].variantLabel,'当前商品');assert.equal(missing[0].reason,'原任务缺少回执');
 assert.equal(workflowNodeHasOutput({type:'copy',target:'text'},{text:{text:'  '}}),false);
 assert.equal(workflowNodeHasOutput({type:'copy',target:'text'},{text:{text:'可用文本'}}),true);
});

for(const bindings of [false,true])test(`explicit omissions save successful results with ${bindings?'bound':'legacy'} templates, preserving original task and existing descendants`,()=>{
 const run=fixture(bindings),before=structuredClone(run.payload.outputs.one.retained);
 assert.throws(()=>draft(run),/尚未/);
 omitMissing(run);
 const body=draft(run),row=body.template_payload.editable_payload.variants[0];
 assert.deepEqual(row.images.map(image=>image.url),['https://example.test/main.png','https://example.test/retained.png']);
 assert.deepEqual(row.video_urls,[]);assert.equal(row.title,'Чехол для автомобильного ключа');assert.equal(row.images_manually_edited,true);
 assert.equal(run.payload.outputs.one.failed.taskId,'original-task');assert.equal(run.payload.outputs.one.failed.submissionKey,'original-intent');assert.equal(run.payload.outputs.one.failed.approved,false);
 assert.deepEqual(run.payload.outputs.one.retained,before);assert.equal(workflowIncompleteNodes(run.payload).length,0);
 assert.doesNotMatch(JSON.stringify(body),/stale\.png/);
 assert.doesNotMatch(JSON.stringify(body),/old_template|old template/);
 if(bindings)assert.equal(JSON.parse(row.rich_content_json).content[0].blocks[0].img,undefined);
});

for(const bindings of [false,true])test(`omitted main and copy fields stay empty in ${bindings?'bound':'legacy'} drafts instead of inheriting historical content`,()=>{
 const run=fixture(bindings),out=run.payload.outputs.one;
 for(const key of ['main','retained','title','tags','description'])out[key]={status:'failed',error:'未完成'};
 omitMissing(run);
 const body=draft(run),row=body.template_payload.editable_payload.variants[0];
 assert.deepEqual(row.images,[]);assert.equal(row.title,'');assert.equal(row.description,'');assert.deepEqual(row.tags,[]);assert.deepEqual(row.video_urls,[]);
 assert.equal(body.product_name,'当前商品');assert.equal(body.template_payload.primary_image,'');assert.equal(body.template_payload.editable_payload.primary_image,'');
 assert.doesNotMatch(JSON.stringify(body),/stale\.png|undefined/);
 assert.equal(JSON.parse(row.rich_content_json).content[0].blocks[0].img,undefined);
});

test('omitted nodes never submit or repoll a paid task and completed outputs remain reusable',async()=>{
 const run=fixture();omitMissing(run);
 const result=await advanceProductWorkflow(run,{findTask:async()=>{throw Error('must not query an omitted task');},createTask:async()=>{throw Error('must not submit another image');},retryTask:async()=>{throw Error('must not requeue an omitted task');}});
 assert.equal(result.status,'ready');assert.equal(run.payload.outputs.one.failed.taskId,'original-task');
});

test('a conditionally skipped optional image does not require an operator omission',()=>{
 const run=fixture();run.payload.definition.nodes.find(node=>node.id==='failed').requiresInput='key';run.payload.variants[0].values.key=[];
 assert.deepEqual(workflowIncompleteNodes(run.payload).map(item=>item.nodeId),['video']);
});

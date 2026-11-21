import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowJobPump} from '../src/services/product-workflow-pump.js';
import {completeCheckpointedImage} from '../src/services/ai-image-output-checkpoint.js';
import {advanceProductWorkflow} from '../src/services/product-workflow-execution.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function run(id='run') {return {id,payload:{definition:{schemaVersion:1,globalPrompt:'真实',nodes:[{id:'product',type:'images',inputs:[],label:'产品',count:1,slots:['产品图'],referenceRole:'product'},{id:'main',type:'image',inputs:['product'],role:'main',label:'主图',ratio:'3:4',prompt:'真实'}]},variants:[{id:'one',label:'产品',values:{product:['https://example.test/product.png']}}],outputs:{}}};}
function ai(){return {guard:async()=>{},commit:async()=>{},createTask:async()=>{},retryTask:async()=>{}};}
test('three workflows run concurrently and a freed slot fills while another workflow is still busy',async()=>{
 const gates=[];let active=0,max=0,starts=0;
 const tick=createWorkflowJobPump(()=>new Promise(resolve=>{starts++;active++;max=Math.max(max,active);gates.push(()=>{active--;resolve();});}),3);
 const first=tick();await flush();assert.equal(starts,3);await tick();assert.equal(starts,3);
 gates[0]();await flush();const refill=tick();await flush();assert.equal(starts,4);assert.equal(max,3);
 gates.slice(1).forEach(release=>release());await Promise.all([first,refill]);assert.equal(active,0);
});
test('one failed workflow does not cancel other workflows or leak its concurrency slot',async()=>{
 let calls=0;const tick=createWorkflowJobPump(async()=>{if(++calls===1)throw Error('one failed');},3);
 const result=await tick();assert.equal(result.filter(r=>r.status==='fulfilled').length,2);assert.equal(result.filter(r=>r.status==='rejected').length,1);
 await tick();assert.equal(calls,6);
});
test('generated image survives archive failure and restart without a second model call',async()=>{
 let calls=0,saved;const output={taskId:'original-task',generatedImages:[{url:'/api/ai/file/original-task/generated/a.png'}]};
 const generate=async()=>{calls++;return output;};
 await assert.rejects(completeCheckpointedImage({},{generate,checkpoint:async value=>{saved=JSON.parse(JSON.stringify(value));},persist:async()=>{throw Error('OSS offline');}}),{code:'AI_GENERATION_STORAGE_PENDING'});
 const result=await completeCheckpointedImage({generatedCheckpoint:saved},{generate,checkpoint:async()=>{throw Error('must reuse checkpoint');},persist:async original=>{assert.deepEqual(original,output);return {url:'https://example.test/archived.png'};}});
 assert.equal(calls,1);assert.equal(result.url,'https://example.test/archived.png');
});
test('pending supplier result is queried using the same task and never manually requeued by workflow polling',async()=>{
 const r=run();let creates=0,retries=0;const deps={...ai(),createTask:async()=>{creates++;},retryTask:async()=>{retries++;},findTask:async()=>({status:'provider_pending',error:{code:'provider_pending'}})};
 await advanceProductWorkflow(r,deps);const original=r.payload.outputs.one.main.taskId;
 const restarted=JSON.parse(JSON.stringify(r));await advanceProductWorkflow(restarted,deps);await advanceProductWorkflow(restarted,deps);
 assert.equal(creates,1);assert.equal(retries,0);assert.equal(restarted.payload.outputs.one.main.taskId,original);assert.equal(restarted.payload.outputs.one.main.phase,'provider_pending');
 deps.findTask=async()=>({status:'done',output:{generatedImages:[{url:'https://example.test/final.png'}]}});
 await advanceProductWorkflow(restarted,deps);assert.equal(restarted.payload.outputs.one.main.url,'https://example.test/final.png');assert.equal(creates,1);
});
test('transport or local failures show pending review, only explicit supplier failure is failed',async()=>{
 for(const [code,expected] of [['generation_failed','awaiting_review'],['AI_GENERATION_STORAGE_PENDING','awaiting_review'],['AI_CREDIT_TASK_FAILED','failed'],['provider_job_terminal_failed','failed']]){
  const r=run();r.payload.outputs.one={main:{taskId:'same-id',status:'running'}};
  const result=await advanceProductWorkflow(r,{...ai(),findTask:async()=>({status:'failed',error:{code,message:'original issue'}})});
  assert.equal(result.status,expected,code);assert.equal(r.payload.outputs.one.main.taskId,'same-id');
 }
});
test('manual recovery of an uncertain image retries its original task rather than submitting a new image',async()=>{
 const r=run();r.payload.outputs.one={main:{taskId:'same-id',status:'resubmit'}};let resumed;
 const result=await advanceProductWorkflow(r,{...ai(),findTask:async()=>({status:'failed',error:{code:'generation_failed'}}),createTask:async()=>{throw Error('must not create another request');},retryTask:async id=>{resumed=id;}});
 assert.equal(result.status,'running');assert.equal(resumed,'same-id');assert.equal(r.payload.outputs.one.main.taskId,'same-id');
});
test('missing local task is pending review and retains its original submit intent',async()=>{
 const r=run();r.payload.outputs.one={main:{taskId:'same-id',submissionKey:'original',status:'submitting'}};
 const result=await advanceProductWorkflow(r,{...ai(),findTask:async()=>null});assert.equal(result.status,'awaiting_review');assert.equal(r.payload.outputs.one.main.submissionKey,'original');
});

test('a receiptless credit task pauses for reconciliation without losing completed images or resubmitting',async()=>{
 const r=run();r.payload.outputs.one={earlier:{url:'https://example.test/approved.png',approved:true},main:{taskId:'same-id',submissionKey:'original',status:'running',phase:'provider_pending',progressMessage:'正在查询原任务结果，不重复提交'}};
 const original=structuredClone(r.payload.outputs.one.earlier);
 const deps={...ai(),findTask:async()=>({status:'reconciliation_required',error:{code:'AI_CREDIT_RECONCILIATION_REQUIRED',message:'原任务缺少供应商回执，请联系平台管理员核对，核对后恢复原任务'}}),createTask:async()=>{throw Error('must not submit another image');},retryTask:async()=>{throw Error('automatic polling must not requeue');}};
 for(let i=0;i<3;i++){
  const result=await advanceProductWorkflow(r,deps);
  assert.equal(result.status,'awaiting_review');assert.match(result.error,/核对/);
  assert.equal(r.payload.outputs.one.main.status,'unknown');assert.equal(r.payload.outputs.one.main.phase,null);assert.equal(r.payload.outputs.one.main.progressMessage,null);
  assert.equal(r.payload.outputs.one.main.taskId,'same-id');assert.equal(r.payload.outputs.one.main.submissionKey,'original');assert.deepEqual(r.payload.outputs.one.earlier,original);
 }
});

test('manual reconciliation recovery requeues the original task once and accepts its saved result',async()=>{
 const r=run();r.payload.outputs.one={main:{taskId:'same-id',submissionKey:'original',status:'resubmit'}};
 let status='reconciliation_required',retries=0;
 const deps={...ai(),findTask:async()=>({status,error:{code:'AI_CREDIT_RECONCILIATION_REQUIRED'},output:{generatedImages:[{url:'https://example.test/recovered.png'}]}}),retryTask:async id=>{assert.equal(id,'same-id');retries++;status='queued';},createTask:async()=>{throw Error('must recover the original task');}};
 assert.equal((await advanceProductWorkflow(r,deps)).status,'running');assert.equal(retries,1);
 await advanceProductWorkflow(r,deps);assert.equal(retries,1);
 status='done';await advanceProductWorkflow(r,deps);
 assert.equal(r.payload.outputs.one.main.url,'https://example.test/recovered.png');assert.equal(r.payload.outputs.one.main.taskId,'same-id');
});

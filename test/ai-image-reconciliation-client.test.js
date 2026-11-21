import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function client(task){
 const calls=[];
 const source=(await readFile(new URL('../frontend/admin/api/tools/aiImageGenerator.js',import.meta.url),'utf8'))
  .replace('import { apiClient, getAuthToken, streamApiResponse } from "../../utils/api";',`const apiClient={get:async url=>{globalThis.__reconciliationClient.calls.push(url);return [globalThis.__reconciliationClient.task];},post:async()=>{throw Error('must not create or requeue a paid image');}};const getAuthToken=()=>'';const streamApiResponse=()=>{};`)
  .replace('import { browserProductVideoSupported, generateBrowserProductVideo } from "../../utils/browser-product-video";','const browserProductVideoSupported=()=>false;const generateBrowserProductVideo=()=>{};');
 globalThis.__reconciliationClient={task,calls};
 return {api:await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`),calls};
}

test('image clients stop on reconciliation and preserve the original task instead of polling or retrying',async()=>{
 const task={taskId:'original',status:'reconciliation_required',error:{code:'AI_CREDIT_RECONCILIATION_REQUIRED',message:'缺少供应商回执，请联系平台管理员核对'}};
 try{
  const {api,calls}=await client(task);
  for(const operation of [()=>api.generateAiImages({}, {taskId:'original'}),()=>api.pullAiImageTaskResult('original'),()=>api.pullAiImageTaskResult('original',{resume:false})]){
   const before=calls.length;
   await assert.rejects(operation(),error=>error.code==='AI_CREDIT_RECONCILIATION_REQUIRED'&&error.taskId==='original'&&error.task===task&&/核对/.test(error.message));
   assert.equal(calls.length-before,1);
  }
 }finally{delete globalThis.__reconciliationClient;}
});

test('a completed original task still returns its stored image without creating another request',async()=>{
 const task={taskId:'original',status:'done',output:{generatedImages:[{url:'https://example.test/recovered.png'}]}};
 try{
  const {api}=await client(task);
  assert.deepEqual(await api.generateAiImages({}, {taskId:'original'}),task.output);
  assert.deepEqual(await api.pullAiImageTaskResult('original'),task.output);
 }finally{delete globalThis.__reconciliationClient;}
});

test('a reconciliation error never starts the prompt library text-to-image fallback or discards the original task',async()=>{
 const source=await readFile(new URL('../frontend/admin/views/settings/PromptLibraryView.vue',import.meta.url),'utf8');
 const start=source.indexOf('async function generateOne(job)'),end=source.indexOf('\nasync function persistCopyAsset',start);
 let submissions=0;
 const error=Object.assign(new Error('原任务缺少供应商回执，请核对'),{code:'AI_CREDIT_RECONCILIATION_REQUIRED',taskId:'original'});
 const generate=vm.runInNewContext(`(${source.slice(start,end)})`,{
  renderPromptForTarget:async()=>({finalPositivePrompt:'fixture',finalNegativePrompt:''}),resolveStrategyPlanForTitles:()=>({}),isCopyJob:()=>false,
  task:{sourceImageUrl:'https://example.test/product.png',ratio:'3:4'},shouldUseReferenceImage:()=>true,withImageToken:value=>value,logs:{value:[]},
  generateAiImages:async()=>{submissions++;throw error;}
 });
 const job={};
 await assert.rejects(generate(job),value=>value===error);
 assert.equal(submissions,1);assert.equal(job.pendingTaskId,'original');assert.equal(job.status,'待人工核对');assert.equal(job.errorMessage,error.message);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveWorkflowImageRuntime} from '../src/services/ai-image-runtime-selection.js';
const pool=[{channelId:'new',provider:'image2',baseUrl:'https://tasks.example.test',apiMode:'tasks_65535',imageModel:'gpt-image-2',apiKey:'server-secret'}];
test('workflow without an explicit runtime selects the enabled pool just like fission',async()=>{
  const selected=await resolveWorkflowImageRuntime({},async()=>pool);
  assert.equal(selected.channelId,'new');assert.equal(selected.apiMode,'tasks_65535');
  const source=readFileSync(new URL('../src/server/services/ai/aiWorkflowService.js',import.meta.url),'utf8');
  assert.match(source,/resolveWorkflowImageRuntime\(payload,aiImageRuntimePoolConfig\)/);
  assert.match(source,/generateImagesInternal\(\{\.\.\.payload,imageRuntimeConfig\}\)/);
});
test('explicit fission and credited runtime selection remains unchanged',async()=>{
  const explicit={channelId:'preferred'};
  assert.equal(await resolveWorkflowImageRuntime({imageRuntimeConfig:explicit},async()=>{throw Error('must not reload');}),explicit);
});
test('asynchronous recovery stays on the original channel even when pool order changes',async()=>{
  const channels=[{...pool[0],channelId:'other'},pool[0]];
  const saved={jobs:[{jobId:'existing-job',channelId:'new'}]};
  assert.equal((await resolveWorkflowImageRuntime({providerJob:saved},async()=>channels)).channelId,'new');
  await assert.rejects(resolveWorkflowImageRuntime({providerJob:{jobId:'old-job',channelId:'disabled'}},async()=>pool),/不能换通道重复生图/);
});
test('legacy saved jobs can match their provider endpoint, but ambiguous recovery fails closed',async()=>{
  const payload={providerJob:{jobId:'existing-job',provider:'image2',endpoint:'https://tasks.example.test/v1/tasks'}};
  assert.equal(await resolveWorkflowImageRuntime(payload,async()=>pool),pool[0]);
  await assert.rejects(resolveWorkflowImageRuntime(payload,async()=>[pool[0],{...pool[0],channelId:'duplicate'}]),/原通道/);
});
test('no available pool never silently falls back to a disabled legacy endpoint',async()=>{
  await assert.rejects(resolveWorkflowImageRuntime({},async()=>[]),/没有可用/);
});

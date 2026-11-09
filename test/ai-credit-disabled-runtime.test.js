import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {assertAiSkillsAvailable} from '../src/shared/ai-skills-access.js';

test('a queued prepaid customer task is denied before reserving or freezing any points',async()=>{
 const source=readFileSync(new URL('../src/services/ai-credit-runtime.js',import.meta.url),'utf8');
 const start=source.indexOf('export function createAiCreditRuntime('),end=source.indexOf('\nexport const aiCreditRuntime',start);
 let reads=0,executors=0;
 const create=vm.runInNewContext(`(${source.slice(start,end).replace('export ','')})`,{
  createAiCreditLedger:()=>({}),assertAiSkillsAvailable,
  readAiCreditMode:async()=>{reads++;return {mode:'credits'};},
  createAiCreditExecutor:()=>{executors++;throw new Error('Must not reserve or dispatch');}
 });
 const session={personId:9,tenant:{id:42,slug:'customer-a'}};
 const runtime=create({query:async()=>{reads++;return [];},transaction:async()=>{throw new Error('No money writes');},resultStore:{},authorize:async()=>session});
 await assert.rejects(runtime.execute(session,{kind:'image',capability:'image.single',idempotencyKey:'saved-task',payload:{},provider:{}}),{code:'AI_SKILLS_DISABLED',statusCode:403});
 assert.equal(reads,0);assert.equal(executors,0);
});

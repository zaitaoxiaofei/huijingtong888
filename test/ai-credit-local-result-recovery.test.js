import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAiCreditExecutor } from "../src/services/ai-credit-execution.js";
import { createAiCreditResultStore } from "../src/services/ai-credit-result-store.js";

const digest=value=>createHash("sha256").update(value).digest("hex");

async function interruptedResultFixture({receipt=true,verify=true}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"ozon-credit-recovery-test-"));
  const resultStore=createAiCreditResultStore(directory);
  const session={personId:7,tenant:{id:2}};
  const input={capability:"image",idempotencyKey:"same-submission",payload:{prompt:"owned product"}};
  const task={id:randomUUID(),tenant_id:2,created_by_person_id:7,input_sha256:digest(JSON.stringify({capability:input.capability,payload:input.payload})),
    status:"reserved",requested_results:1,points_per_result:10,reserved_points:10,charged_points:0};
  const original={taskId:task.id,generatedImages:[{url:`/owned/${task.id}`,contentSha256:digest("valid image bytes"),sourceImage:"original-source"}]};
  const counters={submits:0,queries:0,verified:0,settlements:0,reservations:0,attempts:0};
  let attempt=null,interrupted=false;
  const ledger={
    async reserve(_session,request){
      assert.equal(request.inputSha256,task.input_sha256);
      if(!counters.reservations)counters.reservations++;
      return {...task};
    },
    async latestAttempt(){return attempt;},
    async startAttempt(){
      counters.attempts++;task.status="running";
      attempt={id:randomUUID(),status:"submitted",attempt_number:1,provider:"fixture",model:"fixture"};
      return {...attempt,should_submit:true};
    },
    async recordReceipt(_session,_id,{receipt:providerReceipt}){attempt.provider_receipt=providerReceipt;},
    async recordOutcome(_session,_id,outcome){
      if(!interrupted){interrupted=true;throw new Error("fixture: process lost after durable result, before ledger commit");}
      counters.settlements++;
      task.status=outcome.outcome;task.charged_points=10;
      task.result_reference=outcome.resultReference;task.result_sha256=outcome.resultSha256;
      return {...task};
    }
  };
  const provider={name:"fixture",model:"fixture",priceKey:"image.generate",
    async submit(_payload,{onReceipt}){counters.submits++;if(receipt)await onReceipt("original-receipt");return structuredClone(original);},
    async query(){counters.queries++;return {status:"succeeded",result:{...original,generatedImages:[{...original.generatedImages[0],sourceImage:"provider-job-resume"}]}};},
    ...(verify?{async verifySavedResult(result,{task:current}){counters.verified++;assert.equal(current.id,task.id);assert.deepEqual(result,original);return result;}}:{})
  };
  const execute=()=>createAiCreditExecutor({ledger,resultStore,providers:{image:provider},authorize:async()=>{}})(session,input);
  const cleanup=async()=>{
    if(path.dirname(directory)===path.resolve(os.tmpdir()) && path.basename(directory).startsWith("ozon-credit-recovery-test-"))await fs.rm(directory,{recursive:true,force:true});
  };
  try{await assert.rejects(execute(),/process lost after durable result/);}
  catch(error){await cleanup();throw error;}
  return {execute,resultStore,directory,task,session,input,provider,original,counters,cleanup};
}

for(const receipt of [false,true])test(`durable result survives a lost settlement with ${receipt?"an async receipt":"no synchronous receipt"}`,async()=>{
  const fixture=await interruptedResultFixture({receipt});
  try{
    const recovered=await fixture.execute();
    assert.deepEqual(recovered.result,fixture.original,"recovery returns the saved result, not newly synthesized polling metadata");
    assert.equal(recovered.task.status,"succeeded");
    assert.deepEqual(fixture.counters,{submits:1,queries:0,verified:1,settlements:1,reservations:1,attempts:1});
    assert.equal((await fixture.execute()).task.status,"succeeded");
    assert.equal(fixture.counters.submits,1);assert.equal(fixture.counters.settlements,1);
  }finally{await fixture.cleanup();}
});

test("local recovery requires an explicit media verifier and cannot refund or submit again",async()=>{
  const fixture=await interruptedResultFixture({receipt:false,verify:false});
  try{
    await assert.rejects(fixture.execute(),{code:"AI_CREDIT_RESULT_PENDING"});
    assert.equal(fixture.task.status,"running");
    assert.equal(fixture.counters.submits,1);assert.equal(fixture.counters.settlements,0);
  }finally{await fixture.cleanup();}
});

test("a rejected saved image stays held without querying or resubmitting upstream",async()=>{
  const fixture=await interruptedResultFixture();
  try{
    fixture.provider.verifySavedResult=async()=>{throw Object.assign(new Error("saved media hash differs"),{code:"AI_CREDIT_IMAGE_INVALID"});};
    await assert.rejects(fixture.execute(),{code:"AI_CREDIT_IMAGE_INVALID"});
    assert.equal(fixture.task.status,"running");assert.equal(fixture.task.charged_points,0);
    assert.equal(fixture.counters.submits,1);assert.equal(fixture.counters.queries,0);assert.equal(fixture.counters.settlements,0);
  }finally{await fixture.cleanup();}
});

test("private recovery rejects corrupt bytes or a changed task input and cannot expose another enterprise",async()=>{
  const fixture=await interruptedResultFixture({receipt:false});
  try{
    assert.equal(await fixture.resultStore.recover({...fixture.task,tenant_id:3}),null);
    await assert.rejects(fixture.resultStore.recover({...fixture.task,input_sha256:digest("changed input")}),{code:"AI_CREDIT_RESULT_INVALID"});
    await fs.writeFile(path.join(fixture.directory,"2",`${fixture.task.id}.json`),"damaged",{encoding:"utf8"});
    await assert.rejects(fixture.execute(),{code:"AI_CREDIT_RESULT_INVALID"});
    assert.equal(fixture.task.status,"running");assert.equal(fixture.counters.submits,1);assert.equal(fixture.counters.settlements,0);
  }finally{await fixture.cleanup();}
});

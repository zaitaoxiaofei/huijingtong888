import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createWorkflowNode } from '../src/shared/product-workflow.js';
import { advanceProductWorkflow, workflowTaskId } from '../src/services/product-workflow-execution.js';
import { createAiCreditLedger } from '../src/services/ai-credit-ledger.js';
import { aiCreditOperationKey, withAiCreditOperation } from '../src/services/ai-credit-provider-context.js';
import { createAiCreditSqlFixture, aiCreditSqlFixtureAvailable } from './helpers/ai-credit-sql-fixture.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_regeneration_fixture';process.env.DB_USER||='offline_fixture';
const { productWorkflowAction }=await import('../src/services/product-workflow-runner.js');
const { createProductWorkflowStore }=await import('../src/services/product-workflows.js');
const actor={personId:7,roles:['operations'],tenant:{id:2,slug:'fixture-enterprise',role:'member'}};

function fixture(t,type='image'){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.function('UTC_TIMESTAMP',()=>new Date().toISOString().slice(0,19).replace('T',' '));
  db.exec(`CREATE TABLE product_workflow_documents (tenant_id TEXT, id TEXT, kind TEXT, name TEXT, revision INTEGER, payload_json TEXT, created_by INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(tenant_id,id));
    CREATE TABLE product_workflow_jobs (tenant_id TEXT, run_id TEXT, person_id INTEGER, status TEXT, lease_token TEXT, lease_until TEXT, next_tick_at TEXT, error_message TEXT, PRIMARY KEY(tenant_id,run_id));`);
  const node=(kind,id,inputs=[])=>({...createWorkflowNode(kind,id),inputs});
  const definition={schemaVersion:1,name:'通用重新生成',globalPrompt:'已确认事实',nodes:[
    {...node('listing','catalog'),templateId:23},node('images','product'),
    {...node('image','main',['product']),role:'main'},node('approval','review',['main']),
    {...node(type,'target',type==='image'?['review']:type==='video'?['main']:[]),...(type==='copy'?{target:'text'}:{})},
    {...node('copy','dependent',['target']),target:'description'},{...node('field','unrelated'),required:false}
  ]};
  const outputs={v:{main:{status:'done',url:'https://fixture.invalid/main.png',approved:true},review:{approved:true},
    target:{status:'unknown',taskId:'original-task',submissionKey:'original-submission',error:'原任务待核对'},
    dependent:{status:'done',taskId:'dependent-task',submissionKey:'dependent-submission',text:{description:'Existing dependent output'},approved:true}},
    other:{target:{status:'done',url:'https://fixture.invalid/other-product.png',approved:true}}};
  const payload={definition,variants:[{id:'v',label:'当前产品',values:{product:['https://fixture.invalid/product.png']}},{id:'other',label:'其他产品',values:{product:['https://fixture.invalid/other.png']}}],outputs,executionMode:'background'};
  db.prepare('INSERT INTO product_workflow_documents (tenant_id,id,kind,name,revision,payload_json,created_by) VALUES (?,?,?,?,?,?,?)').run('2','run','run',definition.name,1,JSON.stringify(payload),7);
  db.prepare("INSERT INTO product_workflow_jobs (tenant_id,run_id,person_id,status) VALUES ('2','run',7,'awaiting_review')").run();
  const writes=[];let starts=0,taskReads=0,tail=Promise.resolve();
  function sql(sql){return sql.replace(/\s+FOR UPDATE/g,'').replace(/ON DUPLICATE KEY UPDATE/g,'ON CONFLICT(tenant_id,run_id) DO UPDATE SET').replace(/VALUES\((\w+)\)/g,'excluded.$1');}
  const query=async(statement,params=[])=>db.prepare(sql(statement)).all(...params);
  const execute=async(statement,params=[])=>{writes.push({sql:statement,params});return {affectedRows:Number(db.prepare(sql(statement)).run(...params).changes)};};
  const store=createProductWorkflowStore({authorize:async session=>session,loadCatalog:null,ensureSchema:async()=>{},query,execute});
  const transaction=work=>{const pending=tail.then(async()=>{db.exec('BEGIN');try{const value=await work({execute:async(statement,params)=>/^\s*SELECT/.test(statement)?[await query(statement,params)]:[await execute(statement,params)]});db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}});tail=pending.catch(()=>{});return pending;};
  const deps={store,transaction,ensureJobs:async()=>{},startRunner:async()=>{starts++;},tasks:async()=>{taskReads++;return {status:'reconciliation_required',error:{code:'AI_CREDIT_RECONCILIATION_REQUIRED'}};}};
  const get=()=>({id:'run',revision:db.prepare("SELECT revision FROM product_workflow_documents WHERE tenant_id='2' AND id='run'").get().revision,payload:JSON.parse(db.prepare("SELECT payload_json FROM product_workflow_documents WHERE tenant_id='2' AND id='run'").get().payload_json)});
  const change=work=>{const run=get();work(run.payload);db.prepare("UPDATE product_workflow_documents SET payload_json=? WHERE tenant_id='2' AND id='run'").run(JSON.stringify(run.payload));};
  const request=(extra={})=>({id:'run',action:'regenerate',variantId:'v',nodeId:'target',requestId:randomUUID(),expectedTaskId:'original-task',expectedSubmissionKey:'original-submission',confirmNewGeneration:true,...extra});
  return {db,deps,store,writes,get,change,request,get starts(){return starts;},get taskReads(){return taskReads;}};
}

for(const type of ['image','copy','video'])test(`explicit ${type} regeneration saves a new durable intent and displaced task audit without invoking AI`,async t=>{
  const f=fixture(t,type),before=f.get(),body=f.request();
  const record=await productWorkflowAction(body,actor,f.deps),state=record.payload.outputs.v.target;
  assert.equal(state.taskId,workflowTaskId('run','v','target',body.requestId));assert.notEqual(state.taskId,body.expectedTaskId);
  assert.equal(state.submissionKey,body.requestId);assert.equal(state.status,'resubmit');assert.equal(state.phase,'queued');assert.equal(state.approved,false);
  assert.equal(record.payload.outputs.v.dependent,undefined);assert.deepEqual(record.payload.outputs.v.main,before.payload.outputs.v.main);assert.deepEqual(record.payload.outputs.other,before.payload.outputs.other);
  const audit=record.payload.regenerationRequests[body.requestId];
  assert.deepEqual(audit.displacedTasks,[{nodeId:'target',taskId:'original-task',submissionKey:'original-submission'},{nodeId:'dependent',taskId:'dependent-task',submissionKey:'dependent-submission'}]);
  assert.equal(audit.previousTaskId,'original-task');assert.equal(audit.previousSubmissionKey,'original-submission');assert.equal(audit.newTaskId,state.taskId);assert.equal(audit.newSubmissionKey,state.submissionKey);assert.equal(audit.requestedBy,7);assert.ok(Number.isFinite(Date.parse(audit.requestedAt)));
  assert.equal(f.starts,1);assert.equal(f.taskReads,0);assert.ok(f.writes.every(write=>/product_workflow_(documents|jobs)/.test(write.sql)));
});

test('matching request replay is read-only even with a worker lease, while any reused request parameters conflict',async t=>{
  const f=fixture(t),body=f.request();await productWorkflowAction(body,actor,f.deps);
  const saved=f.get(),writes=f.writes.length,starts=f.starts;
  f.db.prepare("UPDATE product_workflow_jobs SET lease_token='active-worker',lease_until='2999-01-01 00:00:00'").run();
  assert.deepEqual((await productWorkflowAction({...body,requestId:body.requestId.toUpperCase()},actor,f.deps)).payload,saved.payload);
  assert.equal(f.writes.length,writes);assert.equal(f.starts,starts);
  for(const change of [{variantId:'other'},{nodeId:'main'},{expectedTaskId:'different-original'},{expectedSubmissionKey:'different-submission'},{confirmNewGeneration:false},{confirmNewGeneration:'true'}])await assert.rejects(productWorkflowAction({...body,...change},actor,f.deps),{status:409});
  assert.deepEqual(f.get(),saved);assert.equal(f.writes.length,writes);assert.equal(f.starts,starts);
});

test('concurrent request replay creates one intent; different requests against the same stale original cannot buy twice',async t=>{
  const f=fixture(t),body=f.request();
  const same=await Promise.all([productWorkflowAction(body,actor,f.deps),productWorkflowAction(body,actor,f.deps)]);
  assert.equal(same[0].payload.outputs.v.target.taskId,same[1].payload.outputs.v.target.taskId);assert.equal(f.starts,1);assert.equal(f.writes.length,2);
  const again=f.request();await assert.rejects(productWorkflowAction(again,actor,f.deps),{status:409});assert.equal(f.starts,1);assert.equal(f.writes.length,2);
});

test('a fresh request rejects malformed consent, incomplete old identity, active nodes and usable outputs before writes',async t=>{
  for(const extra of [{confirmNewGeneration:false},{confirmNewGeneration:'true'},{requestId:'not-a-uuid'},{expectedTaskId:null},{expectedSubmissionKey:undefined},{expectedTaskId:'stale-task'},{expectedSubmissionKey:'stale-submission'},{variantId:'unknown'},{nodeId:'unknown'}]){
    const f=fixture(t);await assert.rejects(productWorkflowAction(f.request(extra),actor,f.deps));assert.equal(f.writes.length,0);assert.equal(f.starts,0);
  }
  for(const status of ['running','submitting','queued','resubmit','done',undefined]){
    const f=fixture(t);f.change(payload=>{payload.outputs.v.target.status=status;});await assert.rejects(productWorkflowAction(f.request(),actor,f.deps),{status:409});assert.equal(f.writes.length,0);
  }
  for(const type of ['image','copy','video']){
    const f=fixture(t,type);f.change(payload=>{Object.assign(payload.outputs.v.target,type==='copy'?{text:{text:'Usable original copy'}}:{url:'https://fixture.invalid/original.png'});});
    await assert.rejects(productWorkflowAction(f.request(),actor,f.deps),{status:409});assert.equal(f.writes.length,0);
  }
  const material=fixture(t);material.change(payload=>{payload.definition.nodes.find(node=>node.id==='target').imageMode='material';});await assert.rejects(productWorkflowAction(material.request(),actor,material.deps),/不支持/);assert.equal(material.writes.length,0);
});

test('new regeneration keeps tenant, authorization, lease, archived and partial/import protections',async t=>{
  const leased=fixture(t);leased.db.prepare("UPDATE product_workflow_jobs SET lease_until='2999-01-01 00:00:00'").run();await assert.rejects(productWorkflowAction(leased.request(),actor,leased.deps),{status:409});assert.equal(leased.writes.length,0);
  for(const change of [payload=>{payload.archived=true;},payload=>{payload.draftId=77;},payload=>{payload.draftImportStatus='unknown';},payload=>{payload.completionReview={mode:'partial'};}]){
    const f=fixture(t);f.change(change);await assert.rejects(productWorkflowAction(f.request(),actor,f.deps));assert.equal(f.writes.length,0);
  }
  const foreign=fixture(t);await assert.rejects(productWorkflowAction(foreign.request(),{...actor,tenant:{id:3,slug:'other'}},foreign.deps),{status:404});assert.equal(foreign.writes.length,0);
  const denied=fixture(t);await assert.rejects(productWorkflowAction(denied.request(),{...actor,roles:['packing']},denied.deps));assert.equal(denied.writes.length,0);
});

test('original image recovery still requeues only its existing task and does not grant a new generation intent',async t=>{
  const f=fixture(t);await productWorkflowAction({id:'run',action:'retry',variantId:'v',nodeId:'target',recoverOnly:true},actor,f.deps);
  const state=f.get().payload.outputs.v.target;assert.equal(state.taskId,'original-task');assert.equal(state.submissionKey,'original-submission');assert.equal(state.status,'resubmit');assert.equal(f.get().payload.regenerationRequests,undefined);assert.equal(f.taskReads,1);
  let retried;
  await advanceProductWorkflow(f.get(),{findTask:async id=>{assert.equal(id,'original-task');return {status:'reconciliation_required'};},retryTask:async id=>{retried=id;},guard:async()=>{},createTask:async()=>{throw Error('recovery must not create a new task');}});
  assert.equal(retried,'original-task');
});

test('restart after task creation reuses the new intent and ignores a late result belonging to the abandoned original',async t=>{
  const f=fixture(t),body=f.request();await productWorkflowAction(body,actor,f.deps);
  const intent=f.get(),newId=intent.payload.outputs.v.target.taskId;intent.payload.variants=intent.payload.variants.filter(variant=>variant.id==='v');
  const tasks=new Map([['original-task',{status:'done',output:{url:'https://fixture.invalid/late-old-result.png'}}]]),reads=[];let creates=0;
  const deps={findTask:async id=>{reads.push(id);return tasks.get(id);},guard:async()=>{},createTask:async request=>{creates++;assert.equal(request.taskId,newId);assert.equal(request.resultId,body.requestId);assert.equal(request.workflowId,'run');tasks.set(newId,{status:'queued'});throw Error('fixture: response lost after durable task creation');},retryTask:async()=>{throw Error('must not retry the original task');}};
  await assert.rejects(advanceProductWorkflow(structuredClone(intent),deps),/response lost/);
  const restarted=JSON.parse(JSON.stringify(intent));assert.equal((await advanceProductWorkflow(restarted,deps)).status,'running');assert.equal(creates,1);
  tasks.set(newId,{status:'done',output:{url:'https://fixture.invalid/new-result.png'}});await advanceProductWorkflow(restarted,deps);
  assert.equal(restarted.payload.outputs.v.target.taskId,newId);assert.equal(restarted.payload.outputs.v.target.url,'https://fixture.invalid/new-result.png');assert.equal(creates,1);assert.ok(reads.every(id=>id===newId));
  assert.equal(tasks.get('original-task').output.url,'https://fixture.invalid/late-old-result.png');assert.equal(restarted.payload.regenerationRequests[body.requestId].previousTaskId,'original-task');
});

test('clients cannot forge or erase regeneration request receipts through run persistence',async t=>{
  const f=fixture(t),payload=f.get().payload;payload.regenerationRequests={};
  await assert.rejects(f.store.save('run',{payload},actor),/审计/);await assert.rejects(f.store.save('run',{id:'run',revision:1,payload},actor),/审计/);assert.equal(f.writes.length,0);
  await productWorkflowAction(f.request(),actor,f.deps);
  const saved=f.get(),stripped=structuredClone(saved.payload);delete stripped.regenerationRequests;delete stripped.executionMode;
  f.change(current=>{delete current.executionMode;});
  const writes=f.writes.length;await assert.rejects(f.store.save('run',{id:'run',revision:f.get().revision,payload:stripped},actor),/审计/);assert.equal(f.writes.length,writes);
});

test('new generation and a late original settlement remain separate from an unknown original credit hold', {skip:!aiCreditSqlFixtureAvailable}, async t=>{
  const database=createAiCreditSqlFixture();t.after(()=>database.close());database.seed();
  const ledger=createAiCreditLedger({transaction:database.transaction}),admin={personId:9,platform_role:'super_admin'};
  const billingActor={personId:7,tenant:{id:2,slug:'customer-a'}};
  await ledger.configureAccount(admin,{tenantId:2,status:'active'});await ledger.createPrice(admin,{priceKey:'image.generate',version:1,pointsPerResult:10});await ledger.recharge(admin,{tenantId:2,reference:'regeneration-fixture',points:100,reason:'Offline regression'});
  const key=taskNo=>withAiCreditOperation(`generation:${taskNo}`,()=>aiCreditOperationKey({},'image:0'));
  const reserve=taskNo=>ledger.reserve(billingActor,{idempotencyKey:key(taskNo),inputSha256:'a'.repeat(64),priceKey:'image.generate',results:1});
  const old=await reserve('original-task'),attempt=await ledger.startAttempt(billingActor,old.id,{attemptKey:'1',provider:'fixture',model:'fixture'});
  await ledger.recordOutcome(billingActor,old.id,{attemptId:attempt.id,outcome:'unknown',outcomeSha256:'b'.repeat(64)});
  const f=fixture(t),body=f.request();await productWorkflowAction(body,actor,f.deps);
  assert.equal((await ledger.task(billingActor,old.id)).status,'unknown');assert.equal(Number((await ledger.wallet(billingActor)).frozen_points),10);
  const replacement=await reserve(f.get().payload.outputs.v.target.taskId);assert.notEqual(old.id,replacement.id);
  const savedKeys=await database.query('SELECT idempotency_key FROM ai_credit_tasks ORDER BY id');assert.notEqual(savedKeys[0].idempotency_key,savedKeys[1].idempotency_key);
  assert.equal(Number((await ledger.wallet(billingActor)).frozen_points),20);assert.equal(Number((await ledger.task(billingActor,old.id)).charged_points),0);
  await ledger.recordOutcome(billingActor,old.id,{attemptId:attempt.id,outcome:'succeeded',verifiedStoredResult:true,successfulResults:1,resultReference:`credit-result:${old.id}`,resultSha256:'c'.repeat(64),outcomeSha256:'c'.repeat(64)});
  assert.equal((await ledger.task(billingActor,old.id)).status,'succeeded');assert.equal((await ledger.task(billingActor,replacement.id)).status,'reserved');assert.equal(Number((await ledger.wallet(billingActor)).frozen_points),10);
  assert.equal(f.get().payload.outputs.v.target.taskId,f.get().payload.regenerationRequests[body.requestId].newTaskId);assert.equal((await ledger.audit(billingActor)).consistent,true);
});

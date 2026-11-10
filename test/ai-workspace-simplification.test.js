import {settlementOverdue} from '../src/shared/settlement-overdue.js';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {workflowRunIdentity} from '../src/shared/workflow-run-identity.js';
import {authorizeApiRequest} from '../src/server/authorization.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='offline';process.env.DB_USER||='offline';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE product_workflow_documents (id TEXT NOT NULL,tenant_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,payload_json TEXT NOT NULL,created_by INTEGER NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(tenant_id,id))');
 db.function('JSON_UNQUOTE',value=>value===1?'true':value===0?'false':value);
 return createProductWorkflowStore({query:async(sql,p=[])=>db.prepare(sql).all(...p),execute:async(sql,p=[])=>({affectedRows:Number(db.prepare(sql).run(...p).changes)}),loadCatalog:null,ensureSchema:async()=>{},authorize:async s=>s});
}
const actor=id=>({personId:id,roles:['operations'],tenant:{id,slug:'company-'+id,role:'member'}});
for(const kind of ['prompt','optimization'])test(`${kind} records isolate enterprises, reject stale edits and archive without deleting other records`,async()=>{const store=fixture(),a=actor(11),b=actor(22),payload=kind==='prompt'?{name:'模板A',category:'main',prompt:'保留真实产品'}:{name:'商品A',fields:[{key:'main',value:'a.png'}]};const doc=await store.save(kind,{payload},a);assert.equal((await store.list(kind,a)).length,1);assert.equal((await store.list(kind,b)).length,0);await assert.rejects(store.get(kind,doc.id,b),{status:404});await assert.rejects(store.save(kind,{id:doc.id,revision:0,payload},a),{status:409});const other=await store.save(kind,{payload:{...payload,name:'企业B'}},b);await store.save(kind,{id:doc.id,revision:1,payload:{...payload,archived:true}},a);assert.equal((await store.list(kind,a)).length,0);assert.equal((await store.get(kind,other.id,b)).name,'企业B');});
test('invalid prompt category and empty record name fail before writes',async()=>{const store=fixture();await assert.rejects(store.save('prompt',{payload:{name:'x',category:'global_config',prompt:'x'}},actor(1)),/分类/);await assert.rejects(store.save('optimization',{payload:{name:''}},actor(1)),/名称/);});
test('run summary includes all actual per-variant fitments and tolerates historical missing metadata',()=>{assert.deepEqual(workflowRunIdentity(JSON.stringify([[{brand:'TENET',model:'T4'}],[[{brand:'TENET',model:'T8'},{brand:'HAVAL',model:'H9'}]]])),{brands:'TENET、HAVAL',models:'TENET T4、TENET T8、HAVAL H9'});assert.deepEqual(workflowRunIdentity(null),{brands:'未记录',models:'未记录'});assert.deepEqual(workflowRunIdentity('broken'),{brands:'未记录',models:'未记录'});});
test('new exact routes keep operations permission and existing customer AI pause boundaries',()=>{for(const endpoint of ['prompts','optimizations'])for(const method of ['GET','POST']){const parts=['api','product-workflows',endpoint];const internal={...actor(1),tenant:{id:1,slug:'default',role:'member'}};assert.equal(authorizeApiRequest({method,_session:internal},parts).allowed,true);assert.equal(authorizeApiRequest({method,_session:{...internal,roles:['packing']}},parts).allowed,false);assert.equal(tenantIsolationDecision(internal,parts,method).allowed,true);assert.equal(tenantIsolationDecision(actor(22),parts,method).allowed,method==='GET');}assert.equal(authorizeApiRequest({method:'DELETE',_session:actor(1)},['api','product-workflows','prompts']).allowed,false);});

test('settlement timeout excludes missing dates, the exact 30-day boundary and accrued items',()=>{
 const delivered='2026-10-01T00:00:00Z',boundary=Date.parse(delivered)+30*86400000;
 assert.equal(settlementOverdue({delivered_at:delivered,settlement_state:'pending'},boundary),false);
 assert.equal(settlementOverdue({delivered_at:delivered,settlement_state:'pending'},boundary+1),true);
 assert.equal(settlementOverdue({delivered_at:'2026-10-01 00:00:00',settlement_state:'pending'},boundary+1),true);
 assert.equal(settlementOverdue({delivered_at:delivered,profit_status:'accrued',settlement_state:'pending'},boundary+1),false);
 assert.equal(settlementOverdue({delivered_at:null,settlement_state:'pending'},boundary+1),false);
});

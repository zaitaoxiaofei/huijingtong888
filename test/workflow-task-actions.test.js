import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeApiRequest} from '../src/server/authorization.js';
import {tenantIsolationDecision} from '../src/server/tenant-isolation.js';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_test';process.env.DB_USER||='workflow_test';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');
const {productWorkflowAction}=await import('../src/services/product-workflow-runner.js');
const actor={personId:1,roles:['operations'],tenant:{id:2,slug:'example',role:'member'}};
test('production pagination counts the entire tenant result set and clamps the last page',async()=>{
 const calls=[];
 const store=createProductWorkflowStore({authorize:async s=>s,loadCatalog:null,ensureSchema:async()=>{},query:async(sql,params)=>{calls.push({sql,params});if(sql.includes('COUNT(*)'))return[{total:137}];return[{id:'one',name:'钥匙壳',revision:3,category_name:'保护套',product_label:'黑色',variant_count:1,fitments_json:JSON.stringify([{brand:'TENET',model:'PLUS L6'}]),draft_id:88}];}});
 const page=await store.list('run',actor,{page:99,pageSize:20,section:'results',keyword:'TENET'});
 assert.equal(page.total,137);assert.equal(page.page,7);assert.equal(page.items[0].models,'TENET PLUS L6');assert.equal(page.items[0].draft_id,88);
 assert.ok(calls.every(c=>c.params[0]==='2'&&c.sql.includes('$.archived')&&c.sql.includes('$.draftId')));assert.deepEqual(calls[1].params.slice(-2),[20,120]);assert.ok(calls[1].params.includes('%TENET%'));
});
test('template removal is tenant-scoped, optimistic and preserves the definition snapshot',async()=>{
 const payload={name:'original',nodes:[{id:'image'}]},writes=[];
 const store=createProductWorkflowStore({authorize:async s=>s,loadCatalog:null,ensureSchema:async()=>{},query:async()=>[{id:'template',name:'original',revision:2,payload_json:JSON.stringify(payload)}],execute:async(sql,params)=>{writes.push({sql,params});return{affectedRows:1};}});
 await assert.rejects(store.archiveTemplate({id:'template',revision:1},actor),/修改/);assert.equal(writes.length,0);
 await store.archiveTemplate({id:'template',revision:2},actor);assert.deepEqual(JSON.parse(writes[0].params[0]),{...payload,archived:true});assert.deepEqual(writes[0].params.slice(1),['2','template',2]);assert.ok(!writes[0].sql.includes('DELETE'));
});
function fixture({status='failed',busy=0,draftId=null,archived=false}={}){
 let payload={definition:{nodes:[]},variants:[],outputs:{},draftId,archived},revision=4;const writes=[];let starts=0;
 const connection={execute:async(sql,params)=>{if(sql.startsWith('SELECT *,'))return[[{status,busy}]];if(sql.startsWith('SELECT * FROM product_workflow_documents'))return[[{revision,payload_json:JSON.stringify(payload)}]];writes.push({sql,params});if(sql.startsWith('UPDATE product_workflow_documents')){payload=JSON.parse(params[0]);revision++;}return[{affectedRows:1}];}};
 const deps={store:{scope:async()=>({tenant:'2',actor}),get:async()=>({id:'run',payload,revision})},ensureJobs:async()=>{},transaction:async work=>work(connection),startRunner:async()=>{starts++;},tasks:async()=>{throw Error('must not call AI');}};
 return{deps,writes,get payload(){return payload;},get starts(){return starts;}};
}
test('completed production records can be removed without deleting the linked draft or AI assets',async()=>{
 const f=fixture({status:'imported',draftId:77});await productWorkflowAction({id:'run',action:'archive',revision:4},actor,f.deps);
 assert.equal(f.payload.archived,true);assert.equal(f.payload.draftId,77);assert.equal(f.starts,0);assert.equal(f.writes.length,2);assert.ok(f.writes.every(x=>!x.sql.includes('listing_drafts')&&!x.sql.includes('DELETE')));assert.match(f.writes[1].sql,/status = 'archived'/);
});
test('leased, running and stale production records refuse deletion before any write',async()=>{
 for(const config of [{status:'running'},{status:'queued'},{busy:1}]){const f=fixture(config);await assert.rejects(productWorkflowAction({id:'run',action:'archive',revision:4},actor,f.deps));assert.equal(f.writes.length,0);}
 const f=fixture();await assert.rejects(productWorkflowAction({id:'run',action:'archive',revision:3},actor,f.deps),/更新/);assert.equal(f.writes.length,0);
});
test('job-level failure can resume without clearing completed outputs or invoking AI synchronously',async()=>{
 const f=fixture();f.payload.outputs.v={main:{url:'existing.png',approved:true}};
 const result=await productWorkflowAction({id:'run',action:'start'},actor,f.deps);assert.equal(result.payload.outputs.v.main.url,'existing.png');assert.equal(f.starts,1);assert.match(f.writes[1].sql,/ON DUPLICATE KEY UPDATE/);
});

test('record deletion route is available only to tenant operators',()=>{
 assert.equal(authorizeApiRequest({method:'POST',_session:actor},['api','product-workflows','archive']).allowed,true);
 assert.equal(tenantIsolationDecision(actor,['api','product-workflows','archive'],'POST').allowed,true);
 assert.equal(authorizeApiRequest({method:'POST',_session:{...actor,roles:['packing']}},['api','product-workflows','archive']).allowed,false);
});

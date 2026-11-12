import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_unit_test';process.env.DB_USER||='workflow_unit_test';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');
const actor={personId:1,roles:['operations'],tenant:{id:1,slug:'default',role:'member'}};
test('library, export and legacy pickers search business fields instead of URL hosts or metadata',async()=>{
 const calls=[];
 const store=createProductWorkflowStore({authorize:async s=>s,loadCatalog:null,ensureSchema:async()=>{},query:async(sql,params)=>{calls.push({sql,params});return sql.includes('COUNT(*)')?[{total:0}]:[];}});
 for(const kind of ['library','mapping','material','key_model'])await store.list(kind,actor,{keyword:'TENET T8'});
 for(const {sql,params} of calls){
  assert.doesNotMatch(sql,/payload_json LIKE/);
  assert.match(sql,/\$\.searchTerms/);assert.match(sql,/\$\.bindings\[\*\]\.models/);assert.match(sql,/\$\.coreName/);
  assert.doesNotMatch(sql,/\$\.(?:images|sourceUrl|modelIds|purchaseProductIds)/);
  assert.match(sql,/LOWER\(.*LIKE LOWER\(\?\)/);assert.match(sql,/tenant_id = \?/);assert.equal(params[0],'admin');
  assert.equal((sql.match(/\?/g)||[]).length,params.length);
 }
 assert.ok(calls.some(x=>x.params.includes('%T8%')));assert.ok(calls.some(x=>x.params.includes('%TENET T8%')));
});
test('user keyword remains a bound parameter for the new search expression',async()=>{
 const input="TENET%' OR 1=1 --",calls=[];
 const store=createProductWorkflowStore({authorize:async s=>s,loadCatalog:null,ensureSchema:async()=>{},query:async(sql,p)=>{calls.push({sql,p});return [];}});
 await store.list('mapping',actor,{keyword:input});
 assert.ok(calls[0].p.some(x=>String(x).includes("TENET%'")));assert.ok(!calls[0].sql.includes(input));
});

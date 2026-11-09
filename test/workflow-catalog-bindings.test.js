import test from 'node:test';import assert from 'node:assert/strict';
import {resolveCatalogBindings,requireCatalogBindings,bindMaterialToCatalog} from '../src/shared/workflow-catalog-bindings.js';import {isReviewedMold} from '../src/shared/key-mold-mapping.js';import {normalizeWorkflowMaterial} from '../src/shared/workflow-key-models.js';
const brands=[{name:'TENET',key:'tenet',models:[{id:10,name:'PLUS L6'},{id:11,name:'L6'}]},{name:'HAVAL',key:'haval',models:[{id:20,name:'M6'}]}];
test('legacy full names resolve uniquely to real catalog model IDs, without fuzzy model-family inference',()=>{
 const r=resolveCatalogBindings([{brand:'TENET PLUS',models:['L6']}],brands);assert.deepEqual(r.bindings,[{brand:'TENET',brandKey:'tenet',models:['PLUS L6'],modelIds:[10],allModels:false}]);assert.deepEqual(r.unresolved,[]);
 assert.equal(resolveCatalogBindings([{brand:'HAVAL',models:['H6']}],brands).unresolved.length,1);assert.throws(()=>requireCatalogBindings([{brand:'TENET',models:['T7']}],brands),/系统目录/);
 assert.equal(resolveCatalogBindings([{brand:'TENET',models:[]}],brands).bindings[0].brand,'TENET');assert.throws(()=>requireCatalogBindings([{brand:'UNKNOWN',models:[]}],brands),/系统目录/);assert.throws(()=>resolveCatalogBindings({},brands),/格式无效/);assert.throws(()=>requireCatalogBindings([{brand:'HAVAL',models:['M6'],modelIds:[10]}],brands),/系统目录/);
});
test('directory IDs survive normalization and unsupported legacy bindings cannot become automatic matches',()=>{
 const p=normalizeWorkflowMaterial({name:'Test',notes:'reference',bindings:requireCatalogBindings([{brand:'TENET',models:['PLUS L6']}],brands)});assert.deepEqual(p.bindings[0].modelIds,[10]);
 const r=bindMaterialToCatalog({kind:'material',payload:{name:'Legacy',reviewStatus:'verified',bindings:[{brand:'TENET',models:['PLUS L6','T8']}]}},brands);assert.equal(r.payload.bindings[0].models.length,1);assert.equal(r.payload.unresolvedBindings.length,1);assert.equal(isReviewedMold(r),false);
});
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='workflow_unit_test';process.env.DB_USER||='workflow_unit_test';
const {createProductWorkflowStore}=await import('../src/services/product-workflows.js');const a={personId:1,roles:['operations'],tenant:{id:1,slug:'tenant-1',role:'member'}};
test('candidate lookup displays all pending matches but automatic production lookup excludes them',async()=>{
 const records=[1,2].map(i=>({id:String(i),kind:'material',name:'模具'+i,revision:1,payload_json:JSON.stringify({role:'compatibility',name:'模具'+i,reviewStatus:'pending',bindings:[{brand:'TENET PLUS',models:['L6']}],images:['https://example.test/'+i+'.png']})}));let params;
 const store=createProductWorkflowStore({authorize:async s=>s,loadCatalog:async()=>({brands}),ensureSchema:async()=>{},query:async(sql,p)=>{params=p;return records;}});
 const fits=[{brand:'TENET',model:'PLUS L6'}];assert.equal((await store.matchingKeys(fits,{},a)).length,0);const candidates=await store.matchingKeys(fits,{},a,{includePending:true});assert.equal(candidates.length,2);assert.equal(candidates[0].payload.bindings[0].modelIds[0],10);assert.ok(params.includes('TENET PLUS'));
});
test('backend rejects arbitrary text bindings and stores canonical directory references',async()=>{
 let values;const store=createProductWorkflowStore({authorize:async s=>s,loadCatalog:async()=>({brands}),ensureSchema:async()=>{},execute:async(sql,p)=>{values=p;return {affectedRows:1};}});
 await assert.rejects(store.save('material',{payload:{name:'x',notes:'reference',bindings:[{brand:'HAVAL',models:['H6']}]}},a),/系统目录/);
 await store.save('material',{payload:{name:'x',notes:'reference',bindings:[{brand:'TENET PLUS',models:['L6']}]}},a);assert.deepEqual(JSON.parse(values[4]).bindings[0].modelIds,[10]);await store.save('material',{payload:{name:'x',notes:'reference',brand:'TENET',model:'PLUS L6',bindings:[]}},a);assert.deepEqual(JSON.parse(values[4]).bindings,[]);assert.equal(JSON.parse(values[4]).brand,'');
});
test('library search combines category and full brand/model words, preserving SQL parameter order',async()=>{
 const calls=[];const store=createProductWorkflowStore({authorize:async s=>s,loadCatalog:async()=>({brands}),ensureSchema:async()=>{},query:async(sql,p)=>{calls.push({sql,p});return sql.includes('COUNT(*)')?[{total:0}]:[];}});
 await store.list('library',a,{keyword:'TENET PLUS L6',category:'1:2',brand:'TENET',model:'PLUS L6'});
 for(const {sql,p}of calls){assert.equal((sql.match(/\?/g)||[]).length,p.length);assert.ok(p.includes('%TENET%'));assert.ok(p.includes('%PLUS%'));assert.ok(p.includes('%L6%'));assert.ok(p.includes('TENET PLUS'));assert.ok(p.includes('1:2'));}
});

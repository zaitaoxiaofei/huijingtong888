import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogRoutes, handleCatalogRestRoute } from '../src/server/routes/catalog.js';
import { createListingAutomationRoutes } from '../src/server/routes/listingAutomation.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { authorizeApiRequest } from '../src/server/authorization.js';

const member=(slug='a',roles=['operations'])=>({personId:7,roles,tenant:{id:slug==='default'?15:2,slug,role:'member'}});
const parts=path=>['api',...path.split('/')];
const verified=[
  ['POST','products/import-preview'],['POST','products/import-commit'],
  ['POST','products/merge-preview'],['POST','products/merge'],['GET','products/merge-history'],
  ['POST','products/23/undo-merge'],['POST','products/23/add-to-inventory'],['POST','products/23/remove-from-inventory'],['DELETE','products/23'],
  ['POST','products/23/recalculate-profits'],['POST','products/23/force-recalculate-profits'],
  ['POST','online-products/bind'],['POST','online-products/create-product'],['GET','online-products/23/edit-draft'],['POST','online-products/action'],
  ['POST','listing/drafts/from-inventory-product'],
  ['GET','ai-variant-lab/vehicle-catalog'],['POST','ai-variant-lab/vehicle-catalog']
];

test('default ordinary staff and customer staff share only exact verified daily catalog gates',()=>{
  for(const slug of ['default','a']) {
    const session=member(slug);
    for(const [method,path]of verified) {
      assert.equal(tenantIsolationDecision(session,parts(path),method).allowed,true,`${slug} ${method} ${path}`);
      assert.equal(authorizeApiRequest({_session:session,method},parts(path)).allowed,true,`${slug} job ${method} ${path}`);
    }
    for(const [method,path]of [['POST','online-products'],['PUT','online-products/23/edit-draft'],['POST','products/23/undo-merge/extra'],['DELETE','products/not-a-number'],['POST','asset-variant-engine/generate'],['POST','asset-variant-engine/publish-selection'],['POST','listing/drafts/batch-publish']]) {
      assert.equal(tenantIsolationDecision(session,parts(path),method).allowed,false,`${slug} ${method} ${path}`);
    }
  }
  for(const [method,path]of verified)assert.equal(tenantIsolationDecision({personId:1,platform_role:'super_admin',roles:[]},parts(path),method).allowed,false,path);
});

test('daily online and inventory routes retain the job permission boundary',()=>{
  for(const slug of ['default','a']) {
    const procurement=member(slug,['procurement']),packing=member(slug,['packing']);
    for(const path of ['online-products/bind','online-products/create-product','listing/drafts/from-inventory-product']) {
      assert.equal(authorizeApiRequest({_session:procurement,method:'POST'},parts(path)).allowed,true,path);
      assert.equal(authorizeApiRequest({_session:packing,method:'POST'},parts(path)).allowed,false,path);
    }
    assert.equal(authorizeApiRequest({_session:procurement,method:'POST'},parts('online-products/action')).allowed,false);
    assert.equal(authorizeApiRequest({_session:member(slug),method:'POST'},parts('online-products/action')).allowed,true);
    assert.equal(authorizeApiRequest({_session:packing,method:'GET'},parts('online-products/23/edit-draft')).allowed,true);
    assert.equal(authorizeApiRequest({_session:member(slug),method:'POST'},parts('online-products/unverified-operation')).allowed,false);
    for(const roles of [['packing'],['technical']]) {
      assert.equal(authorizeApiRequest({_session:member(slug,roles),method:'GET'},parts('ai-variant-lab/vehicle-catalog')).allowed,true);
      assert.equal(authorizeApiRequest({_session:member(slug,roles),method:'POST'},parts('ai-variant-lab/vehicle-catalog')).allowed,false);
    }
    assert.equal(authorizeApiRequest({_session:procurement,method:'POST'},parts('ai-variant-lab/vehicle-catalog')).allowed,true);
  }
});

test('HTTP catalog adapters forward trusted enterprise and actor options including the runtime edit wrapper signature',async()=>{
  const calls=[];
  const services=new Proxy({}, {get:(_,name)=>(...args)=>{calls.push([name,args]);return {ok:true};}});
  const session=member();
  const req={method:'POST',_session:session,_abortSignal:{aborted:false},query:{filter:'own'}};
  const body={tenant_id:3,name:'fixture',online_product_id:23};
  const routes=createCatalogRoutes({services,readJson:async()=>body});
  for(const [path,method,tenantIndex,optionsIndex]of [
    ['products/import-commit','commitProductCsvImport',2,3],['products/merge','mergeProducts',1,2],
    ['online-products/bind','bindOnlineProduct',1,2],['online-products/action','performOnlineProductAction',2,3],['online-products/create-product','createProductFromOnlineProduct',1,2]
  ]) {
    await routes[`POST /api/${path}`](req);
    const [name,args]=calls.at(-1);assert.equal(name,method);assert.equal(args[tenantIndex],'2');assert.equal(args[optionsIndex].session,session);
    assert.equal(args[0].tenant_id,3,'body selector is data and never overrides trusted tenant');
  }
  await handleCatalogRestRoute({req:{...req,method:'GET'},parts:parts('online-products/23/edit-draft'),services,json:(_,value)=>value});
  assert.deepEqual(calls.at(-1),['onlineProductEditDraft',[23,{},session]]);
  await handleCatalogRestRoute({req,parts:parts('products/23/undo-merge'),services,json:(_,value)=>value});
  assert.equal(calls.at(-1)[1][1],'2');assert.equal(calls.at(-1)[1][2].session,session);
  const listing=createListingAutomationRoutes({services,readJson:async()=>body});
  await listing['POST /api/listing/drafts/from-inventory-product'](req);
  assert.equal(calls.at(-1)[1][1],session);
  await listing['GET /api/listing/draft-binding-options'](req);
  assert.deepEqual(calls.at(-1)[1],[req.query,session]);
});

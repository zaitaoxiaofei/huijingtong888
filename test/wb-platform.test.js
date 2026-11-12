import test from 'node:test';
import assert from 'node:assert/strict';
import { createWbClient } from '../src/services/wb-client.js';
import { wbOrderState, wbOrderCapabilities } from '../src/shared/wb-order-state.js';
import { createWbPlatform } from '../src/services/wb-platform.js';
import { createWbRoutes } from '../src/server/routes/wb.js';
import { wbRoutePermission } from '../src/server/wb-paths.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { oglCandidateIssue } from '../src/services/ogl-dispatch.js';

test('WB submission, physical acceptance, pickup and receipt remain distinct',()=>{
  assert.equal(wbOrderState('new','waiting').status,'awaiting_packaging');
  assert.equal(wbOrderState('confirm','waiting').label,'待交接');
  assert.equal(wbOrderState('complete','waiting').status,'awaiting_deliver');
  assert.equal(wbOrderState('complete','accepted_by_carrier').status,'delivering');
  assert.equal(wbOrderState('complete','ready_for_pickup').status,'delivering');
  assert.equal(wbOrderState('complete','sold').status,'delivered');
  assert.equal(wbOrderState('complete','canceled_by_client').status,'cancelled');
  assert.equal(wbOrderState('new','declined_by_client').status,'cancelled');
  assert.equal(wbOrderState('unrecognized','unrecognized').status,'wb_unknown');
  assert.equal(wbOrderCapabilities({wb_supplier_status:'new',wb_status:'waiting'}).splitPrepare,false);
  assert.equal(wbOrderCapabilities({wb_supplier_status:'new',wb_status:'declined_by_client'}).prepare,false);
  assert.equal(oglCandidateIssue({platform:'wb'}).code,'WRONG_PLATFORM');
});
test('WB client uses China regional hosts, isolates sandbox, and does not follow redirects',async()=>{
  const calls=[];const client=createWbClient({fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response('{}');},sleep:async()=>{}});
  const a={tenant_id:90,shop_id:901,token:'private-token',environment:'sandbox'};
  await client(a,'marketplace','/api/v3/orders/status',{method:'POST',body:{orders:[1]}});
  assert.equal(calls[0].url,'https://marketplace-api-sandbox.wildberries.cn/api/v3/orders/status');
  assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Authorization,'private-token');
  await assert.rejects(client(a,'calendar','/api/v1/calendar/promotions'),/沙箱/);
  await assert.rejects(client(a,'marketplace','//untrusted.invalid'),/地址无效/);
  await assert.rejects(client({...a,token:''},'marketplace','/ping'),/缺少 WB API/);
});
test('ambiguous WB writes are not automatically retried and do not echo tokens',async()=>{
  let calls=0;const client=createWbClient({fetchImpl:async()=>{calls++;throw Error('private-token');}});
  await assert.rejects(client({tenant_id:91,shop_id:911,token:'private-token'},'marketplace','/api/v3/supplies',{method:'POST',body:{name:'batch'}}),error=>error.code==='WB_RESULT_UNKNOWN'&&!error.message.includes('private-token'));
  assert.equal(calls,1);
});
test('WB rate-limit responses are surfaced rather than retried as writes',async()=>{
  let calls=0;const client=createWbClient({fetchImpl:async()=>{calls++;return new Response('{}',{status:429,headers:{'X-Ratelimit-Retry':'2'}});}});
  await assert.rejects(client({tenant_id:92,shop_id:921,token:'token'},'marketplace','/api/v3/supplies',{method:'POST'}),error=>error.statusCode===429);
  assert.equal(calls,1);
});
test('foreign shops fail before any WB request or token is used',async()=>{
  const calls=[];const service=createWbPlatform({query:async(sql,params)=>{calls.push({sql,params});return [];},transaction:async()=>{},request:async()=>assert.fail('foreign shop made a WB request')});
  await assert.rejects(service.syncProducts(2,{shop_id:30}),error=>error.statusCode===404);
  assert.deepEqual(calls[0].params,[2,2,30]);assert.match(calls[0].sql,/s\.tenant_id=\?/);
});
test('WB order batch ownership rejects partial matches before creating supplies',async()=>{
  let requests=0;const service=createWbPlatform({query:async()=>[{id:1,shop_id:20}],transaction:async()=>{},request:async()=>{requests++;}});
  await assert.rejects(service.prepare(2,{order_ids:[1,2]}),error=>error.statusCode===404);assert.equal(requests,0);
});
test('WB route permissions use exact paths and do not expose business capabilities through platform-only identity',()=>{
  const packing={roles:['packing'],tenant:{id:2,slug:'a',role:'member'}},ops={roles:['operations'],tenant:{id:2,slug:'a',role:'member'}};
  assert.equal(authorizeApiRequest({method:'POST',_session:packing},['api','wb','shops','save']).allowed,false);
  assert.equal(authorizeApiRequest({method:'POST',_session:packing},['api','wb','orders','prepare']).allowed,true);
  assert.equal(authorizeApiRequest({method:'POST',_session:ops},['api','wb','orders','prepare']).allowed,false);
  assert.equal(authorizeApiRequest({method:'POST',_session:ops},['api','wb','prices','set']).allowed,true);
  assert.equal(authorizeApiRequest({method:'POST',_session:{platform_role:'super_admin'}},['api','wb','prices','set']).allowed,false);
  assert.equal(wbRoutePermission(['api','wb','orders','prepare','anything'],'POST'),null);
  assert.equal(tenantIsolationDecision(ops,['api','wb','unknown'],'GET').allowed,false);
});
test('WB routes take tenant exclusively from a freshly authorized session',async()=>{
  const calls=[];const routes=createWbRoutes({readJson:async()=>({shop_id:20,tenant_id:3}),authorize:async()=>({personId:7,roles:['operations'],tenant:{id:2,slug:'a',role:'member'}}),platform:async()=>({syncProducts:async(...args)=>{calls.push(args);return {ok:true};}})});
  await routes['POST /api/wb/products/sync']({_session:{tenant:{id:999}}});
  assert.equal(calls[0][0],2);assert.equal(calls[0][1].tenant_id,3);
});

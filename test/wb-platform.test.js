import test from 'node:test';
import assert from 'node:assert/strict';
import { createWbClient } from '../src/services/wb-client.js';
import { wbOrderState, wbOrderCapabilities, wbOrderAmountCny } from '../src/shared/wb-order-state.js';
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
test('WB order pagination sends the exact cursor even above Number.MAX_SAFE_INTEGER', async () => {
  const cursor = '1795369077821535001';
  const sent = [];
  const client = createWbClient({
    fetchImpl: async url => {
      sent.push(url.searchParams.get('next'));
      return new Response(sent.length === 1
        ? `{"next":${cursor},"orders":[{"id":101}]}`
        : '{"next":0,"orders":[]}');
    },
    sleep: async () => {}
  });
  const account = { tenant_id: 93, shop_id: 931, token: 'test-only' };
  const first = await client(account, 'marketplace', '/api/v3/orders', { query: { next: 0 } });
  const last = await client(account, 'marketplace', '/api/v3/orders', { query: { next: first.next } });
  assert.deepEqual(sent, ['0', cursor]);
  assert.deepEqual(first.orders, [{ id: 101 }]);
  assert.equal(last.next, 0);
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
  const media = ['api','wb','orders','sync-media'];
  assert.equal(authorizeApiRequest({method:'POST',_session:ops},media).allowed,true);
  assert.equal(authorizeApiRequest({method:'POST',_session:packing},media).allowed,false);
  assert.equal(tenantIsolationDecision(ops,media,'POST').allowed,true);
});
test('WB routes take tenant exclusively from a freshly authorized session',async()=>{
  const calls=[];const routes=createWbRoutes({readJson:async()=>({shop_id:20,tenant_id:3}),authorize:async()=>({personId:7,roles:['operations'],tenant:{id:2,slug:'a',role:'member'}}),platform:async()=>({syncProducts:async(...args)=>{calls.push(args);return {ok:true};}})});
  await routes['POST /api/wb/products/sync']({_session:{tenant:{id:999}}});
  assert.equal(calls[0][0],2);assert.equal(calls[0][1].tenant_id,3);
});

test('WB official option directory has an operations read gate and no write alias',()=>{
 assert.equal(wbRoutePermission(['api','wb','catalog','options'],'GET'),'operations');assert.equal(wbRoutePermission(['api','wb','catalog','brands'],'GET'),'operations');assert.equal(wbRoutePermission(['api','wb','catalog','brands'],'POST'),null);
 assert.equal(wbRoutePermission(['api','wb','catalog','options'],'POST'),null);
});

test('WB cross-border labels use the official PDF endpoint and match orders by ID', async () => {
  const account = { tenant_id: 1, shop_id: 13, environment: 'production', checked_at: 'yes', seller_id: 'seller' };
  const orders = [101, 102].map((id, index) => ({
    id, shop_id: 13, wb_order_id: id + 10, supplier_status: 'confirm',
    raw_json: index ? '{"crossBorderType":1}' : { crossBorderType: 1 }
  }));
  let pending = false;
  const platform = createWbPlatform({
    query: async sql => sql.includes('FROM wb_shop_credentials') ? [account] : orders,
    request: async (_account, host, path, options) => {
      assert.equal(host, 'marketplace');
      assert.equal(path, '/api/v3/orders/stickers/cross-border');
      assert.deepEqual(options.body, { orders: [112, 111] });
      assert.equal(options.query, undefined);
      return { stickers: [
        { orderId: 111, status: 'ready', file: 'pdf-111' },
        { orderId: 112, status: pending ? 'awaitingTrackNumber' : 'ready', file: 'pdf-112' }
      ] };
    }
  });
  assert.deepEqual((await platform.stickers(1, { order_ids: [102, 101] })).rows, [
    { order_id: 102, format: 'pdf', file: 'pdf-112' },
    { order_id: 101, format: 'pdf', file: 'pdf-111' }
  ]);
  pending = true;
  await assert.rejects(platform.stickers(1, { order_ids: [102, 101] }), /等待承运商运单号/);
});

test('WB order amount uses the official converted CNY value and preserves real zero', () => {
  assert.equal(wbOrderAmountCny({ price: 72900, currencyCode: 643, convertedPrice: 5655, convertedCurrencyCode: 156 }), 56.55);
  assert.equal(wbOrderAmountCny({ convertedPrice: 0, convertedCurrencyCode: 156 }), 0);
  assert.equal(wbOrderAmountCny({ convertedPrice: 72900, convertedCurrencyCode: 643 }), null);
  assert.equal(wbOrderAmountCny({ convertedPrice: null, convertedCurrencyCode: 156 }), null);
});

test('WB order media refresh matches the exact shop product and modifies only the selected item', async () => {
  const writes = [];
  let requests = 0;
  let invalidations = 0;
  const service = createWbPlatform({
    query: async (sql, params) => {
      if (sql.includes('SELECT o.id,o.shop_id')) {
        return params[0] === 2 ? [{ id: 17, shop_id: 20, raw_json: { nmId: 200, chrtId: 300 } }] : [];
      }
      if (sql.includes('SELECT id,ozon_image_url')) {
        assert.deepEqual(params, [17, 'WB-300']);
        return [{ id: 27, ozon_image_url: 'https://example.com/old.jpg' }];
      }
      if (sql.includes('wb_shop_credentials')) {
        assert.deepEqual(params, [2, 2, 20]);
        return [{ tenant_id: 2, shop_id: 20 }];
      }
      if (sql.includes('SELECT raw_json FROM wb_product_cards')) return [];
      assert.match(sql, /SET i\.ozon_name=COALESCE\(\?,i\.ozon_name\),i\.ozon_image_url=COALESCE\(\?,i\.ozon_image_url\)/);
      assert.match(sql, /s\.platform='wb'/);
      writes.push(params);
      return { affectedRows: 1 };
    },
    request: async (account, service, path, options) => {
      requests++;
      assert.equal(account.shop_id, 20);
      assert.equal(service, 'content');
      assert.equal(path, '/content/v2/get/cards/list');
      assert.equal(options.body.settings.filter.textSearch, '200');
      return { cards: [
        { nmID: 201, title: 'Different product', photos: [{ big: 'https://example.com/wrong.jpg' }] },
        { nmID: 200, title: 'Correct title', photos: [{ big: 'https://example.com/right.jpg' }] }
      ] };
    },
    invalidate: () => { invalidations++; }
  });
  await assert.rejects(service.syncOrderMedia(3, { order_id: 17 }), { statusCode: 404 });
  await assert.rejects(service.syncOrderMedia(2, { order_id: 17, item_id: 28 }), { statusCode: 404 });
  assert.equal(requests, 0);
  assert.equal(writes.length, 0);
  const result = await service.syncOrderMedia(2, { order_id: 17, item_id: 27 });
  assert.equal(requests, 1);
  assert.equal(invalidations, 1);
  assert.deepEqual(writes, [['Correct title', 'https://example.com/right.jpg', 2, 20, 17, 27, 'WB-300']]);
  assert.deepEqual(result.items[0], { id: 27, ozon_sku: 'WB-300', product_name: 'Correct title',
    image_url: 'https://example.com/right.jpg', updated: true, error: null });
});

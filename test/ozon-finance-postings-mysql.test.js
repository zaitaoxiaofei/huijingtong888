import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('posting finance route is read-only, freshly authorized and isolated between enterprises', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async t => {
  const fixture = await createTenantMysqlFixture('fin_postings');fixture.useEnvironment();
  const q = fixture.query, originalFetch = globalThis.fetch;
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const { createFinanceCenterRoutes } = await import('../src/server/routes/financeCenter.js');
  const route = createFinanceCenterRoutes({ readJson: async req => req.body, services: {} })['POST /api/finance-center/ozon-posting-accruals'];
  const session = id => ({ personId: id, roles: ['operations'], tenant: { id, slug: id === 1 ? 'default' : `t${id}`, role: 'owner' } });
  const read = (body = { shop_id: 20, order_ids: [201] }, user = session(2), signal) => route({ body, _session: user, _abortSignal: signal });
  const calls = [];let onTypes = null, onReport = null, limitedReportOnce = false;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;assert.equal(new URL(url).origin, 'https://api-seller.ozon.ru');
    const body = JSON.parse(options.body);calls.push({ path, body, client: options.headers['Client-Id'] });
    if (path === '/v1/finance/accrual/types') {
      if (onTypes) await onTypes();
      return new Response(JSON.stringify({ accrual_types: [{ id: 1, name: 'Acquiring' }] }));
    }
    assert.equal(path, '/v1/finance/accrual/postings');
    if(limitedReportOnce){limitedReportOnce=false;return new Response(JSON.stringify({message:'quota'}),{status:429,headers:{'Retry-After':'1'}});}
    if (onReport) await onReport();
    const fee = { accrual_date: '2026-11-11', type_id: 1, accrued: { amount: '-2.50', currency: 'CNY' }, seller_price: { amount: '100', currency: 'CNY' }, quantity: 1, sku: 700 };
    return new Response(JSON.stringify({ posting_accruals: body.posting_numbers.map(posting_number => ({ posting_number, accruals: [fee,fee] })) }));
  };
  try {
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'t2','A'),(3,'t3','B')");
    for (const id of [1,2,3]) {
      await q("INSERT INTO people(id,name,role) VALUES(?,?,'operations')", [id, `Person ${id}`]);
      await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'owner',JSON_ARRAY('operations'))", [id,id]);
      await q("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,api_key_hint) VALUES(?,?,?,'active',?,?)", [id*10,id===1?null:id,`Shop ${id}`,`test-client-${id}`,`test-key-${id}`]);
      await q("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,'delivered','2026-11-10 00:00:00')", [id*100+1,id*10,`${id}22-111-1`]);
      await q('INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price,actual_profit) VALUES(?,?,?,?,?,?)', [id*1000+1,id*100+1,'700',1,100,88]);
      await q("INSERT INTO ozon_finance_items(shop_id,operation_id,posting_number,operation_date,service_type,amount_cny) VALUES(?,?,?,'2026-11-11','legacy-fee',?)", [id*10,`legacy-${id}`,`${id}22-111-1`,-id]);
    }
    const ledger = await q('SELECT * FROM ozon_finance_items ORDER BY id');
    const items = await q('SELECT * FROM order_items ORDER BY id');
    await t.test('real route returns named original fees without ledger, profit or sync-log changes', async () => {
      const result = await read({ shop_id: 20, order_ids: [201], tenant_id: 3 });
      assert.equal(result.shop_id,20);assert.equal(result.read_only,true);assert.deepEqual(result.rows[0].order_ids,[201]);
      assert.equal(result.rows[0].posting_number,'222-111-1');assert.equal(result.rows[0].accruals.length,2);
      assert.equal(result.rows[0].accruals[0].type_name,'Acquiring');assert.equal(result.rows[0].accruals[0].accrued.amount,'-2.50');
      assert.deepEqual(calls.map(call=>call.path),['/v1/finance/accrual/types','/v1/finance/accrual/postings']);assert.ok(calls.every(call=>call.client==='test-client-2'));
      assert.deepEqual(await q('SELECT * FROM ozon_finance_items ORDER BY id'),ledger);assert.deepEqual(await q('SELECT * FROM order_items ORDER BY id'),items);
      assert.equal((await q('SELECT COUNT(*) n FROM sync_logs'))[0].n,0);
    });
    await t.test('a transient report quota retries the identical authorized read without financial writes', async () => {
      calls.length=0;limitedReportOnce=true;
      const result=await read();assert.equal(result.rows[0].accruals.length,2);assert.equal(calls.length,3);
      assert.deepEqual(calls[1].body,calls[2].body);
      assert.deepEqual(await q('SELECT * FROM ozon_finance_items ORDER BY id'),ledger);assert.deepEqual(await q('SELECT * FROM order_items ORDER BY id'),items);
    });
    await t.test('foreign shop/order and mixed order selections fail before any provider read', async () => {
      for (const body of [{shop_id:30,order_ids:[301]},{shop_id:20,order_ids:[301]},{shop_id:20,order_ids:[201,301]}]) {
        calls.length=0;await assert.rejects(read(body),error=>error.statusCode===404);assert.equal(calls.length,0);
      }
    });
    await t.test('default NULL ownership works only inside its existing active enterprise', async () => {
      calls.length=0;const result=await read({shop_id:10,order_ids:[101]},session(1));assert.equal(result.rows[0].posting_number,'122-111-1');
      assert.ok(calls.every(call=>call.client==='test-client-1'));
      calls.length=0;await assert.rejects(read({shop_id:10,order_ids:[101]}),error=>error.statusCode===404);assert.equal(calls.length,0);
    });
    await t.test('revoked membership, spoofed authority and expired subscription do not read Ozon', async () => {
      calls.length=0;
      await q("UPDATE tenant_members SET role='member' WHERE tenant_id=2 AND person_id=2");
      await assert.rejects(read(undefined,{...session(2),platform_role:'super_admin'}),error=>error.statusCode===403);assert.equal(calls.length,0);
      await q("UPDATE tenant_members SET role='owner',active=0 WHERE tenant_id=2 AND person_id=2");
      await assert.rejects(read(),error=>error.statusCode===403);assert.equal(calls.length,0);
      await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      await q("UPDATE tenants SET subscription_status='expired' WHERE id=2");
      await assert.rejects(read(),error=>error.statusCode===403);assert.equal(calls.length,0);
      await q("UPDATE tenants SET subscription_status='active' WHERE id=2");
    });
    await t.test('forged default context, disabled stores, missing keys and other platforms never contact Ozon', async () => {
      calls.length=0;
      await assert.rejects(read(undefined,{...session(2),tenant:{id:2,slug:'default',role:'owner'}}),error=>error.statusCode===403);
      await q("UPDATE shops SET status='disabled' WHERE id=20");await assert.rejects(read(),error=>error.statusCode===404);
      await q("UPDATE shops SET status='active',api_key_hint='' WHERE id=20");await assert.rejects(read(),error=>error.statusCode===409);
      await q("UPDATE shops SET api_key_hint='test-key-2' WHERE id=20");
      const columns=await q("SHOW COLUMNS FROM shops LIKE 'platform'");
      if(!columns.length)await q('ALTER TABLE shops ADD COLUMN platform VARCHAR(32) NULL');
      await q("UPDATE shops SET platform='wb' WHERE id=20");await assert.rejects(read(),error=>error.statusCode===409);
      await q("UPDATE shops SET platform='ozon' WHERE id=20");assert.equal(calls.length,0);
    });
    await t.test('revocation or key rotation after type lookup blocks the report request', async () => {
      calls.length=0;onTypes=()=>q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      await assert.rejects(read(),error=>error.statusCode===403);assert.equal(calls.length,1);
      await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2');
      calls.length=0;onTypes=()=>q("UPDATE shops SET api_key_hint='rotated' WHERE id=20");
      await assert.rejects(read(),error=>error.statusCode===409);assert.equal(calls.length,1);
      await q("UPDATE shops SET api_key_hint='test-key-2' WHERE id=20");onTypes=null;
    });
    await t.test('order ownership changed during the response prevents any returned private report', async () => {
      calls.length=0;onReport=()=>q('UPDATE orders SET shop_id=30 WHERE id=201');
      await assert.rejects(read(),error=>error.statusCode===404);assert.equal(calls.length,2);
      await q('UPDATE orders SET shop_id=20 WHERE id=201');onReport=null;
    });
    await t.test('write flags and cancelled requests fail without provider or ledger mutations', async () => {
      calls.length=0;await assert.rejects(read({shop_id:20,order_ids:[201],write:true}),error=>error.statusCode===400);
      const controller=new AbortController();controller.abort(Error('cancelled'));await assert.rejects(read(undefined,session(2),controller.signal),/cancelled/);
      assert.equal(calls.length,0);assert.deepEqual(await q('SELECT * FROM ozon_finance_items ORDER BY id'),ledger);assert.deepEqual(await q('SELECT * FROM order_items ORDER BY id'),items);
    });
  } finally { globalThis.fetch=originalFetch;await closeMysqlPool();await fixture.cleanup(); }
});

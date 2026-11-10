import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createOrderBindingIgnoreService } from '../src/services/order-binding-ignore.js';
import { buildProductDisplayRows, inventoryBindingReminders } from '../frontend/orders/utils/order-display.js';
import { loadTenantOrderService } from './helpers/tenant-order-service.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { handleOrderRestRoute } from '../src/server/routes/orders.js';
import { authorizeApiRequest } from '../src/server/authorization.js';

function fixture({ owned = true, denied = false, failSchema = false } = {}) {
  const writes = [], marks = new Set();
  let invalidations = 0, schemas = 0;
  const service = createOrderBindingIgnoreService({
    scope: async (tenant, options) => {
      assert.equal(tenant, 2);
      if (denied) throw Object.assign(Error('denied'), { statusCode: 403 });
      return { id: 2 };
    },
    predicate: (alias, tenant) => `${alias}.tenant_id = ${tenant.id}`,
    query: async (sql, params) => {
      assert.match(sql, /JOIN shops s/);
      assert.match(sql, /s.tenant_id = 2/);
      assert.deepEqual(params, [10, 'sku-a']);
      return owned ? [{ id: 11 }] : [];
    },
    person: async user => { assert.equal(user, 7); return 7; },
    execute: async (sql, params) => {
      if (sql.trim().startsWith('CREATE')) {
        schemas++;
        if (failSchema && schemas === 1) throw Error('schema unavailable');
        return;
      }
      writes.push({ sql, params });
      const key = params.slice(0, 3).join(':');
      if (sql.startsWith('INSERT')) marks.add(key); else marks.delete(key);
    },
    invalidate: () => invalidations++
  });
  return { service, writes, marks, get invalidations() { return invalidations; }, get schemas() { return schemas; } };
}

test('dismissal is persistent and idempotent for this tenant/order/SKU, and restore invalidates counts', async () => {
  const f = fixture();
  const body = { ozon_sku: 'sku-a', ignored: true, tenant_id: 999, order_id: 99 };
  await f.service.set(10, body, 7, 2);
  await f.service.set(10, body, 7, 2);
  assert.deepEqual([...f.marks], ['2:10:sku-a']);
  assert.deepEqual(f.writes[0].params, [2, 10, 'sku-a', 7]);
  assert.ok(f.writes.every(write => !/UPDATE (orders|order_items|products|sku_mappings)|inventory_movements|inbound_records/.test(write.sql)));
  await f.service.set(10, { ozon_sku: 'sku-a', ignored: false }, 7, 2);
  assert.equal(f.marks.size, 0);
  assert.equal(f.invalidations, 3);
  assert.equal(f.schemas, 1);
});

test('foreign or missing orders and unauthorized users cannot create or delete dismissals', async () => {
  for (const ignored of [true, false]) {
    for (const [options, status] of [[{ owned: false }, 404], [{ denied: true }, 403]]) {
      const f = fixture(options);
      await assert.rejects(f.service.set(10, { ozon_sku: 'sku-a', ignored }, 7, 2), { statusCode: status });
      assert.equal(f.writes.length, 0);
      assert.equal(f.schemas, 0);
    }
  }
});

test('malformed IDs/SKUs and ambiguous action values fail before database writes', async () => {
  const f = fixture();
  for (const [id, body] of [[0, { ozon_sku: 'sku-a', ignored: true }], [10, { ignored: true }], [10, { ozon_sku: 'sku-a', ignored: 'false' }], [10, { ozon_sku: 'x'.repeat(129), ignored: false }]]) {
    await assert.rejects(f.service.set(id, body, 7, 2), { statusCode: 400 });
  }
  assert.equal(f.writes.length, 0);
});

test('schema errors can be retried without falsely caching success', async () => {
  const f = fixture({ failSchema: true });
  await assert.rejects(f.service.ensure(), /schema unavailable/);
  await f.service.ensure();
  assert.equal(f.schemas, 2);
});

test('display keeps physical unbound truth while cancelled and ignored reminders disappear', () => {
  const products = buildProductDisplayRows({ skus: 'sku-a,sku-b,sku-c', unbound_skus: 'sku-a,sku-b', binding_ignored_skus: 'sku-a', sku_product_ids: 'sku-c:4' });
  const active = inventoryBindingReminders(products);
  assert.deepEqual(active.unboundItems.map(item => item.sku), ['sku-b']);
  assert.deepEqual(active.ignoredBindingItems.map(item => item.sku), ['sku-a']);
  assert.equal(products[0].unbound, true);
  assert.equal(products[0].productId, 0);
  assert.equal(inventoryBindingReminders(products, true).unboundItems.length, 0);
  const restored = buildProductDisplayRows({ skus: 'sku-a', unbound_skus: 'sku-a' });
  assert.equal(inventoryBindingReminders(restored).unboundItems.length, 1);
});

test('list and optimized count SQL agree on cancellations, partial dismissals and other shops', () => {
  const { service } = loadTenantOrderService({ query: async () => [[]] });
  const scope = { id: 2, defaultTenant: false };
  const predicate = service.orderStatusSqlMysql('unbound', null, scope);
  const evidence = service.orderPagedUnboundEvidenceJoinMysql(scope);
  // Execute the actual portable WHERE/JOIN SQL against an in-memory database.
  // Python supplies MySQL CONCAT/REGEXP equivalents; no production connection.
  const run = spawnSync('python3', ['-c', `
import sys,json,sqlite3,re
p=json.load(sys.stdin)
c=sqlite3.connect(':memory:')
c.create_function('CONCAT',-1,lambda *v: ''.join(str(x) for x in v))
c.create_function('REGEXP',2,lambda pattern,value:bool(re.search(pattern,value or '')))
c.executescript('''
CREATE TABLE orders(id INTEGER,shop_id INTEGER,status TEXT,tracking_stage TEXT,logistics_status TEXT);
CREATE TABLE shops(id INTEGER,tenant_id INTEGER);
CREATE TABLE order_items(id INTEGER,order_id INTEGER,ozon_sku TEXT,sku_mapping_id INTEGER,quantity INTEGER);
CREATE TABLE sku_mappings(id INTEGER,shop_id INTEGER,ozon_sku TEXT,product_id INTEGER,active INTEGER,tenant_id INTEGER);
CREATE TABLE products(id INTEGER,active INTEGER,tenant_id INTEGER);
CREATE TABLE order_inventory_binding_ignores(tenant_id INTEGER,order_id INTEGER,ozon_sku TEXT);
INSERT INTO shops VALUES(1,2),(2,3);
INSERT INTO orders VALUES(1,1,'awaiting_packaging','',''),(2,1,'cancelled','',''),(3,1,'awaiting_packaging','posting_canceled',''),(4,1,'awaiting_packaging','','returning'),(5,1,'awaiting_packaging','',''),(6,1,'awaiting_packaging','',''),(7,1,'awaiting_packaging','',''),(8,1,'awaiting_packaging','',''),(9,1,'awaiting_packaging','',''),(10,2,'awaiting_packaging','',''),(11,1,'awaiting_packaging','','');
INSERT INTO order_items VALUES(1,1,'a',NULL,1),(2,1,'b',NULL,1),(3,2,'a',NULL,1),(4,3,'a',NULL,1),(5,4,'a',NULL,1),(6,5,'a',NULL,1),(7,6,'a',NULL,1),(8,7,'c',1,1),(9,8,'d',2,1),(10,9,'a',NULL,0),(11,10,'a',NULL,1),(12,11,'a',NULL,1);
INSERT INTO products VALUES(1,1,2),(2,0,2);
INSERT INTO sku_mappings VALUES(1,1,'c',1,1,2),(2,1,'d',2,1,2);
INSERT INTO order_inventory_binding_ignores VALUES(2,1,'a'),(2,5,'a'),(3,11,'a');
''')
def ids():
 normal=[v[0] for v in c.execute('SELECT o.id FROM orders o JOIN shops s ON s.id=o.shop_id WHERE s.tenant_id=2 AND '+p['predicate']+' ORDER BY o.id')]
 optimized=[v[0] for v in c.execute('SELECT o.id FROM orders o '+p['evidence']+' WHERE o.shop_id=1 AND unbound_count_evidence.order_id IS NOT NULL ORDER BY o.id')]
 assert normal==optimized,(normal,optimized)
 return normal
assert ids()==[1,6,8,11],ids()
c.execute("INSERT INTO order_inventory_binding_ignores VALUES(2,1,'b')")
assert ids()==[6,8,11],ids()
c.execute("DELETE FROM order_inventory_binding_ignores WHERE tenant_id=2 AND order_id=1 AND ozon_sku='a'")
assert ids()==[1,6,8,11],ids()
print('ok')
`], { input: JSON.stringify({ predicate, evidence }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'ok');
});

test('REST forwards authenticated tenant/person and opens only the precise tenant route', async () => {
  const tenant = { tenant: { id: 2, slug: 'customer' } };
  assert.equal(tenantIsolationDecision(tenant, ['api','orders','10','binding-ignore'], 'PUT').allowed, true);
  assert.equal(tenantIsolationDecision(tenant, ['api','orders','10','binding-ignore','extra'], 'PUT').allowed, false);
  const session = { ...tenant, personId: 7 };
  let args;
  await handleOrderRestRoute({ req: { method: 'PUT', _session: session }, res: {}, parts: ['api','orders','10','binding-ignore'], url: new URL('http://localhost/api/orders/10/binding-ignore'), readJson: async () => ({ ozon_sku: 'sku-a', ignored: true }), services: { updateOrderBindingIgnore: async (...v) => { args=v; return {ok:true}; } }, json: (_, value) => value });
  assert.equal(args[0], 10);
  assert.equal(args[2], 7);
  assert.equal(args[3], '2');
  assert.equal(args[4].session, session);
});

test('read-only and packing roles cannot dismiss another operator inventory binding task', () => {
  const parts = ['api', 'orders', '10', 'binding-ignore'];
  for (const role of ['packing', 'finance']) {
    assert.equal(authorizeApiRequest({ method: 'PUT', _session: { roles: [role], tenant: { id: 2, slug: 'customer' } } }, parts).allowed, false);
  }
  assert.equal(authorizeApiRequest({ method: 'PUT', _session: { roles: ['operations'], tenant: { id: 2, slug: 'customer' } } }, parts).allowed, true);
});

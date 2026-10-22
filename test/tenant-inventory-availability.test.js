import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { loadOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';

test('reviewed inventory availability and procurement ledger reads require an exact route and enterprise context', () => {
  for (const tenant of [{ id: 19, slug: 'another-business' }, { id: 1, slug: 'default' }]) {
    const session = { tenant };
    for (const parts of [['api', 'inventory', 'availability'], ['api', 'procurement', 'ledger']]) {
      assert.equal(tenantIsolationDecision(session, parts, 'GET').allowed, true);
      assert.equal(tenantIsolationDecision({}, parts, 'GET').allowed, false);
      assert.equal(tenantIsolationDecision(session, [...parts, 'extra'], 'GET').allowed, false);
      assert.equal(tenantIsolationDecision(session, parts, 'DELETE').allowed, false);
    }
  }
  const route = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(route, /productInventoryAvailability\(req\.query \|\| \{\}, tenantIdFromRequest\(req\)\)/);
});

function coverageQuery(tenant, productIds = [10]) {
  const calls = [];
  return { calls, query: async (statement, params = []) => {
    calls.push({ statement, params });
    if (/SELECT id, slug FROM tenants/.test(statement)) return tenant ? [tenant] : [];
    if (/^SELECT id FROM products WHERE/.test(statement)) return productIds.map(id => ({ id }));
    return [];
  } };
}

test('scoped coverage limits order and movement queries to the requested enterprise', async () => {
  const { calls, query } = coverageQuery({ id: 19, slug: 'another-business' });
  await loadOrderProcurementCoverage(query, '', { productIds: [10], tenantId: 19, includeLegacyTenantNull: true, fresh: true });
  assert.deepEqual(calls[0].params, [19]);
  assert.match(calls[1].statement, /WHERE \(tenant_id = \?\) AND id IN \(10\)/);
  assert.deepEqual(calls[1].params, [19]);
  const sql = calls.slice(2).map(call => call.statement);
  const demands = sql.find(statement => statement.includes('FROM orders o JOIN order_items oi'));
  assert.match(demands, /tenant_shop\.tenant_id = 19/);
  assert.match(demands, /direct_mapping\.tenant_id = 19/);
  assert.match(demands, /direct_mapping\.shop_id = o\.shop_id/);
  assert.match(demands, /cp\.tenant_id = 19/);
  assert.match(demands, /product_id IN \(10\)/);
  assert.ok(sql.some(statement => /FROM inventory_movements/.test(statement) && /tenant_id = 19/.test(statement)));
  assert.ok(sql.every(statement => !/tenant_id IS NULL/.test(statement)), 'caller cannot opt a customer into default legacy ownership');
  const foreign = coverageQuery({ id: 19, slug: 'another-business' }, []);
  assert.equal((await loadOrderProcurementCoverage(foreign.query, '', { productIds: [99], tenantId: 19 })).size, 0);
  assert.equal(foreign.calls.length, 2, 'unowned product IDs must not reach order or movement queries');
  const inactive = coverageQuery(null);
  await assert.rejects(loadOrderProcurementCoverage(inactive.query, '', { productIds: [10], tenantId: 19 }), { statusCode: 403 });
  assert.equal(inactive.calls.length, 1, 'inactive or unknown tenants must fail before loading products');
});

test('default coverage includes only its tenant ID and legacy NULL rows across order, mapping and stock', async () => {
  const { calls, query } = coverageQuery({ id: 1, slug: 'default' });
  await loadOrderProcurementCoverage(query, '', { productIds: [10], tenantId: 1, includeLegacyTenantNull: false, fresh: true });
  assert.match(calls[1].statement, /WHERE \(tenant_id = \? OR tenant_id IS NULL\) AND id IN \(10\)/);
  assert.deepEqual(calls[1].params, [1]);
  const sql = calls.slice(2).map(call => call.statement);
  const demands = sql.find(statement => statement.includes('FROM orders o JOIN order_items oi'));
  assert.match(demands, /tenant_shop\.tenant_id = 1 OR tenant_shop\.tenant_id IS NULL/);
  assert.match(demands, /direct_mapping\.tenant_id = 1 OR direct_mapping\.tenant_id IS NULL/);
  assert.match(demands, /cp\.tenant_id = 1 OR cp\.tenant_id IS NULL/);
  assert.match(demands, /product_id IN \(10\).*tenant_id = 1 OR tenant_id IS NULL/s);
  assert.ok(sql.some(statement => /FROM inventory_movements/.test(statement)
    && /tenant_id = 1 OR tenant_id IS NULL/.test(statement)));
  const deductions = sql.find(statement => statement.includes('FROM inventory_movements im'));
  assert.match(deductions, /im\.tenant_id = 1 OR im\.tenant_id IS NULL/);
  const fbp = sql.find(statement => statement.includes('FROM fbp_replenishment_order_items i'));
  assert.match(fbp, /reservation_shop\.tenant_id = 1 OR reservation_shop\.tenant_id IS NULL/);
  const requests = sql.find(statement => statement.includes('FROM procurement_requests WHERE'));
  assert.match(requests, /tenant_id = 1 OR tenant_id IS NULL/);
  const other = coverageQuery({ id: 19, slug: 'another-business' });
  await loadOrderProcurementCoverage(other.query, '', { productIds: [10], tenantId: 19, fresh: true });
  const otherSql = other.calls.map(call => call.statement);
  assert.ok(otherSql.every(statement => !/tenant_id IS NULL/.test(statement)));
});

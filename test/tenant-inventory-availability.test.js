import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { loadOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';

test('non-default tenants cannot enter the incomplete inventory availability read chain', () => {
  const session = { tenant: { id: 19, slug: 'another-business' } };
  assert.equal(tenantIsolationDecision(session, ['api', 'inventory', 'availability'], 'GET').allowed, false);
  assert.equal(tenantIsolationDecision(session, ['api', 'procurement', 'ledger'], 'GET').allowed, false);
  const route = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(route, /productInventoryAvailability\(req\.query \|\| \{\}, tenantIdFromRequest\(req\)\)/);
});

test('scoped coverage limits order and movement queries to the requested enterprise', async () => {
  const sql = [];
  await loadOrderProcurementCoverage(async statement => { sql.push(statement); return []; }, '',
    { productIds: [10], tenantId: 19, fresh: true });
  assert.match(sql[0], /tenant_shop\.tenant_id = 19/);
  assert.match(sql[0], /direct_mapping\.tenant_id = 19/);
  assert.match(sql[0], /cp\.tenant_id = 19/);
  assert.match(sql[0], /product_id IN \(10\)/);
  assert.ok(sql.some(statement => /FROM inventory_movements/.test(statement) && /tenant_id = 19/.test(statement)));
  await assert.rejects(loadOrderProcurementCoverage(async () => [], '', { tenantId: 19, fresh: true }), /指定库存商品 ID/);
});

test('default coverage includes only its tenant ID and legacy NULL rows across order, mapping and stock', async () => {
  const sql = [];
  await loadOrderProcurementCoverage(async statement => { sql.push(statement); return []; }, '',
    { productIds: [10], tenantId: 1, includeLegacyTenantNull: true, fresh: true });
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
  const otherSql = [];
  await loadOrderProcurementCoverage(async statement => { otherSql.push(statement); return []; }, '',
    { productIds: [10], tenantId: 19, fresh: true });
  assert.ok(otherSql.every(statement => !/tenant_id IS NULL/.test(statement)));
});

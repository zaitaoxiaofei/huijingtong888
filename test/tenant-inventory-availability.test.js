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

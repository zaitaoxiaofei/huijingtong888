import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcurementLedgerService, planLedgerAction } from '../src/services/procurement-ledger.js';
import { createOperationsRoutes } from '../src/server/routes/operations.js';

test('initial stocktake creates a cost check for counted goods, never for historical negative balance', () => {
  const snapshot = { product: { id: 10 }, revision: 'v', physical_estimate: -40, stocktake_id: 0 };
  const body = { revision: 'v', action_type: 'stocktake', counted_quantity: 10, reason: '实物清点确认' };
  assert.equal(planLedgerAction(snapshot, body).cost_task_quantity, 10);
  assert.equal(planLedgerAction(snapshot, body).local_delta, 50);
  assert.equal(planLedgerAction({ ...snapshot, physical_estimate: 10, stocktake_id: 1 }, body).cost_task_quantity, 0);
  assert.equal(planLedgerAction({ ...snapshot, physical_estimate: 8, stocktake_id: 1 }, body).cost_task_quantity, 2);
  assert.equal(planLedgerAction(snapshot, { ...body, counted_quantity: 0 }).cost_task_quantity, 0);
});

test('cost-only purchases cannot turn a cost task into incoming stock and keep the actual stocktake date', () => {
  const snapshot = { product: { id: 10 }, revision: 'v', cost_tasks: [{ id: 7, quantity: 10, resolved_quantity: 0, created_at: '2026-09-20 00:00:00' }] };
  const body = { revision: 'v', action_type: 'record_purchase', reason: '补盘点现货凭证', cost_task_id: 7,
    quantity: 10, amount: 200, inventory_effect: 'already_accounted', purchased_at: '2026-08-01T00:00:00+08:00' };
  const plan = planLedgerAction(snapshot, body);
  assert.equal(plan.local_delta, 0);
  assert.equal(plan.counted_at, '2026-09-20 00:00:00');
  assert.throws(() => planLedgerAction(snapshot, { ...body, inventory_effect: 'missing_inbound' }), /不得重复入库/);
  assert.throws(() => planLedgerAction(snapshot, { ...body, inventory_effect: 'in_transit' }), /不得重复入库/);
});

test('cost task list is read-only, bounded, searchable, and does not depend on active purchase requests', async () => {
  const statements = [];
  const service = createProcurementLedgerService({ prepare: async () => {}, query: async (sql, args) => {
    statements.push({ sql, args });
    return sql.includes('COUNT(*)') ? [{ total: 31 }] : [{ id: 7, product_id: 10, quantity: 10, resolved_quantity: 2 }];
  } });
  const result = await service.costTasks({ page: 2, query: '车标' });
  assert.equal(result.total, 31);
  assert.equal(result.pageSize, 30);
  assert.deepEqual(statements[1].args, ['%车标%', '%车标%', '%车标%', 30, 30]);
  assert.ok(statements.every(row => /SELECT/.test(row.sql) && !/procurement_requests/.test(row.sql)));
});

test('manual priority requires inventory management permission; cost tasks use the procurement endpoint', async () => {
  let called = false;
  const routes = createOperationsRoutes({ services: { applyProcurementLedger: async () => { called = true; }, procurementStockCostTasks: async query => query },
    readJson: async () => ({ action_type: 'set_priority' }) });
  await assert.rejects(routes['POST /api/procurement/ledger']({ _session: { roles: ['packing'], personId: 2 } }), error => error.status === 403);
  assert.equal(called, false);
  await routes['POST /api/procurement/ledger']({ _session: { roles: ['procurement'], personId: 2 } });
  assert.equal(called, true);
  assert.deepEqual(await routes['GET /api/procurement/stock-cost-tasks']({}, new URL('https://example.test/api/procurement/stock-cost-tasks?page=2')), { page: '2' });
});

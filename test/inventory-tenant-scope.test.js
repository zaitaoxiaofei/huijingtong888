import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInventoryTenantScope, inventoryTenantSql, assertInventoryRecord, assertInventoryReferences } from '../src/services/inventory-tenant-scope.js';

const tenants = new Map([[1, 'default'], [2, 'a'], [3, 'b']]);
const resolve = async (_sql, params) => [{ id: params[0] || 1, slug: tenants.get(params[0] || 1) }];

test('inventory scope resolves admin only to default and fails closed on missing or forged context', async () => {
  const legacy = await resolveInventoryTenantScope('admin', resolve);
  assert.deepEqual(legacy.predicate('p'), { sql: '(p.tenant_id = ? OR p.tenant_id IS NULL)', params: [1] });
  assert.equal(inventoryTenantSql(legacy, 'p'), '(p.tenant_id = 1 OR p.tenant_id IS NULL)');
  const a = await resolveInventoryTenantScope(2, resolve);
  assert.deepEqual(a.predicate(), { sql: '(tenant_id = ?)', params: [2] });
  for (const value of [null, undefined, '', '0', '-1', '2 OR 1=1']) await assert.rejects(resolveInventoryTenantScope(value, resolve), { statusCode: 403 });
  await assert.rejects(resolveInventoryTenantScope(2, async () => []), { statusCode: 403 });
  assert.throws(() => inventoryTenantSql({ id: '2', isDefault: true }, 'p'));
});

test('reference ownership follows the authoritative scope and checks stored parent chains', async () => {
  const a = await resolveInventoryTenantScope(2, resolve);
  const seen = [];
  const query = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes('FROM purchase_order_items')) return [{ id: 20, tenant_id: 2, product_id: 10, purchase_order_id: 30 }];
    if (sql.includes('FROM products')) return [{ id: 10, tenant_id: 2 }];
    if (sql.includes('FROM purchase_orders')) return [];
    return [];
  };
  await assert.rejects(assertInventoryRecord(a, 'purchaseItem', 20, query), { statusCode: 404 });
  assert.ok(seen.some(call => call.sql.includes('FROM purchase_orders') && call.params[0] === 30));
  await assert.rejects(assertInventoryReferences(a, { tenant_id: 3, product_id: 99 }, async (_sql, params) => {
    assert.deepEqual(params, [99, 2]);
    return [];
  }), { statusCode: 404 });
});

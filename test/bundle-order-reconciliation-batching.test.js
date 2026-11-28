import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { inventoryTenantSql } from '../src/services/inventory-tenant-scope.js';

const source = readFileSync(new URL('../src/services/bundle-order-reconciliation.js', import.meta.url), 'utf8');
const implementation = source.slice(source.indexOf('\n\n') + 2).replace('export function', 'function');

function fixture({ missingOwner } = {}) {
  const reads = { owners: [], movements: [] };
  const writes = [];
  const orders = new Map(Array.from({ length: 558 }, (_, index) => {
    const id = index + 1;
    return [id, { needs_fulfillment: 1, posting_number: String(id), items: [
      { order_item_id: id, product_id: 10, quantity: 1 }
    ] }];
  }));
  const create = runInNewContext(implementation + '\ncreateBundleOrderReconciliation;', {
    inventoryTenantSql,
    loadOrderProcurementCoverage: async () => orders
  });
  const reconcile = create({
    postMovement: async (_connection, row) => writes.push(['post', row.related_order_item_id, row.quantity_delta]),
    rebuild: async (_connection, id) => writes.push(['rebuild', id])
  });
  const connection = { async query(sql, ids = []) {
    if (sql.includes('FROM products')) return [[{ id: 10, purchase_cost: 5 }]];
    if (sql.includes('FROM order_items')) {
      assert.match(sql, /s\.tenant_id = 1 OR s\.tenant_id IS NULL/);
      assert.match(sql, /FOR UPDATE/);
      reads.owners.push(ids.length);
      return [ids.filter(id => id !== missingOwner).map(id => ({
        order_item_id: id, sku_mapping_id: id, shop_id: 10, platform: id === 3 ? 'wb' : 'ozon'
      }))];
    }
    if (sql.includes('FROM inventory_movements')) {
      assert.match(sql, /im\.tenant_id = 1 OR im\.tenant_id IS NULL/);
      assert.match(sql, /FOR UPDATE/);
      assert.ok(!ids.includes(3));
      reads.movements.push(ids.length);
      return [ids.filter(id => id !== 2).map(id => ({
        id, related_order_item_id: id, product_id: 10, quantity_delta: id === 1 ? -2 : -1
      }))];
    }
    assert.match(sql, /^UPDATE inventory_movements/);
    writes.push(['update', ids.at(-1), ids[0]]);
    return [[]];
  } };
  return { run: () => reconcile(connection, { id: 1, isDefault: true }), reads, writes };
}

test('558 order items take two ownership reads and two locked movement reads', async () => {
  const { run, reads, writes } = fixture();
  await run();
  assert.deepEqual(reads, { owners: [500, 58], movements: [499, 58] });
  assert.deepEqual(writes, [['update', 1, -1], ['post', 2, -1], ['rebuild', 10]]);
});

test('a missing tenant-owned order item still aborts reconciliation', async () => {
  const { run, writes } = fixture({ missingOwner: 12 });
  await assert.rejects(run, /订单所属企业已变化/);
  assert.deepEqual(writes, []);
});

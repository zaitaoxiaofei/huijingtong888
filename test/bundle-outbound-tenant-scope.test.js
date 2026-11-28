import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadBundleFinishedStocks } from '../src/services/bundle-finished-stock.js';
import { inventoryTenantSql } from '../src/services/inventory-tenant-scope.js';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const syncOutbound = source.slice(
  source.indexOf('async function syncOutboundForOpenOrdersMysql('),
  source.indexOf('export async function repairOrderOutboundMysql(')
);

for (const defaultTenant of [true, false]) {
  test('bundle outbound applies the order tenant scope to stock and ownership checks (default=' + defaultTenant + ')', async () => {
    const id = defaultTenant ? 1 : 2;
    const expected = alias => `(${alias}.tenant_id = ${id}${defaultTenant ? ` OR ${alias}.tenant_id IS NULL` : ''})`;
    let reconciled = false;
    const run = runInNewContext(`(${syncOutbound.trim()})`, {
      orderListTenantScopeMysql: async () => ({ id, defaultTenant }),
      assertOrderTaskAccessMysql: async () => {},
      orderOutboundSyncScopeMysql: () => ({ sql: '', params: [] }),
      orderTenantPredicateMysql: alias => expected(alias),
      orderTransportEvidenceSql: () => '0',
      orderStatusSqlMysql: () => '0',
      mysqlQuery: async sql => {
        if (!sql.includes("im.source_type IN ('bundle_assembly'")) return [];
        assert.ok(sql.includes(expected('p')));
        assert.ok(sql.includes(expected('im')));
        return [{ product_id: 10, ledger: 1 }];
      },
      loadBundleFinishedStocks,
      withMysqlTransaction: async callback => callback({}),
      mysqlConnectionQuery: async (_connection, sql) => {
        assert.ok(sql.includes(expected('p')));
        return [];
      },
      reconcileBundleOrders: async (_connection, scope) => {
        assert.equal(inventoryTenantSql(scope, 's'), expected('s'));
        assert.equal(inventoryTenantSql(scope, 'im'), expected('im'));
        reconciled = true;
      }
    });
    await run({ tenantId: id, open_only: true });
    assert.ok(reconciled);
  });
}

test('the last new order shares the final bundle reconciliation before writing outbound records', async () => {
  const events = [];
  const row = { id: 21, order_status: 'awaiting_packaging', shop_id: 5, mapping_id: 3,
    sku_mapping_id: 3, product_id: 4, quantity: 1, posting_number: 'ORDER-21', ozon_sku: '21' };
  const run = runInNewContext(`(${syncOutbound.trim()})`, {
    orderListTenantScopeMysql: async () => ({ id: 1, defaultTenant: true }),
    assertOrderTaskAccessMysql: async () => {},
    orderOutboundSyncScopeMysql: () => ({ sql: '', params: [] }),
    orderTenantPredicateMysql: () => '1=1',
    orderTransportEvidenceSql: () => '0',
    orderStatusSqlMysql: () => '0',
    mysqlQuery: async sql => sql.includes('FROM order_items oi') ? [row] : [],
    resolveOrderStockLocationMysql: () => ({ stockLocation: 'LOCAL' }),
    mysqlPoolConnectionAdapter: {},
    postProductInventoryWithComponentsMysql: async (_connection, body, _tenant, { deferBundleReconciliation }) => {
      assert.equal(body.related_order_item_id, row.id);
      events.push('defer');
      deferBundleReconciliation();
    },
    loadBundleFinishedStocks: async () => assert.fail('the deferred item already confirmed bundle stock'),
    withMysqlTransaction: async callback => { await callback({}); events.push('commit'); },
    mysqlConnectionQuery: async () => { events.push('lock'); return []; },
    reconcileBundleOrders: async () => events.push('reconcile'),
    upsertOrderOutboundRecordMysql: async () => events.push('record'),
    mysqlExecute: async sql => { assert.match(sql, /UPDATE order_exceptions/); events.push('resolve'); },
    invalidateOrderProcurementCoverage: () => events.push('invalidate')
  });
  const result = await run({ tenantId: 1, open_only: true });
  assert.equal(result.deducted, 1);
  assert.equal(result.outbound_records_synced, 1);
  assert.deepEqual(events, ['defer', 'lock', 'reconcile', 'commit', 'record', 'resolve', 'invalidate']);
});

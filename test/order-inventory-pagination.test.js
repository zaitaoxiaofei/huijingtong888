import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
function definition(name) {
  return source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];
}
const sorting = ['logisticsModeKeyMysql', 'orderTimestampPagedValueMysql', 'orderInventoryPagedSortKeyMysql',
  'sortPagedOrdersMysql', 'orderPrintTimestampPagedValueMysql', 'orderPrintSequencePagedValueMysql'].map(definition).join('\n');

test('inventory pagination loads details only for the globally sorted page, including print order', async () => {
  const candidates = Array.from({ length: 243 }, (_, index) => ({
    id: index + 1, inventory_ids: index % 9 ? `P-${243 - index}` : null,
    product_names: index % 2 ? '组合库存方案' : 'Unbound product',
    warehouse_name: index % 5 ? 'LOCAL' : 'Hun Chun',
    ordered_at: `2026-09-${String(index % 9 + 1).padStart(2, '0')} 00:00:00`,
    printed_at: '2026-09-10 00:00:00', print_batch_id: `batch-${index % 4}`, print_sequence: index % 7
  }));
  for (const printFilter of ['all', 'printed', 'unprinted']) {
    for (const page of [1, 2, 13, 14]) {
      let loadedIds, coverageCalls = 0;
      const context = vm.createContext({
        ensureMysqlCutoverEnabled() {},
        ensureOrderLabelPrintSchemaMysql: async () => {}, ensureSkuInventoryRecipeSchemaMysql: async () => {},
        ensureProductCompositionSchemaMysql: async () => {}, ensureProductNamingSchemaMysql: async () => {},
        orderBaseSqlMysql: async () => ({ where: '1=1', params: [] }),
        filterOrderIdsByLogisticsMethodMysql: () => null, filterOrderIdsByLogisticsCarrierMysql: () => null,
        withRestrictedOrderIdsMysql: base => base, orderFilteredSqlMysql: async () => ({ joins: '', where: '1=1', params: [] }),
        orderProcurementCoverageMysql: async () => { coverageCalls++; return new Map(); },
        mysqlQueryOne: async () => ({ total: candidates.length }), mysqlQuery: async () => candidates.map(row => ({ id: row.id })),
        orderInventorySortRowsMysql: async () => candidates,
        orderRowsByIdsMysql: async ids => { loadedIds = Array.from(ids); return ids.map(id => candidates.find(row => row.id === id)); },
        orderLogisticsCarrierOptionsMysql: () => []
      });
      vm.runInContext(sorting + '\n' + definition('ordersPagedMysql'), context);
      const query = { page, pageSize: 20, status: 'awaiting_deliver', fulfillmentType: 'fbs', sortMode: 'inventory', printFilter, includeCounts: '0', includeLogisticsOptions: '0' };
      const expected = Array.from(context.sortPagedOrdersMysql(candidates, query)).slice((page - 1) * 20, page * 20).map(row => row.id);
      const result = await context.ordersPagedMysql(query);
      assert.deepEqual(loadedIds, expected);
      assert.ok(loadedIds.length <= 20);
      assert.equal(result.total, candidates.length);
      assert.equal(coverageCalls, 0, 'ordinary filters must not wait for allocation coverage before selecting page IDs');
    }
  }
});

test('lightweight inventory rows retain raw/nested logistics fallback and input tie order', async () => {
  const context = vm.createContext({
    mysqlQuery: async () => [
      { id: 1, raw_json: '{"raw":{"delivery_method":{"name":"FBP","warehouse":"Hun Chun"}}}' },
      { id: 2, raw_json: '{"analytics_data":{"warehouse":"LOCAL","tpl_provider":"CEL"}}' },
      { id: 3, raw_json: null, tracking_number: 'fallback-channel' }
    ],
    parseJsonOrNull: value => value ? JSON.parse(value) : null
  });
  vm.runInContext(definition('orderInventorySortRowsMysql'), context);
  const rows = await context.orderInventorySortRowsMysql([3, 2, 1]);
  assert.deepEqual(Array.from(rows, row => row.id), [3, 2, 1]);
  assert.equal(rows[0].logistics_channel, 'fallback-channel');
  assert.equal(rows[1].warehouse_name, 'LOCAL');
  assert.equal(rows[2].delivery_method_name, 'FBP');
  assert.ok(rows.every(row => row.raw_json === undefined));
});

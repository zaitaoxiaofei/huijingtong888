import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFbpOpportunityCoverageReader } from '../src/services/fbp-opportunity-coverage-cache.js';
import { workflowRevision } from '../src/services/inventory-workflow-cache.js';
import { invalidateOrderProcurementCoverage } from '../src/services/mysql-order-procurement-coverage.js';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const scope = { id: 2, isDefault: false, predicate: () => ({ sql: 'tenant_id=?', params: [2] }) };
const entries = [
  ['saveFbpReplenishmentInventoryAllocationMysql', [{ inventory_key: '7', reason: 'Adjust actual reservation', items: [{ item_id: 1, order_id: 10, final_qty: 8, expected_final_qty: 10 }] }, 7, 2]],
  ['addFbpReplenishmentItemAdjustmentMysql', [{ order_id: 10, item_id: 1, adjustment_qty: -2, reason_code: 'demand_reduced' }, 7, 2]],
  ['deleteProcurementRequestMysql', [10, 2]],
  ['cancelPurchaseOrderMysql', [10, 2]],
  ['updatePurchaseOrderMysql', [10, { items: [{ id: 20, actual_quantity: 5, amount: 50 }] }, 2]],
  ['deletePurchaseOrderMysql', [10, 2]],
  ['updateProductMysql', [7, { name: 'Product fixture', owner_person_id: 7, components: [{ component_product_id: 8, quantity: 2 }] }, 2]]
];

function extract(name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert(start >= 0, `actual ${name} must exist`);
  const following = source.slice(start + 1).search(/\n(?:export )?(?:async )?function [A-Za-z0-9_]+/);
  const end = following < 0 ? source.length : start + 1 + following;
  return source.slice(start, end).replace('export ', '');
}

function fixture(name, { failCommit = false } = {}) {
  const events = [];
  const transactionQueries = [];
  let projection = 10, loads = 0;
  const read = createFbpOpportunityCoverageReader({ revision: workflowRevision, now: () => 0,
    load: async () => { loads++; return { product_availability: new Map([[7, { local_available: projection }]]) }; } });
  const existingProduct = { id: 7, is_consumable: 0, product_type: 'main', selection_status: 'listed', created_by_person_id: 7, production_lead_days: null, warehouse_logistics_days: 2 };
  const one = async (_connection, sql) => {
    if (sql.includes('FROM products')) return existingProduct;
    if (sql.includes('FROM procurement_requests')) return { id: 10, product_id: 7, status: 'purchased', purchase_order_id: null };
    if (sql.includes('FROM purchase_orders')) return { id: 10, order_no: 'fixture', status: 'purchased', total_amount: 50 };
    if (sql.includes('FROM purchase_order_items')) return { id: 20, product_id: 7, actual_quantity: 5 };
    if (sql.includes('FROM inbound_records')) return { id: 30, product_id: 7, status: 'pending_arrival', quantity: 3 };
    if (sql.includes('FROM fbp_replenishment')) return { id: 10, product_id: 7, approved_qty: 10, adjustment_qty: 0, status: 'approved' };
    return { id: 7 };
  };
  const execute = async sql => {
    transactionQueries.push(sql);
    if (sql.includes('SELECT i.id, i.order_id')) return [[{ id: 1, order_id: 10, product_id: 7, inventory_key: '7', approved_qty: 10, adjustment_qty: 0, status: 'approved' }]];
    if (sql.includes('FROM inventory_movements')) return [[{ quantity: 30 }]];
    if (sql.includes('AS quantity')) return [[{ quantity: 0 }]];
    if (sql.startsWith('SELECT * FROM purchase_order_items')) return [[{ id: 20, product_id: 7 }]];
    if (sql.includes('SELECT * FROM inbound_records')) return [[{ id: 30, product_id: 7 }]];
    if (/^\s*SELECT/.test(sql)) return [[{ id: 7 }]];
    events.push('write');
    return [{ affectedRows: 1, insertId: 9 }];
  };
  const connection = { execute, query: execute };
  const context = vm.createContext({
    console, ensureMysqlCutoverEnabled() {},
    ensureFbpReplenishmentSchemaMysql: async () => {}, ensureProcurementFlexibleRequestSchemaMysql: async () => {},
    ensureProcurementInboundLinkSchemaMysql: async () => {}, ensurePurchaseCostVersionSchemaMysql: async () => {}, ensurePurchaseOrderShipmentSchemaMysql: async () => {},
    ensureSelectionCreativeSchemaMysql: async () => {}, ensureProductCompositionSchemaMysql: async () => {}, ensureProductNamingSchemaMysql: async () => {},
    resolveInventoryTenantScope: async () => scope, resolveShopTenantIdMysql: async () => 2, isDefaultShopTenantMysql: async () => false,
    assertInventoryMember: async () => {}, assertInventoryRecord: async () => {}, assertInventoryReferences: async () => {}, assertPurchaseTreeMysql: async () => {},
    tenantShopPredicateMysql: () => 's.tenant_id=?', inventoryTenantSql: () => 'tenant_id=2', localStockLocationPredicateMysql: () => "stock_location='LOCAL'",
    mysqlQueryOne: async sql => one(null, sql), mysqlConnectionQueryOne: one, mysqlConnectionQuery: async () => [], mysqlSchemaColumnExists: async () => true,
    rollbackProcurementDirectInboundMysql: async () => { events.push('rollback-inbound-write'); }, rollbackProcurementMergedInboundMysql: async () => { events.push('rollback-inbound-write'); },
    deleteInboundInventoryMovementMysql: async () => { events.push('delete-inbound-movement'); },
    savePurchaseOrderShipmentsMysql: async () => {}, purchaseChannelSnapshotMysql: async () => ({}), recordPurchaseCostVersionMysql: async () => {},
    nullableInteger: value => value == null || value === '' ? null : Number(value), assertFreshRecord() {},
    currentExchangeRateValueMysql: async () => 11, normalizeOzonCategoryIdMysql: value => value, normalizeOzonCategoryNameMysql: value => value,
    recommendShippingMysql: () => 'air_land',
    isProductImageEndpointMysql: () => false, normalizeProductImageUrlMysql: value => value || '', normalizeProductDetailImagesForUpdateMysql: value => value || '',
    normalizeStockUnitMysql: value => value || '个', normalizeProductionLeadDaysMysql: value => value ?? null, normalizeWarehouseLogisticsDaysMysql: value => value ?? 2,
    resolveDevelopmentMeta: () => ({ development_type: 'new', vehicle_brand: '', vehicle_model: '', vehicle_model_key: '' }),
    saveProductComponentsTxMysql: async () => { events.push('components-write'); },
    syncOutboundForOpenOrdersMysql: async () => { events.push('outbound-no-change'); return { deducted: 0 }; },
    invalidateInventoryAlertSalesBindingMysql() {}, invalidateOrderReadCache() {},
    invalidateOrderProcurementCoverage() {
      assert.equal(events.at(-1), 'commit', 'a coverage invalidation must follow a successful commit');
      events.push('invalidate');
      invalidateOrderProcurementCoverage();
    },
    withMysqlTransaction: async callback => {
      events.push('begin');
      try {
        const result = await callback(connection);
        if (failCommit) throw new Error('fixture commit rejected');
        events.push('commit'); projection = 20;
        return result;
      } catch (error) { events.push('rollback'); throw error; }
    }
  });
  vm.runInContext(extract(name), context);
  return { write: (...args) => context[name](...args), read: () => read(scope), events, transactionQueries, loads: () => loads };
}

for (const [name, args] of entries) {
  test(`${name} invalidates warm FBP availability only after its actual transaction commits`, async () => {
    const f = fixture(name);
    const cached = await f.read(), epoch = workflowRevision();
    assert.equal((await f.read()), cached);
    await f.write(...args);
    assert(f.transactionQueries.some(sql => /INSERT|UPDATE|DELETE/.test(sql)), 'the actual writer callback must execute');
    assert.equal(workflowRevision(), epoch + 1);
    assert(f.events.indexOf('commit') < f.events.indexOf('invalidate'));
    const current = await f.read();
    assert.notEqual(current, cached);
    assert.equal(current.product_availability.get(7).local_available, 20);
    assert.equal(f.loads(), 2);
    if (name === 'updateProductMysql') assert(f.events.includes('outbound-no-change'), 'component changes invalidate even when outbound sync changes no order');
  });
  test(`${name} keeps the previous FBP snapshot and revision when its commit fails`, async () => {
    const f = fixture(name, { failCommit: true });
    const cached = await f.read(), epoch = workflowRevision();
    await assert.rejects(f.write(...args), /fixture commit rejected/);
    assert.equal(workflowRevision(), epoch);
    assert(!f.events.includes('invalidate'));
    assert(f.events.includes('rollback'));
    assert.equal(await f.read(), cached);
    assert.equal(f.loads(), 1);
  });
}

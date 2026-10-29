import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { inventoryLedgerView, inventoryStocktakeBody, inventoryStocktakePreviewView } from '../src/services/inventory-ledger-view.js';

const service = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../scripts/init-mysql-schema.mjs', import.meta.url), 'utf8');
const operationsRoutes = readFileSync(new URL('../src/server/routes/operations.js', import.meta.url), 'utf8');

test('物流时长默认两天，行内更新严格校验周期、企业归属和并发原值', async () => {
  const updates = [];
  const invalidated = [];
  let changed = 1;
  const reads = [];
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {},
    ensureProductNamingSchemaMysql: async () => {},
    resolveShopTenantIdMysql: async (tenantId) => { assert.equal(tenantId, 'tenant-seven'); return 7; },
    isDefaultShopTenantMysql: async () => false,
    mysqlSchemaColumnExists: async () => true,
    tenantShopPredicateMysql: (alias) => `${alias}.tenant_id = ?`,
    mysqlQueryOne: async (sql, args) => { reads.push({ sql, args }); return reads.length === 1 ? { id: 22 } : { production_lead_days: 5, warehouse_logistics_days: 2 }; },
    mysqlExecute: async (sql, args) => { updates.push({ sql, args }); return { affectedRows: changed }; },
    invalidateMasterDataCachePrefix: (prefix) => invalidated.push(prefix)
  });
  const normalizeStart = service.indexOf('function normalizeProductionLeadDaysMysql');
  const normalizeEnd = service.indexOf('function normalizeProductComponentItemsMysql', normalizeStart);
  vm.runInContext(service.slice(normalizeStart, normalizeEnd), context);
  const start = service.indexOf('export async function updateInventoryProductLeadTimesMysql');
  const end = service.indexOf('export async function stockAlertsMysql', start);
  vm.runInContext(service.slice(start, end).replace('export ', ''), context);

  const payload = { product_id: 22, production_lead_days: 10, warehouse_logistics_days: 3,
    expected_production_lead_days: 7, expected_warehouse_logistics_days: 2 };
  assert.deepEqual(JSON.parse(JSON.stringify(await context.updateInventoryProductLeadTimesMysql(payload, 'tenant-seven'))),
    { ok: true, product_id: 22, production_lead_days: 10, warehouse_logistics_days: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0].args)), [10, 3, 22, 7, 7, 2]);
  assert.match(updates[0].sql, /COALESCE\(production_lead_days, 7\) = \?/);
  assert.match(updates[0].sql, /COALESCE\(warehouse_logistics_days, 2\) = \?/);
  assert.match(updates[0].sql, /products\.tenant_id = \?/);
  assert.equal(reads[0].args[1], 7);
  assert.deepEqual(invalidated, ['stock-alerts:inventory-base:v1:']);

  changed = 0;
  reads.length = 0;
  await assert.rejects(context.updateInventoryProductLeadTimesMysql(payload, 'tenant-seven'), (error) => error.statusCode === 409);
  assert.equal(invalidated.length, 1);
  await assert.rejects(context.updateInventoryProductLeadTimesMysql({ ...payload, warehouse_logistics_days: 6 }, 'tenant-seven'), /物流到仓时长/);
  await assert.rejects(context.updateInventoryProductLeadTimesMysql({ ...payload, production_lead_days: 8 }, 'tenant-seven'), /生产周期/);
  assert.match(schema, /warehouse_logistics_days INT NOT NULL DEFAULT 2/);
  assert.match(service, /normalizeWarehouseLogisticsDaysMysql\(body\.warehouse_logistics_days \?\? 2\)/);
});

test('库存岗位可查看库存明细和盘点，采购路径仍需采购权限', () => {
  const allowed = (roles, method, path) => authorizeApiRequest({ method, _session: { roles } }, path.split('/').filter(Boolean)).allowed;
  assert.equal(allowed(['packing'], 'GET', '/api/inventory/ledger'), true);
  assert.equal(allowed(['packing'], 'POST', '/api/inventory/ledger/preview'), false);
  assert.equal(allowed(['operations'], 'GET', '/api/inventory/ledger'), true);
  assert.equal(allowed(['operations'], 'POST', '/api/inventory/ledger/preview'), true);
  assert.equal(allowed(['operations'], 'POST', '/api/inventory/ledger'), true);
  assert.equal(allowed(['operations'], 'POST', '/api/inventory/products/lead-times'), true);
  assert.equal(allowed(['operations'], 'GET', '/api/procurement/ledger'), false);
  assert.equal(allowed(['operations'], 'POST', '/api/procurement/ledger'), false);
  assert.equal(allowed(['operations'], 'POST', '/api/procurement/purchases'), false);

  assert.match(operationsRoutes, /"GET \/api\/inventory\/ledger":/);
  assert.match(operationsRoutes, /"POST \/api\/inventory\/ledger\/preview":/);
  assert.match(operationsRoutes, /"POST \/api\/inventory\/ledger":/);
  assert.throws(() => inventoryStocktakeBody({ action_type: 'record_purchase' }), (error) => error.statusCode === 403);
  assert.deepEqual(inventoryStocktakeBody({ action_type: 'stocktake', product_id: 22, counted_quantity: 4,
    counted_amount: 500, purchase_order_id: 7, reason_code: 'count_confirmed' }),
  { action_type: 'stocktake', product_id: 22, counted_quantity: 4, reason_code: 'count_confirmed' });
});

test('库存明细响应只包含盘点需要的数据，不返回采购金额和采购明细', () => {
  const view = inventoryLedgerView({
    product: { id: 22, name: '测试库存', purchase_cost: 88, supplier_id: 5, inventory_number: '1-22' },
    revision: 'rev', physical_estimate: 9, available_estimate: 4, open_order_demand: 5,
    purchases: [{ amount: 1000, purchase_url: 'secret' }],
    orders: [{ order_id: 3, quantity: 5, amount: 1000, posting_number: 'P3' }],
    movements: [{ source_type: 'reconciliation_stocktake', quantity_delta: 3, amount: 1000 }],
    actions: [{ id: 1, action_type: 'record_purchase', result_json: { amount: 1000 } },
      { id: 2, action_type: 'stocktake', result_json: { physical_before: 6, physical_after: 9, counted_amount: 1000 } }]
  });
  assert.equal(view.product.id, 22);
  assert.equal(view.orders[0].posting_number, 'P3');
  assert.equal(view.actions.length, 1);
  assert.equal(view.actions[0].result_json.physical_after, 9);
  assert.doesNotMatch(JSON.stringify(view), /purchase_cost|supplier_id|purchase_url|counted_amount|"amount"|"purchases"/);
  assert.doesNotMatch(JSON.stringify(inventoryStocktakePreviewView({ physical_before: 5, physical_after: 8, counted_amount: 1000 })), /counted_amount/);
});

test('企业库存明细的 FBP 店铺关系仅展示当前企业店铺', async () => {
  const ledger = { product: { id: 22, name: '测试库存' }, revision: 'rev',
    fbp_inventory: { rows: [
      { shop_id: 1, ozon_sku: 'A', present: 2, inventory_quantity: 2, available_inventory_quantity: 1 },
      { shop_id: 2, ozon_sku: 'B', present: 5, inventory_quantity: 5, available_inventory_quantity: 5 }
    ] } };
  const context = vm.createContext({
    readLedgerWithFlow: async () => ledger,
    resolveInventoryTenantScope: async () => ({ id: 7, predicate: () => ({ sql: 'tenant_id = ?' }) }),
    resolveShopTenantIdMysql: async () => 7,
    mysqlQuery: async (sql, params) => { assert.match(sql, /shops WHERE tenant_id = \?/); assert.equal(params[0], 7); return [{ id: 1 }]; },
    inventoryLedgerView
  });
  const start = service.indexOf('export const inventoryLedgerMysql =');
  const end = service.indexOf('export const previewInventoryStocktakeMysql =', start);
  vm.runInContext(service.slice(start, end).replace('export ', ''), context);
  const view = await vm.runInContext('inventoryLedgerMysql', context)({ product_id: 22 }, 'tenant-seven');
  assert.deepEqual(JSON.parse(JSON.stringify(view.fbp_inventory.rows.map((row) => row.ozon_sku))), ['A']);
  assert.equal(view.fbp_inventory.present, 2);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../frontend/admin/views/inventory/InventoryAlertsPage.vue', import.meta.url), 'utf8');
const ledger = readFileSync(new URL('../frontend/admin/components/procurement/ProcurementLedgerDialog.vue', import.meta.url), 'utf8');
const productDialog = readFileSync(new URL('../frontend/admin/components/inventory/ProductCreateEditDialog.vue', import.meta.url), 'utf8');

test('alert search, status filters, and view switch remain compact and responsive', () => {
  assert.match(page, /<InventoryPageToolbar[\s\S]*?<div v-if="inventoryView" class="alert-status-filters">/);
  assert.match(page, /\.alert-view-switch \{[^}]*justify-content: flex-end/);
  assert.match(page, /@media \(max-width: 760px\)[\s\S]*?\.alert-status-filters/);
  assert.ok(page.indexOf('label="预警线"') > page.indexOf('label="库存信息"'));
  assert.ok(page.indexOf('label="预警线"') < page.indexOf('label="关联店铺 / SKU"'));
  assert.match(page, /label="建议补货"/);
  assert.match(page, /class="alert-available-value"/);
});

test('lead time editing has explicit options, tenant-scoped API contract, and conflict protection', () => {
  assert.match(page, /productionLeadOptions = \[3, 5, 7, 10, 15, 30\]/);
  assert.match(page, /logisticsDayOptions = \[1, 2, 3, 4, 5\]/);
  assert.match(page, /apiClient\.post\("\/api\/inventory\/products\/lead-times"/);
  assert.match(page, /expected_production_lead_days: leadForm\.expected_production_lead_days/);
  assert.match(page, /expected_warehouse_logistics_days: leadForm\.expected_warehouse_logistics_days/);
  assert.match(page, /error\.status === 409/);
  assert.match(page, /hasPermission\(authStore\.user, "inventory\.write"\)/);
  assert.match(page, /hasPermission\(authStore\.user, "procurement\.request\.submit"\)/);
  assert.match(productDialog, /warehouse_logistics_days: value\.warehouse_logistics_days == null \? \(isInventoryTarget\.value \? 2 : null\)/);
  assert.match(productDialog, /warehouse_logistics_days: form\.warehouse_logistics_days/);
});

test('alert details load shared ledger only on demand and preserve complete SKU relations', () => {
  assert.match(page, /defineAsyncComponent\(\(\) => import\("\.\.\/\.\.\/components\/procurement\/ProcurementLedgerDialog\.vue"\)\)/);
  assert.match(page, /<ProcurementLedgerDialog v-if="ledgerVisible && selectedInventory"[^>]*inventory-mode/);
  assert.match(page, /<template #inventory-relations>[\s\S]*?:data="linkedSkus\(selectedInventory\)"/);
  assert.match(ledger, /props\.inventoryMode \? '\/api\/inventory\/ledger' : '\/api\/procurement\/ledger'/);
  assert.match(ledger, /props\.inventoryMode && \(type !== 'stocktake' \|\| !props\.stocktakeEnabled\)/);
});

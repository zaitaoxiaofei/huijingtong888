import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../frontend/admin/views/inventory/InventoryAlertsPage.vue', import.meta.url), 'utf8');
const view = readFileSync(new URL('../frontend/admin/views/inventory/InventoryView.vue', import.meta.url), 'utf8');
const ledger = readFileSync(new URL('../frontend/admin/components/procurement/ProcurementLedgerDialog.vue', import.meta.url), 'utf8');
const productDialog = readFileSync(new URL('../frontend/admin/components/inventory/ProductCreateEditDialog.vue', import.meta.url), 'utf8');

test('alert search, status filters, and view switch remain compact and responsive', () => {
  assert.match(page, /<InventoryPageToolbar[\s\S]*?<div v-if="inventoryView" class="alert-inventory-filters">/);
  assert.match(view, /<template v-else-if="isInventoryAlerts" #actions>/);
  assert.match(view, /role="tablist" aria-label="库存预警视角"/);
  assert.match(page, /@media \(max-width: 760px\)[\s\S]*?\.alert-status-filters/);
  assert.ok(page.indexOf('label="消耗量"') > page.indexOf('label="库存信息"'));
  assert.ok(page.indexOf('label="库存分析"') > page.indexOf('label="消耗量"'));
  assert.match(page, /class="alert-consumption"[\s\S]*?近 7 天[\s\S]*?近 15 天[\s\S]*?近 30 天/);
  assert.match(page, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(page, /class="alert-analysis-status"[\s\S]*?预警缺口/);
  assert.match(page, /断货已采购[\s\S]*?断货未采购[\s\S]*?缺货已采购[\s\S]*?缺货未采购/);
  assert.match(page, /aria-label="消耗量排序"[\s\S]*?@change="changeInventorySort"/);
  assert.match(page, /mode: inventoryView\.value \? "inventory-alerts" : "fbp-operations"/);
  assert.match(page, /fbpFocus: "replenishment"/);
  assert.match(page, /aria-label="FBP SKU 备货筛选"[\s\S]*?@change="changeFbpFocus"/);
  assert.ok(page.indexOf('label="当前 SKU 库存"') < page.indexOf('label="历史订单件数"'));
  assert.ok(page.indexOf('label="本 SKU 建议备货"') < page.indexOf('label="销量走势"'));
  assert.match(page, /label="关联本地库存"[\s\S]*?共享实物[\s\S]*?可用/);
  assert.match(page, /label="历史订单件数"[\s\S]*?库存合计[\s\S]*?当前 SKU/);
  assert.match(page, /label="近三周订单件数"[\s\S]*?older_7d_qty[\s\S]*?prev_7d_qty[\s\S]*?recent_7d_qty/);
  assert.ok(page.indexOf('label="关联 SKU"') > page.indexOf('label="关联店铺"'));
  assert.match(page, /label="库存周转时间"/);
  assert.match(page, /\.alert-metric-value \{ font-size: 15px; font-weight: 650/);
  assert.doesNotMatch(page, /alert-available-value|alert-threshold-value/);
});

test('lead time editing has explicit options, tenant-scoped API contract, and conflict protection', () => {
  assert.match(page, /productionLeadOptions = \[3, 5, 7, 10, 15, 30\]/);
  assert.match(page, /logisticsDayOptions = \[1, 2, 3, 4, 5\]/);
  assert.match(page, /apiClient\.post\("\/api\/inventory\/products\/lead-times"/);
  assert.match(page, /expected_production_lead_days: leadForm\.expected_production_lead_days/);
  assert.match(page, /expected_warehouse_logistics_days: leadForm\.expected_warehouse_logistics_days/);
  assert.match(page, /error\.status === 409/);
  assert.match(page, /<el-dialog :model-value="!!editingLeadProductId" title="修改库存周转时间"/);
  assert.match(page, /@click="saveLeadTimes\(editingLeadRow\)"/);
  assert.match(page, /hasPermission\(authStore\.user, "inventory\.write"\)/);
  assert.match(page, /hasPermission\(authStore\.user, "procurement\.request\.submit"\)/);
  assert.match(productDialog, /warehouse_logistics_days: value\.warehouse_logistics_days == null \? \(isInventoryTarget\.value \? 2 : null\)/);
  assert.match(productDialog, /warehouse_logistics_days: form\.warehouse_logistics_days/);
});

test('alert details load shared ledger only on demand and preserve complete SKU relations', () => {
  assert.match(page, /defineAsyncComponent\(\(\) => import\("\.\.\/\.\.\/components\/procurement\/ProcurementLedgerDialog\.vue"\)\)/);
  assert.match(page, /<ProcurementLedgerDialog v-if="ledgerVisible && selectedInventory"[^>]*inventory-mode/);
  assert.match(page, /:initial-action="ledgerInitialAction"/);
  assert.match(page, /@click="openInventoryDetails\(row, 'stocktake'\)"/);
  assert.match(page, /<template #inventory-relations>[\s\S]*?:data="linkedSkus\(selectedInventory\)"/);
  assert.match(ledger, /props\.inventoryMode \? '\/api\/inventory\/ledger' : '\/api\/procurement\/ledger'/);
  assert.match(ledger, /props\.inventoryMode && \(type !== 'stocktake' \|\| !props\.stocktakeEnabled\)/);
  assert.match(ledger, /pendingInitialAction === 'stocktake' && props\.modelValue && props\.inventoryMode && props\.stocktakeEnabled/);
});

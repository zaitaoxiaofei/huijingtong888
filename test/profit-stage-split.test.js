import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const backend = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const inventoryView = readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const ordersPage = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const repairScript = readFileSync(new URL("../scripts/repair-finance-profit-facts.mjs", import.meta.url), "utf8");
const financeBackfillScript = readFileSync(new URL("../scripts/sync-ozon-finance-backfill.mjs", import.meta.url), "utf8");
const financeOrderAuditScript = readFileSync(new URL("../scripts/audit-ozon-finance-order.mjs", import.meta.url), "utf8");
const profitVarianceAuditScript = readFileSync(new URL("../scripts/audit-profit-model-variance.mjs", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("profit stage split distinguishes finance-accrued from delivered-without-finance", () => {
  assert.match(backend, /function resolveProfitStageMysql/);
  assert.match(backend, /function normalizeFinanceCompletenessMysql/);
  assert.match(backend, /finance_accrued/);
  assert.match(backend, /finance_partial/);
  assert.match(backend, /delivered_waiting_finance/);
  assert.match(backend, /estimated_open/);
  assert.match(backend, /finance_row_count/);
  assert.match(backend, /parent_acquiring_row_count/);
  assert.match(backend, /finance_sale_accrual_row_count/);
  assert.match(backend, /finance_commission_row_count/);
  assert.match(backend, /finance_delivery_row_count/);
  assert.match(backend, /profit_stage_text/);
  assert.match(backend, /const hasCoreFees = commissionRows > 0 && deliveryRows > 0/);
  assert.match(backend, /Number\(totals\.platform_delivery \|\| 0\)[\s\S]*Number\(totals\.international_transport \|\| 0\)/);
});

test("estimated recalculation no longer writes estimated profit into actual profit", () => {
  assert.match(backend, /const nextActualProfit = actualReady \? Number\(existingStageRow\?\.actual_profit \|\| existingStageRow\?\.net_profit_cny \|\| 0\) : 0;/);
  assert.doesNotMatch(backend, /actual_profit = CASE WHEN \? = 'accrued' THEN \? ELSE 0 END/);
  assert.match(backend, /await saveProfitItemMysql\(\{ orderItemId: itemId, product, estimated, quantity, salePrice, settlement: actualReady \? "pending" : nextSettlement, order, item \}\);/);
});

test("finance-accrued detail prefers locked net profit over stale item actual profit", () => {
  assert.match(backend, /function resolvedActualProfitMysql/);
  assert.match(backend, /resolveProfitStageMysql\(row\)\.actualReady && netProfit !== null/);
  assert.match(backend, /const actualProfit = Number\(resolvedActualProfitMysql\(row\) \?\? 0\);/);
  assert.match(backend, /resolvedActualProfitMysql\(row\) \?\? roundMoneyMysql\(saleAmount - costTotal\)/);
});

test("finance application includes parent posting acquiring fee once", () => {
  assert.match(backend, /function orderFinanceRowsWithParentAcquiringMysql/);
  assert.match(backend, /function parentOrderNumberMysql/);
  assert.match(backend, /parentOrderNumberMysql\(order\)/);
  assert.match(backend, /marketplaceredistributionofacquiringoperation/);
  assert.match(backend, /SUM\(CASE WHEN amount_cny < 0 THEN amount_cny ELSE 0 END\)/);
  assert.match(backend, /scaleFinanceRowMysql\(row, share\)/);
  assert.match(backend, /const otherFee = actualCollectingFee > 0 \? actualCollectingFee : \(returnedNoRevenue \? 0 : Number\(item\.other_fee_cny \|\| 0\)\);/);
  assert.doesNotMatch(backend, /Number\(item\.other_fee_cny \|\| 0\) \+ collectingFee/);
});

test("pre-fulfillment cancellations keep only actual parent acquiring fee", () => {
  assert.match(backend, /parent_ofi\.posting_number = COALESCE\(NULLIF\(o\.order_number, ''\), REGEXP_REPLACE\(o\.posting_number, '-\[0-9\]\+\$', ''\)\)/);
  assert.match(backend, /const purchaseCost = cancelOnlyCollectingFee \|\| \(returnPolicy && !returnPolicy\.purchase\) \? 0 : rawPurchaseCost;/);
  assert.match(backend, /if \(cancelOnlyCollectingFee \|\| \(returnPolicy && !returnPolicy\.commission\)\) commissionFeeCny = 0;/);
  assert.match(backend, /const advertisingCost = cancelOnlyCollectingFee \? 0 : Number\(item\.advertising_cost_cny \|\| 0\);/);
  assert.match(backend, /Number\(financeRow\.derived_from_parent_posting \|\| 0\) === 1/);
  assert.match(backend, /cancelOnlyCollectingFee \? parentAllocatedCollectingFee : Number\(categoryTotals\.collecting_fee \|\| 0\)/);
  assert.match(backend, /pre_fulfillment_cancel_cost_formula/);
});

test("estimated terminal losses are componentized once instead of double-counted as aftersale loss", () => {
  const saveProfitItemSource = backend.match(/async function saveProfitItemMysql[\s\S]*?\n}\n\nasync function syncOrderItemProfitFromBreakdownMysql/)?.[0] || "";
  assert.match(saveProfitItemSource, /const terminalPolicy = terminalNoRevenue/);
  assert.match(saveProfitItemSource, /const returnLoss = terminalNoRevenue\s*\?\s*0/);
  assert.match(saveProfitItemSource, /const otherFee = terminalPolicy\?\.collecting \? rawCollectingFee : 0/);
  assert.match(saveProfitItemSource, /purchaseCost \+ domesticShipping \+ internationalShipping \+ packagingCost \+ commission \+ ozonServiceFee \+ otherFee \+ returnLoss \+ advertisingCost/);
});

test("actual profit application prefers Ozon sale accrual over local sale amount", () => {
  assert.match(backend, /const ozonSaleAccrual = financeRows\.reduce/);
  assert.match(backend, /const actualTotalSale = ozonSaleAccrual > 0 \? ozonSaleAccrual : localTotalSale;/);
  assert.match(backend, /const itemSale = terminalNoRevenue \? 0 : roundMoneyMysql\(actualTotalSale > 0 \? actualTotalSale \* share : localItemSale\);/);
  assert.match(backend, /const actualProfit = roundMoneyMysql\(terminalNoRevenue \? -terminalLoss : itemSale - terminalLoss\);/);
  assert.match(backend, /const actualCommissionFeeTotal = Number\(categoryTotals\.commission \|\| 0\);/);
  assert.match(backend, /let commissionFeeCny = roundMoneyMysql\(actualCommissionFeeTotal \* share\);/);
  assert.doesNotMatch(backend, /commissionFeeCny = roundMoneyMysql\(itemSale \* commissionRate\)/);
  assert.match(backend, /INSERT INTO order_profit_items/);
  assert.match(backend, /sale_amount_cny = VALUES\(sale_amount_cny\)/);
  assert.match(backend, /const ozonOrderSale = directRows\.reduce/);
  assert.match(backend, /const itemSale = ozonOrderSale > 0 \? ozonOrderSale : localOrderSale;/);
});

test("terminal orders are repaired to no-revenue negative profit facts", () => {
  assert.match(backend, /export async function repairTerminalNoRevenueOrderProfitsMysql/);
  assert.match(backend, /function terminalOrderLossSqlMysql/);
  assert.match(backend, /opi\.sale_amount_cny = 0/);
  assert.match(backend, /opi\.net_profit_cny = -\$\{existingLossSql\}/);
  assert.match(backend, /oi\.estimated_profit = -\$\{existingLossSql\}/);
  assert.match(packageJson, /"repair:terminal-no-revenue-profits": "node scripts\/repair-terminal-no-revenue-profits\.mjs"/);
});

test("finance profit fact repair is dry-run first and write-gated", () => {
  assert.match(backend, /export async function repairHistoricalFinanceProfitFactsMysql/);
  assert.match(backend, /mode: write \? "write" : "dry_run"/);
  assert.match(backend, /if \(write && previewRows\.length\)/);
  assert.match(backend, /applyOzonFinanceToOrdersMysql\(\{ orderIds:/);
  assert.match(repairScript, /hasFlag\("write"\)/);
  assert.match(repairScript, /repairHistoricalFinanceProfitFactsMysql/);
  assert.match(packageJson, /"repair:finance-profit": "node scripts\/repair-finance-profit-facts\.mjs"/);
  assert.match(backend, /finance_sale_accrual_mismatch/);
  assert.match(backend, /missing_finance_commission/);
  assert.match(backend, /missing_finance_delivery_cost/);
  assert.match(backend, /finance_delivery_fee_cny/);
});

test("finance backfill sync is windowed and does not apply profit by default", () => {
  assert.match(backend, /export async function syncOzonFinanceRawMysql/);
  assert.match(backend, /export async function backfillOzonFinanceMysql/);
  assert.match(backend, /function splitFinanceBackfillWindowsMysql/);
  assert.match(backend, /value instanceof Date && Number\.isFinite\(value\.getTime\(\)\)/);
  assert.match(backend, /Math\.min\(Math\.max\(Number\(body\.window_days \|\| body\.windowDays \|\| 14\), 1\), 31\)/);
  assert.match(backend, /const applyProfit = Boolean\(body\.apply_profit \|\| body\.applyProfit\);/);
  assert.match(backend, /if \(applyProfit\) \{/);
  assert.match(backend, /if \(write\) \{\s*const status = result\.errors\.length \? "partial_error" : "ok";/);
  assert.match(financeBackfillScript, /write: hasFlag\("write"\)/);
  assert.match(financeBackfillScript, /apply_profit: hasFlag\("apply-profit"\) \|\| hasFlag\("apply_profit"\)/);
  assert.match(packageJson, /"sync:ozon-finance-backfill": "node scripts\/sync-ozon-finance-backfill\.mjs"/);
});

test("finance order audit explains child and parent posting fees in Chinese", () => {
  assert.match(financeOrderAuditScript, /function financeLineChineseLabel/);
  assert.match(financeOrderAuditScript, /parentPostingNumber/);
  assert.match(financeOrderAuditScript, /parent_allocated_fee_cny/);
  assert.match(financeOrderAuditScript, /Ozon 销售佣金/);
  assert.match(financeOrderAuditScript, /收款\/支付手续费/);
  assert.match(financeOrderAuditScript, /国际运输\/运输代理服务费/);
  assert.match(financeOrderAuditScript, /配送服务费/);
  assert.doesNotMatch(financeOrderAuditScript, /mysqlExecute/);
  assert.match(packageJson, /"audit:ozon-finance-order": "node scripts\/audit-ozon-finance-order\.mjs"/);
});

test("profit variance audit is read-only and attributes major drivers", () => {
  assert.match(profitVarianceAuditScript, /sale_impact_cny/);
  assert.match(profitVarianceAuditScript, /international_shipping_impact_cny/);
  assert.match(profitVarianceAuditScript, /commission_impact_cny/);
  assert.match(profitVarianceAuditScript, /parent_acquiring_impact_cny/);
  assert.match(profitVarianceAuditScript, /dominant_driver/);
  assert.doesNotMatch(profitVarianceAuditScript, /mysqlExecute/);
  assert.match(packageJson, /"audit:profit-variance": "node scripts\/audit-profit-model-variance\.mjs"/);
});

test("inventory profit detail shows precise Chinese profit stage", () => {
  assert.match(inventoryView, /profit_stage_text/);
  assert.match(inventoryView, /账单已到账后才切换真实利润/);
  assert.match(inventoryView, /actual_profit_ready/);
});

test("delivered finance settlement requires all core actual cost facts", () => {
  assert.match(backend, /const signedTotals = rows\.reduce/);
  assert.match(backend, /Math\.max\(0, -Number\(amount \|\| 0\)\)/);
  assert.match(backend, /hasRequiredFinanceBasisMysql\(financeRows, orderOutcome, items\)/);
  assert.match(backend, /Number\(totals\.commission \|\| 0\) > 0\.005/);
  assert.match(backend, /Number\(totals\.collecting_fee \|\| 0\) > 0\.005/);
  assert.match(backend, /Number\(totals\.platform_delivery \|\| 0\)[\s\S]*Number\(totals\.international_transport \|\| 0\)[\s\S]*> 0\.005/);
  assert.match(backend, /const hasPurchaseCost = items\.length > 0 && items\.every/);
  assert.match(ordersPage, /item\.settlement_state === "accrued" && item\.profit_status === "accrued"/);
  assert.match(ordersPage, /settlementStates\.length > 0[\s\S]*profitStatuses\.length > 0[\s\S]*settlementStates\.every[\s\S]*profitStatuses\.every/);
});

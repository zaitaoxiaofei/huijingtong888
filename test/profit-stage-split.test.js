import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { getProfitFormula } from "../src/services/profit-formulas/registry.js";

const backend = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const inventoryView = readFileSync(new URL("../frontend/admin/views/inventory/InventoryProductsPage.vue", import.meta.url), "utf8");
const ordersPage = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const repairScript = readFileSync(new URL("../scripts/repair-finance-profit-facts.mjs", import.meta.url), "utf8");
const financeBackfillScript = readFileSync(new URL("../scripts/sync-ozon-finance-backfill.mjs", import.meta.url), "utf8");
const financeOrderAuditScript = readFileSync(new URL("../scripts/audit-ozon-finance-order.mjs", import.meta.url), "utf8");
const profitVarianceAuditScript = readFileSync(new URL("../scripts/audit-profit-model-variance.mjs", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const aggregationSource = readFileSync(new URL("../src/services/profit-formulas/v1/aggregation.js", import.meta.url), "utf8");

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
  assert.match(backend, /const nextActualProfit = actualReady \? Number\(existingStageRow\?\.net_profit_cny \?\? existingStageRow\?\.actual_profit \?\? 0\) : 0;/);
  assert.doesNotMatch(backend, /actual_profit = CASE WHEN \? = 'accrued' THEN \? ELSE 0 END/);
  assert.match(backend, /await saveProfitItemMysql\(\{ orderItemId: itemId, product, estimated, quantity, salePrice, settlement: actualReady \? "pending" : nextSettlement, order, item, connection \}\);/);
  assert.match(backend, /await syncOrderItemProfitFromBreakdownMysql\(itemId, actualReady \? "pending" : nextSettlement, connection\);/);
  assert.match(backend, /return withVersionedOrderProfitWrite\(itemId,[\s\S]*?async \(\{ connection, db \}\) =>/);
  assert.match(backend, /await lockProfitItemMysql\(item\.id, usesEstimatedCollecting \? "finance_accrued_estimated_collecting" : "finance_accrued", connection\);/);
  assert.match(backend, /const mysqlExecute = profitCalculationDatabase\(connection\)\.execute/);
});

test("finance-accrued detail prefers locked net profit over stale item actual profit", () => {
  assert.match(backend, /function resolvedActualProfitMysql/);
  assert.match(backend, /resolveProfitStageMysql\(row\)\.actualReady && netProfit !== null/);
  assert.match(backend, /const actualProfit = Number\(resolvedActualProfitMysql\(row\) \?\? 0\);/);
  assert.match(backend, /resolvedActualProfitMysql\(row\) \?\? roundMoneyMysql\(saleAmount - costTotal\)/);
});

test("finance application allocates parent posting finance rows once", () => {
  assert.match(backend, /function orderFinanceRowsWithParentAllocationMysql/);
  assert.match(backend, /function parentOrderNumberMysql/);
  assert.match(backend, /parentOrderNumberMysql\(order\)/);
  assert.match(backend, /marketplaceredistributionofacquiringoperation/);
  assert.match(backend, /GREATEST\(0, -COALESCE\(SUM\(amount_cny\), 0\)\) AS fee_amount_cny/);
  assert.match(backend, /scaleFinanceRowMysql\(row, share\)/);
  assert.match(backend, /GROUP BY operation_type, operation_type_name, service_type, service_name/);
  assert.match(backend, /const otherFee = hasCollectingFinance \? actualCollectingFee : \(returnedNoRevenue \? 0 : Number\(item\.other_fee_cny \|\| 0\)\);/);
  assert.doesNotMatch(backend, /Number\(item\.other_fee_cny \|\| 0\) \+ collectingFee/);
});

test("pre-fulfillment cancellations keep only actual parent acquiring fee", () => {
  assert.match(backend, /parent_ofi\.posting_number = COALESCE\(NULLIF\(o\.order_number, ''\), REGEXP_REPLACE\(o\.posting_number, '-\[0-9\]\+\$', ''\)\)/);
  assert.match(backend, /const purchaseCost = cancelOnlyCollectingFee \|\| \(returnPolicy && !returnPolicy\.purchase\) \? 0 : rawPurchaseCost;/);
  assert.match(backend, /if \(cancelOnlyCollectingFee \|\| \(returnPolicy && !returnPolicy\.commission\)\) commissionFeeCny = 0;/);
  assert.match(backend, /const advertisingCost = cancelOnlyCollectingFee \? 0 : Number\(item\.advertising_cost_cny \|\| 0\);/);
  assert.match(backend, /Number\(financeRow\.derived_from_parent_posting \|\| 0\) === 1/);
  assert.match(backend, /ozonFinanceCategoryMysql\(financeRow\) === "collecting_fee"/);
  assert.match(backend, /cancelOnlyCollectingFee \? parentAllocatedCollectingFee : Number\(categoryTotals\.collecting_fee \|\| 0\)/);
  assert.match(backend, /pre_fulfillment_cancel_cost_formula/);
});

test("estimated terminal losses are componentized once instead of double-counted as aftersale loss", () => {
  const saveProfitItemSource = backend.match(/async function saveProfitItemMysql[\s\S]*?\r?\n}\r?\n\r?\nasync function syncOrderItemProfitFromBreakdownMysql/)?.[0] || "";
  assert.match(saveProfitItemSource, /const terminalPolicy = terminalNoRevenue/);
  assert.match(saveProfitItemSource, /const returnLoss = terminalNoRevenue\s*\?\s*0/);
  assert.match(saveProfitItemSource, /const otherFee = terminalPolicy\?\.collecting \? rawCollectingFee : 0/);
  assert.match(saveProfitItemSource, /const formula = getProfitFormula\(estimated\?\.formulaVersion \|\| "V1"\)/);
  assert.match(saveProfitItemSource, /const \{ classifyOrderOutcome, classifyOrderAccounting, resolveReturnLossCostPolicy \} = formula\.outcome/);
  assert.match(saveProfitItemSource, /formula\.aggregateEstimatedProfit\(\{[\s\S]*?terminalNoRevenue, saleAmount, purchaseCost, domesticShipping, internationalShipping,[\s\S]*?packagingCost, commission, ozonServiceFee, otherFee, returnLoss, advertisingCost/);
  assert.match(aggregationSource, /purchaseCost \+ domesticShipping \+ internationalShipping \+ packagingCost \+ commission \+ ozonServiceFee \+ otherFee \+ returnLoss \+ advertisingCost/);
});

test("actual profit application prefers Ozon sale accrual over local sale amount", () => {
  assert.match(backend, /const ozonSaleAccrual = financeRows\.reduce/);
  assert.match(backend, /const actualTotalSale = ozonSaleAccrual > 0 \? ozonSaleAccrual : localTotalSale;/);
  assert.match(backend, /const itemSale = terminalNoRevenue \? 0 : roundMoneyMysql\(actualTotalSale > 0 \? actualTotalSale \* share : localItemSale\);/);
  assert.match(backend, /formula\.aggregateActualProfit\(\{[\s\S]*?terminalNoRevenue, itemSale, purchaseCost, domesticShipping, actualInternationalShipping,[\s\S]*?packagingCost, commissionFeeCny, actualServiceFeeCny, returnLoss, advertisingCost, otherFee/);
  assert.match(aggregationSource, /const actualProfit = roundMoney\(terminalNoRevenue \? -terminalLoss : itemSale - terminalLoss\);/);
  assert.match(backend, /const actualCommissionFeeTotal = Number\(categoryTotals\.commission \|\| 0\);/);
  assert.match(backend, /let commissionFeeCny = roundMoneyMysql\(actualCommissionFeeTotal \* share\);/);
  assert.doesNotMatch(backend, /commissionFeeCny = roundMoneyMysql\(itemSale \* commissionRate\)/);
  assert.match(backend, /INSERT INTO order_profit_items/);
  assert.match(backend, /sale_amount_cny = VALUES\(sale_amount_cny\)/);
  assert.match(backend, /const ozonOrderSale = directRows\.reduce/);
  assert.match(backend, /const itemSale = ozonOrderSale > 0 \? ozonOrderSale : localOrderSale;/);
});

test("registered V1 aggregates preserve normal and no-revenue estimated and actual arithmetic", () => {
  const formula = getProfitFormula("V1");
  for (const terminalNoRevenue of [false, true]) {
    const estimated = formula.aggregateEstimatedProfit({
      terminalNoRevenue, saleAmount: 100, purchaseCost: 1, domesticShipping: 2, internationalShipping: 3,
      packagingCost: 4, commission: 5, ozonServiceFee: 6, otherFee: 7, returnLoss: 8, advertisingCost: 9
    });
    assert.deepEqual(estimated, { costTotal: 45, netProfit: terminalNoRevenue ? -45 : 55, grossProfit: terminalNoRevenue ? -22 : 78 });
    const actual = formula.aggregateActualProfit({
      terminalNoRevenue, itemSale: 100, purchaseCost: 1, domesticShipping: 2, actualInternationalShipping: 3,
      packagingCost: 4, commissionFeeCny: 5, actualServiceFeeCny: 6, returnLoss: 7, advertisingCost: 8, otherFee: 9
    });
    assert.deepEqual(actual, { terminalLoss: 45, actualProfit: terminalNoRevenue ? -45 : 55, grossProfit: terminalNoRevenue ? -37 : 63 });
  }
});

function profitSaveFixture({ existing = null, packagingFee = 0.5 } = {}) {
  const writes = [], requestedVersions = [];
  const connection = { fixture: "same profit transaction" };
  let queries = 0;
  const db = {
    queryOne: async (sql, params) => {
      queries++;
      assert.match(sql, /SELECT is_locked, profit_status FROM order_profit_items WHERE order_item_id = \?/);
      assert.equal(params[0], 101);
      return existing;
    },
    execute: async (sql, params) => {
      assert.equal((sql.match(/\?/g) || []).length, params.length);
      const fields = sql.match(/INSERT INTO order_profit_items\s*\(([\s\S]*?)\)\s*VALUES/)?.[1].split(",").map((field) => field.trim());
      assert.ok(fields);
      writes.push(Object.fromEntries(fields.map((field, index) => [field, params[index]])));
    }
  };
  const saveSource = backend.match(/async function saveProfitItemMysql[\s\S]*?\r?\n}/)?.[0];
  assert.ok(saveSource);
  const save = runInNewContext(`(${saveSource})`, {
    getProfitFormula: (version) => { requestedVersions.push(version); return getProfitFormula(version); },
    profitCalculationDatabase: (passed) => { assert.equal(passed, connection); return db; },
    mysqlQueryOne: () => assert.fail("must use the supplied transaction for reads"),
    mysqlExecute: () => assert.fail("must use the supplied transaction for writes"),
    isTerminalNoRevenueOutcomeMysql: (outcome) => ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(outcome),
    packagingFeeForSaleAmountMysql: async () => packagingFee,
    estimateOrderItemReturnLossMysql: async ({ order }) => {
      assert.equal(getProfitFormula("V1").outcome.classifyOrderOutcome(order), "active");
      return 0;
    }
  });
  const input = {
    orderItemId: 101, product: { purchase_cost: 8, domestic_shipping: 1 },
    estimated: { formulaVersion: "V1", freight: 3, commission: 12, paymentFee: 2, withdrawalFee: 0.8, advertisingCost: 3 },
    quantity: 2, salePrice: 30, settlement: "pending", order: { status: "awaiting_packaging" }, connection
  };
  return { save: (overrides = {}) => save({ ...input, ...overrides }), writes, requestedVersions, queries: () => queries };
}

test("the actual MySQL profit-save function uses the pinned V1 formula and supplied transaction", async () => {
  const fixture = profitSaveFixture();
  await fixture.save();
  assert.deepEqual(fixture.requestedVersions, ["V1"]);
  assert.equal(fixture.queries(), 1);
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.writes[0], {
    order_item_id: 101, sale_amount_cny: 60, purchase_cost_cny: 16, domestic_shipping_cny: 2,
    international_shipping_cny: 6, packaging_cost_cny: 0.5, commission_rate: 0.2, commission_fee_cny: 12,
    ozon_service_fee_cny: 2.8, return_loss_cny: 0, advertising_cost_cny: 3, other_fee_cny: 0,
    gross_profit_cny: 23.5, net_profit_cny: 17.7, profit_status: "estimated"
  });
});

test("profit-save protects a locked settled zero from estimated overwrite", async () => {
  const fixture = profitSaveFixture({ existing: { is_locked: 1, profit_status: "accrued", net_profit_cny: 0 } });
  await fixture.save();
  assert.equal(fixture.queries(), 1);
  assert.deepEqual(fixture.writes, []);
});

test("recalculation retains locked zero net profit even without full finance aggregates", async () => {
  const connection = { fixture: "versioned estimate transaction" };
  const writes = [], propagated = [];
  const db = {
    queryOne: async () => ({ profit_status: "accrued", settlement_state: "accrued", is_locked: 1, net_profit_cny: 0, actual_profit: 99 }),
    execute: async (sql, params) => writes.push({ sql, params })
  };
  const source = backend.match(/async function persistRecalculatedItemMysql[\s\S]*?\r?\n}/)?.[0];
  const persist = runInNewContext(`(${source})`, {
    withVersionedOrderProfitWrite: async (id, options, project) => {
      assert.equal(id, 101);
      assert.equal(options.layer, "estimate");
      return project({ connection, db });
    },
    profitEstimateInputs: () => ({}),
    resolveProfitStageMysql: () => ({ actualReady: false }),
    persistedPlatformFeeMysql: () => 0,
    saveProfitItemMysql: async (input) => { assert.equal(input.connection, connection); propagated.push(input.settlement); },
    syncOrderItemProfitFromBreakdownMysql: async (id, settlement, passed) => {
      assert.equal(id, 101); assert.equal(passed, connection); propagated.push(settlement);
    }
  });
  await persist({ itemId: 101, mapping: { id: 1 }, product: {}, estimated: {}, quantity: 1, salePrice: 50, estimatedProfit: 8 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.at(-3), 0, "settled zero is authoritative over stale actual_profit=99");
  assert.equal(writes[0].params.at(-2), "accrued");
  assert.deepEqual(propagated, ["pending", "pending"], "estimated writes must respect the downstream accrued guard");
});

test("profit-save components are deducted once for pre-fulfillment cancellation and rejection", async () => {
  const cancelled = profitSaveFixture();
  await cancelled.save({ order: { status: "cancelled" } });
  assert.equal(cancelled.writes[0].sale_amount_cny, 0);
  assert.equal(cancelled.writes[0].net_profit_cny, 0);
  assert.equal(cancelled.writes[0].return_loss_cny, 0);
  const rejected = profitSaveFixture();
  await rejected.save({ order: { status: "cancelled", cancelled_after_ship: 1, cancel_reason: "unclaimed" } });
  const row = rejected.writes[0];
  assert.equal(row.sale_amount_cny, 0);
  assert.equal(row.purchase_cost_cny, 16);
  assert.equal(row.domestic_shipping_cny, 0);
  assert.equal(row.international_shipping_cny, 6);
  assert.equal(row.other_fee_cny, 2.8);
  assert.equal(row.return_loss_cny, 0);
  assert.equal(row.ozon_service_fee_cny, 0);
  assert.equal(row.net_profit_cny, -24.8);
});

test("profit-save rejects unsupported formulas before touching the profit projection", async () => {
  const fixture = profitSaveFixture();
  await assert.rejects(fixture.save({ estimated: { formulaVersion: "V3" } }), { code: "UNSUPPORTED_PROFIT_FORMULA_VERSION" });
  assert.equal(fixture.queries(), 0);
  assert.deepEqual(fixture.writes, []);
});

test("finance locking uses the caller transaction and preserves the first lock reason and time", async () => {
  const connection = { fixture: "finance transaction" };
  const writes = [];
  const lockSource = backend.match(/async function lockProfitItemMysql[\s\S]*?\r?\n}/)?.[0];
  const lock = runInNewContext(`(${lockSource})`, {
    profitCalculationDatabase: (passed) => {
      assert.equal(passed, connection);
      return { execute: async (sql, params) => writes.push({ sql, params }) };
    },
    mysqlExecute: () => assert.fail("finance locking must not leave the caller transaction")
  });
  await lock(101, "finance_accrued", connection);
  assert.equal(writes.length, 1);
  assert.deepEqual(Array.from(writes[0].params), ["finance_accrued", 101]);
  assert.match(writes[0].sql, /SET is_locked = 1/);
  assert.match(writes[0].sql, /locked_at = COALESCE\(locked_at, CURRENT_TIMESTAMP\)/);
  assert.match(writes[0].sql, /lock_reason = COALESCE\(lock_reason, \?\)/);
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

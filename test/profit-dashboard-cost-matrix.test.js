import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const monthlyBillingViewSource = readFileSync(new URL("../frontend/admin/views/profit/MonthlyBillingDetailsView.vue", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const returnLossFormulaSource = serviceSource.match(/function returnLossTotalSqlMysql\(\) \{[\s\S]*?\n\}/)?.[0] || "";
const profitRankingSource = serviceSource.match(/export async function profitRankingMysql\(query = \{\}\) \{[\s\S]*?\n\}\n\nfunction monthRangeMysql/)?.[0] || "";
const monthlyBillingPendingSource = serviceSource.match(/async function monthlyBillingPendingByShopMysql\(from = "", to = "", shopId = ""\) \{[\s\S]*?\n\}\n\nfunction monthlyBillingOrderSettlementMysql/)?.[0] || "";

test("profit summary exposes cost and rate fields used by consolidated billing", () => {
  for (const field of [
    "purchase_cost",
    "advertising_cost",
    "order_advertising_cost",
    "advertising_adjustment",
    "operating_profit",
    "operating_profit_margin",
    "logistics_cost",
    "platform_fee",
    "purchase_cost_ratio",
    "advertising_cost_ratio",
    "advertising_revenue_cny",
    "advertising_acos",
    "logistics_cost_ratio",
    "platform_fee_ratio",
    "accrued_profit",
    "pending_profit"
  ]) {
    assert.match(serviceSource, new RegExp(`\\b${field}\\b`));
  }
});

test("profit dashboard advertising cost prefers Ozon ad report spend", () => {
  assert.match(serviceSource, /FROM ozon_ad_sku_daily/);
  assert.match(serviceSource, /advertising_cost_source/);
  assert.match(serviceSource, /order_advertising_cost/);
  assert.match(serviceSource, /advertising_spend_cny/);
  assert.match(serviceSource, /advertising_revenue_cny/);
  assert.match(serviceSource, /advertising_acos/);
});

test("profit dashboard return loss uses reason-applied costs and settled retained revenue only", () => {
  assert.match(returnLossFormulaSource, /function returnLossTotalSqlMysql/);
  assert.match(returnLossFormulaSource, /opi\.purchase_cost_cny/);
  assert.match(returnLossFormulaSource, /opi\.domestic_shipping_cny/);
  assert.match(returnLossFormulaSource, /opi\.international_shipping_cny/);
  assert.match(returnLossFormulaSource, /opi\.commission_fee_cny/);
  assert.match(returnLossFormulaSource, /opi\.ozon_service_fee_cny/);
  assert.match(returnLossFormulaSource, /opi\.other_fee_cny/);
  assert.match(returnLossFormulaSource, /-\s*COALESCE\(opi\.sale_amount_cny, 0\)/);
  assert.doesNotMatch(returnLossFormulaSource, /COALESCE\(opi\.sale_amount_cny,\s*oi\.sale_price \* oi\.quantity,\s*0\)/);
  assert.doesNotMatch(returnLossFormulaSource, /opi\.packaging_cost_cny/);
  assert.doesNotMatch(returnLossFormulaSource, /opi\.advertising_cost_cny/);
  assert.doesNotMatch(returnLossFormulaSource, /oi\.frozen_purchase_cost/);
  assert.doesNotMatch(serviceSource, /AS return_loss,\s*\n\s*CURRENT_TIMESTAMP[\s\S]{0,120}COALESCE\(opi\.return_loss_cny, oi\.aftersale_loss, 0\)/);
});

test("profit ranking and monthly billing use the same terminal return loss formula", () => {
  assert.match(profitRankingSource, /const returnLossTotal = returnLossTotalSqlMysql\(\);[\s\S]*?AS return_loss/);
  assert.match(profitRankingSource, /CASE WHEN \$\{outcome\.rejectedUnclaimed\} OR \$\{outcome\.afterDeliveryReturn\} THEN \$\{returnLossTotal\} ELSE 0 END\), 0\) AS return_loss/);
  assert.doesNotMatch(profitRankingSource, /COALESCE\(SUM\(COALESCE\(opi\.return_loss_cny, oi\.aftersale_loss, 0\)\), 0\) AS return_loss/);
  assert.match(serviceSource, /profitRankingMysql\(\{ dimension: "shop"[\s\S]*?monthlyBillingPendingByShopMysql/);
});

test("profit dashboard return revenue is original returned order amount", () => {
  assert.match(serviceSource, /AS return_revenue/);
  assert.match(serviceSource, /THEN COALESCE\(oi\.sale_price \* oi\.quantity, 0\) ELSE 0 END\), 0\) AS return_revenue/);
  assert.doesNotMatch(serviceSource, /THEN COALESCE\(opi\.sale_amount_cny, 0\) ELSE 0 END\), 0\) AS return_revenue/);
});

test("monthly billing order details expose original order amount", () => {
  assert.match(serviceSource, /COALESCE\(SUM\(oi\.sale_price \* oi\.quantity\), 0\) AS order_amount/);
  assert.match(serviceSource, /order_amount: roundMoneyMysql\(row\.order_amount\)/);
});

test("monthly billing loads order details through paged endpoint", () => {
  assert.match(serviceSource, /export async function monthlyBillingOrderDetailsMysql/);
  assert.match(serviceSource, /pageSize = Math\.min\(Math\.max\(Number\(query\.pageSize \|\| query\.page_size \|\| 50\), 1\), 200\)/);
  assert.match(serviceSource, /includeOrders = \(query\.includeOrders === "1" \|\| query\.include_orders === "1"\)/);
  assert.match(serviceSource, /monthlyBillingOrderRowsMysql\(range\.from, range\.to, shopId\)/);
  assert.match(serviceSource, /monthlyBillingOrderRowsMysql\(range\.from, range\.to, shopId, options\)/);
});

test("monthly billing pending settlement uses profit item accrual status", () => {
  assert.match(monthlyBillingPendingSource, /async function monthlyBillingPendingByShopMysql/);
  assert.match(monthlyBillingPendingSource, /LEFT JOIN order_profit_items opi ON opi\.order_item_id = oi\.id/);
  assert.match(monthlyBillingPendingSource, /COALESCE\(opi\.profit_status, oi\.settlement_state, ''\) != 'accrued' THEN COALESCE\(opi\.net_profit_cny, oi\.estimated_profit, 0\)/);
  assert.doesNotMatch(monthlyBillingPendingSource, /COALESCE\(oi\.settlement_state, ''\) != 'accrued' THEN COALESCE\(oi\.estimated_profit, 0\)/);
});

test("monthly billing net profit includes manual expenses and salary without changing pending settlement", () => {
  assert.match(serviceSource, /async function monthlyBillingExpensesMysql/);
  assert.match(serviceSource, /String\(row\.category \|\| ""\) === "salary"/);
  assert.match(serviceSource, /net_profit: roundMoneyMysql\(Number\(row\.operating_profit \|\| 0\) - manualExpense - salaryExpense\)/);
  assert.match(serviceSource, /summary\.net_profit = roundMoneyMysql\(Number\(summary\.operating_profit \|\| 0\) - summary\.manual_expense - summary\.salary_expense\)/);
  assert.match(monthlyBillingViewSource, /净利润计算公式/);
  assert.match(monthlyBillingViewSource, /待结算单独展示，不作为成本再次扣除/);
  assert.match(monthlyBillingViewSource, /由人员先行替付/);
});

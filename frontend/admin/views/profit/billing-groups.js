import { billingExpenseCategories } from "./billing-expense-categories.js";
import { billingMetrics } from "./billing-metrics.js";
const personnel = new Set(["salary", "temporary_labor", "subsidy", "team_building", "travel"]);
const funds = new Set(["bank", "withdrawal", "currency_exchange"]);
const categoryOrder = { personnel: ["salary", "temporary_labor", "subsidy", "team_building", "travel"], funds: ["withdrawal", "currency_exchange", "bank"] };
export const billingExpenseGroup = category => personnel.has(category) ? "personnel" : funds.has(category) ? "funds" : "operating";
const money = value => Math.round(Number(value || 0) * 100);

export function buildBillingGroups(summary = {}, expenses = []) {
  const totals = new Map();
  for (const row of expenses) totals.set(row.category || "other", (totals.get(row.category || "other") || 0) + money(row.amount_cny));
  const metric = (key, label = billingMetrics[key].label) => ({ key, label, amount: Number(summary[key] || 0), source: "orders", hint: billingMetrics[key].hint });
  const categories = group => [...new Set([...billingExpenseCategories.map(x => x.value), ...totals.keys()])]
    .filter(key => billingExpenseGroup(key) === group).sort((a, b) => {
      const order = categoryOrder[group] || [];
      const rank = key => order.includes(key) ? order.indexOf(key) : order.length;
      return rank(a) - rank(b);
    }).map(key => {
      const definition = billingExpenseCategories.find(x => x.value === key);
      return { key, label: definition?.label || `历史费用（${key}）`, hint: definition?.hint || "历史录入费用，保留原类别。", amount: (totals.get(key) || 0) / 100, source: "expenses" };
    });
  const groups = [
    { key: "income", label: "经营收入", hint: "订单销售收入；额外奖励须核实后单列。", children: [metric("revenue", "订单销售收入"), { key: "platform_rewards", label: "平台奖励 / 补贴", amount: null, source: "unavailable", hint: "尚未独立识别，未计入收入；可查看原始账单。" }] },
    { key: "goods", label: "商品成本", hint: "本期订单消耗的商品采购成本。", children: [metric("purchase_cost")] },
    { key: "logistics", label: "物流费用", hint: "国内运输、跨境运输及平台配送。", children: [metric("domestic_shipping_cost"), metric("international_shipping_cost", "跨境及平台配送费")] },
    { key: "platform", label: "平台费用", hint: "佣金、推广及其他服务费；物流和支付手续费另列。", children: [metric("commission_fee"), metric("ozon_service_fee"), { ...metric("advertising_cost"), source: "advertising" }] },
    { key: "operating", label: "日常经营费用", hint: "场地、水电、包装、设备及软件等日常支出。", children: [metric("packaging_cost"), ...categories("operating")] },
    { key: "personnel", label: "人员费用", hint: "工资、临时工、补贴、团建和差旅。", children: categories("personnel") },
    { key: "funds", label: "支付与结算费用", hint: "平台支付、收款、提现、换汇和银行手续费。", children: [metric("other_fee"), ...categories("funds")] }
  ];
  return groups.map(group => ({ ...group, amount: group.children.reduce((sum, child) => sum + money(child.amount), 0) / 100 }));
}

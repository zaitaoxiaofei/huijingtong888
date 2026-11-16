import {billingProfitTotals} from '../../../../src/shared/billing-profit.js';
import { billingExpenseCategories } from "./billing-expense-categories.js";
import { billingMetrics } from "./billing-metrics.js";
const personnel = new Set(["salary", "temporary_labor", "subsidy", "team_building", "travel"]);
const funds = new Set(["bank", "withdrawal", "currency_exchange", "order_payment"]);
const categoryOrder = { personnel: ["salary", "temporary_labor", "subsidy", "team_building", "travel"], funds: ["withdrawal", "currency_exchange", "bank"] };
export const billingExpenseGroup = category => ["domestic_shipping", "fbp_stocking_shipping"].includes(category) ? "logistics" : personnel.has(category) ? "personnel" : funds.has(category) ? "funds" : "operating";
const money = value => Math.round(Number(value || 0) * 100);

export function buildBillingGroups(summary = {}, expenses = []) {
  const totals = new Map();
  for (const row of expenses) totals.set(row.category || "other", (totals.get(row.category || "other") || 0) + money(row.amount_cny));
  const metric = (key, label = billingMetrics[key].label) => ({ key, label, amount: Number(summary[key] || 0), source: "orders", hint: billingMetrics[key].hint });
  const editableCost = (key,category,label=billingMetrics[key].label) => ({...metric(key,label),amount:Number(summary[key]||0)+(totals.get(category)||0)/100,source:'editable_cost',hint:billingMetrics[key].hint+' 已含补充费用及更正差额，点击可新增、编辑或删除。'});
  const categories = group => [...new Set([...billingExpenseCategories.map(x => x.value), ...totals.keys()])]
    .filter(key => billingExpenseGroup(key) === group && !["domestic_shipping","packaging","order_payment","withdrawal"].includes(key)).sort((a, b) => {
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
    { key: "logistics", label: "物流费用", hint: "国内运输、跨境运输及平台配送。", children: [editableCost("domestic_shipping_cost","domestic_shipping"), metric("international_shipping_cost", "跨境及平台配送费"), ...categories("logistics")] },
    { key: "platform", label: "平台费用", hint: "佣金、广告、收单及平台服务费；平台物流列在物流费用中。", children: [metric("commission_fee"), metric("ozon_service_fee"), { ...metric("advertising_cost"), source: "advertising" },editableCost("other_fee","order_payment","Ozon收单费"),{key:"aftersale_fee",label:"退货服务费",amount:Number(summary.aftersale_fee||0),source:"aftersale",hint:"官方退货、逆向物流等净扣款，已扣除冲回；不与损失汇总重复扣。"}] },
    { key: "operating", label: "日常经营费用", hint: "场地、水电、包装、设备及软件等日常支出。", children: [editableCost("packaging_cost","packaging"), ...categories("operating"),...(summary.ai_cost_company_id?[{key:"ai_metered",label:"系统图片按量费用",amount:summary.ai_cost_applied?summary.ai_usage_cost:0,source:"ai_usage",hint:"按企业归属设置计入公司费用；历史无调用记录月份使用已确认估算，不与固定GPT订阅重复。"}]:[])] },
    { key: "personnel", label: "人员费用", hint: "工资、临时工、补贴、团建和差旅。", children: categories("personnel") },
    { key: "funds", label: "支付与结算费用", hint: "平台支付、收款、提现、换汇和银行手续费。", children: [{key:"withdrawal_fee",label:"提现手续费",amount:billingProfitTotals(summary,expenses).withdrawal_fee,source:"withdrawal",hint:"平台回款余值×1.2%；不减采购、国内运费、包装和工资。登记实际费用后替换估算，不重复扣。"}, ...categories("funds")] }
  ];
  return groups.map(group => ({ ...group, amount: group.children.some(c=>c.source==='ai_usage'&&c.amount==null)?null:group.children.reduce((sum, child) => sum + money(child.amount), 0) / 100 }));
}

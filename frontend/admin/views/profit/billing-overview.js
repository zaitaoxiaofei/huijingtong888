// Shared display projection for annual overview and monthly statements.
import {billingMetrics} from './billing-metrics.js';
export const overviewCards=[
 {key:'revenue',label:'营业额',hint:billingMetrics.revenue.hint},
 {key:'order_profit',label:'订单利润',hint:billingMetrics.order_profit.hint},
 {key:'net_profit',label:'净利润',hint:billingMetrics.net_profit.hint},
 {key:'recorded_expenses',label:'人工与费用',hint:'已入账的工资与补充经营费用合计，已在利润中扣除；订单费用更正可能也已包含在订单利润中，不再相减一次。'},
 {key:'ai_cost',label:'AI 消耗',hint:billingMetrics.ai_cost.hint+' 企业共用，尚未分摊到公司或店铺；固定订阅已列日常经营费用。'}
];
export function overviewAmounts(summary={},ai={},scope={}){
 const recorded=(Math.round(Number(summary.manual_expense||0)*100)+Math.round(Number(summary.salary_expense||0)*100))/100;
 const allocated=(!scope.companyId||scope.companyId==='all')&&(!scope.shopId||scope.shopId==='all');
 const aiKnown=ai.available!==false&&ai.cost!=null&&Number.isFinite(Number(ai.cost));
 return {...summary,recorded_expenses:recorded,ai_cost:allocated&&aiKnown?Number(ai.cost):null};
}
export function sumOverviewAmounts(months=[]){
 const result={};for(const key of overviewCards.map(x=>x.key)){const values=months.map(m=>m[key]);result[key]=values.length&&values.every(v=>v!=null&&Number.isFinite(Number(v)))?Math.round(values.reduce((n,v)=>n+Math.round(Number(v)*1000),0))/1000:null;}return result;
}

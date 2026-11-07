import { billingDateRange } from './billing-period.js';

export function validMobileDate(value, today) {
  const text=String(value||'');
  return /^\d{4}-\d{2}-\d{2}$/.test(text)&&!Number.isNaN(Date.parse(text))&&new Date(`${text}T00:00:00Z`).toISOString().slice(0,10)===text&&text<=today;
}
export function previousMobileDate(day) {
  const date=new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()-1);
  return date.toISOString().slice(0,10);
}
export function validMobileMonth(value,today) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value||''))&&value>='2020-01'&&value<=today.slice(0,7);
}
export function mobileMonthRange(month,today) {
  return billingDateRange({year:month.slice(0,4),month:month.slice(5,7)},today);
}
export function mobileMonthQuery(month,today,{companyId='all',shopId='all',overviewYear=month.slice(0,4)}={}) {
  const [from,to]=mobileMonthRange(month,today);
  return {month,from,to,companyId:String(companyId),shopId:String(shopId),overviewYear:String(overviewYear)};
}
export function mobileMoney(value) {
  return value==null||value===''||!Number.isFinite(Number(value))?'—':`¥ ${Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}
export function mobileInteger(value) {
  return value==null||value===''||!Number.isFinite(Number(value))?'—':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:0});
}
export function mobileRatio(value) {
  return value==null||value===''||!Number.isFinite(Number(value))?'—':`${(Number(value)*100).toFixed(1)}%`;
}
export function mobileAnnualTotals(months,keys) {
  const found=new Map(months.map(row=>[row.month_key,row]));
  const result={};
  for(const field of ['revenue','net_profit','manual_expense','salary_expense']) {
    const values=keys.map(key=>found.get(key)?.summary?.[field]);
    result[field]=values.every(value=>value!=null&&value!==''&&Number.isFinite(Number(value)))?values.reduce((sum,value)=>sum+Number(value),0):null;
  }
  result.margin=result.revenue==null||result.net_profit==null?null:result.revenue?result.net_profit/result.revenue:0;
  result.expenses=result.manual_expense==null||result.salary_expense==null?null:result.manual_expense+result.salary_expense;
  return result;
}

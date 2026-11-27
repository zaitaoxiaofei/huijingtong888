// The imported ledger is separate from historical order-profit calculations.
export const FINANCE_GROUPS = [
 {id:'income',name:'销售与其他收入',sign:1,metrics:['已确认商品销售额','销售退回冲减额','合作伙伴补贴收入','平台赔偿收入']},
 {id:'goods',name:'已售商品成本',sign:-1,metrics:['已售商品采购成本']},
 {id:'platform',name:'平台费用',sign:-1,metrics:['佣金','国际物流费','平台物流连接服务费','尾程派送费','点击广告费','品牌推广费','评价置顶服务费','星级商品推广费','一般收单支付服务费','国际货代合同管理服务费','国际运输合同缔约服务费','客户部分补偿扣款','缺件扣款','退货处理及货损费用','退货取消及未取货处理费','国际货运代理组织服务费','平台履约服务费（不含仓储）','平台其他费用']},
 {id:'labor',name:'人工与社保',sign:-1,metrics:['工资','加班及补贴','公司承担社保','公司承担公积金','公司承担缴费','临时用工费']},
 {id:'premises',name:'场地费用',sign:-1,metrics:['场地租金','水电物业费','网络费用']},
 {id:'software',name:'AI与软件费用',sign:-1,metrics:['AI使用费','软件订阅费']},
 {id:'office',name:'国内物流与办公设备费用',sign:-1,metrics:['国内物流费','办公耗材费','包装耗材费','设备维修费','设备折旧费']},
 {id:'financial',name:'财务费用',sign:-1,metrics:['提现手续费','银行手续费','换汇手续费','汇兑损益']},
 {id:'other',name:'其他费用',sign:-1,metrics:['会计服务费','差旅费','团建费','收单费补充更正','其他费用']},
 {id:'assets',name:'采购、资产与预付款（不直接计入利润）',sign:0,metrics:['商品采购支出','设备采购支出','押金及预付款']},
 {id:'tax',name:'税费与纳税调整（待会计审核）',sign:0,metrics:['税金及附加','增值税缴款','企业所得税缴款','纳税调增','纳税调减']}
];
export const MANUAL_EXPENSE_METRICS = ['国内物流费','AI使用费','软件订阅费','场地租金','水电物业费','办公耗材费','设备折旧费','设备采购支出','商品采购支出','押金及预付款','银行手续费','汇兑损益','会计服务费','其他费用'];
export const UPLOAD_TYPES = [
 {value:'order-sales',label:'Ozon逐单销售凭证（官方JSON）',kinds:['order-sales'],shop:true,hint:'上传官方逐单销售报告JSON（header/rows，合同CNY）。用于校对，不重复累计月报；SKU月报不能代替逐单报告。'},
 {value:'auto',label:'平台报告 · 自动识别',hint:'Z店销售报告、服务书、结算报告等；选择实际店铺。'},
 {value:'sales',label:'销售报告（销售、退货与补贴）',kinds:['sales'],shop:true,hint:'上传平台销售报告XLSX，按正文业务月份核对。取消未成交订单不自动记为收入。'},
 {value:'platform-fees',label:'平台费用服务书 / 综合凭证',kinds:['platform-invoice','recharged-service','star-service','platform-adjustment'],shop:true,hint:'上传UTD、转收费报告或星级推广服务书；综合凭证只记一次。'},
 {value:'compensation',label:'平台赔偿报告',kinds:['compensation'],shop:true,hint:'选择赔偿所属业务月份，不按下载日期归属。'},
 {value:'settlement',label:'平台结算与付款',kinds:['balance','currency-settlement','platform-payments'],shop:true,hint:'平台结算不等于营业额，不重复记为收入。'},
 {value:'collection-cash',label:'连连入账 / 提现流水',kinds:['collection-cash'],shared:true,hint:'公司共用上传一次；流水按实际交易日期筛选，CNY与CNH分列。'},
 {value:'manual-expense',label:'公司或店铺费用 · 手工录入',hint:'单笔录入CNY金额并附账单、合同或付款记录；发票可随后作为配套凭证补传。工资从现有工资管理录入。'},
 {value:'support',label:'发票 / 配套凭证（仅归档）',hint:'仅补充凭证，不再记一笔费用。可关联已有业务单据；俄文发票不直接折算重复入账。'},
 {value:'payroll',label:'工资社保表（仅归档）',hint:'这里只存凭证；已审批工资自动进入公司报表，不重复记费。'}
];
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
export function financePeriods(year,mode='month') {
 if(!/^20\d{2}$/.test(String(year))||!['month','quarter','year'].includes(mode))throw new Error('请选择有效年度及月度、季度或年度口径');
 const month=n=>`${year}-${String(n).padStart(2,'0')}`;
 if(mode==='year')return [{id:String(year),label:`${year}全年`,from:month(1),to:month(12)}];
 if(mode==='quarter')return Array.from({length:4},(_,i)=>({id:`${year}-Q${i+1}`,label:`第${i+1}季度`,from:month(i*3+1),to:month(i*3+3)}));
 return Array.from({length:12},(_,i)=>({id:month(i+1),label:`${i+1}月`,from:month(i+1),to:month(i+1)}));
}
export const financeLineSign=metric=>metric==='销售退回冲减额'?-1:1;
export function financeMatrix(lines,year,mode) {
 const periods=financePeriods(year,mode);
 const known=new Set(FINANCE_GROUPS.flatMap(g=>g.metrics));
 const extra=[...new Set(lines.map(l=>l.metric).filter(m=>!known.has(m)))];
 const groups=FINANCE_GROUPS.map(g=>({...g,metrics:g.id==='other'?[...g.metrics,...extra]:g.metrics}));
 const cells=(metrics,signed=false)=>Object.fromEntries(periods.map(p=>{
  const selected=lines.filter(l=>l.month>=p.from&&l.month<=p.to&&metrics.includes(l.metric)&&l.currency==='CNY');
  return [p.id,selected.length?round(selected.reduce((n,l)=>n+l.amount*(signed?financeLineSign(l.metric):1),0)):null];
 }));
 const pending=metrics=>Object.fromEntries(periods.map(p=>[p.id,lines.some(l=>l.month>=p.from&&l.month<=p.to&&metrics.includes(l.metric)&&l.currency==='CNY'&&l.parse_status==='preview')]));
 const rows=groups.map(g=>({...g,pending_cells:pending(g.metrics),cells:cells(g.metrics,g.id==='income'),children:g.metrics.map(metric=>({id:`${g.id}:${metric}`,name:metric,metrics:[metric],pending_cells:pending([metric]),cells:cells([metric]),sign:g.sign,refund:metric==='销售退回冲减额'}))}));
 return {periods,rows};
}
export function financeSourceShops(lines,shops) {
 return [...new Set([...lines.map(l=>Number(l.shop_id||0)),...shops.map(s=>Number(s.id))])].map(id=>({id,name:id?(shops.find(s=>Number(s.id)===id)?.name||'店铺归属待核'):'公司共用',lines:lines.filter(l=>Number(l.shop_id||0)===id)}));
}

// Monthly billing accepts a separate year and month; an ISO month alone falls back to today.
export const financeExpenseRecordQuery=(companyId,month)=>({companyId:String(companyId),year:month.slice(0,4),month:month.slice(5)});

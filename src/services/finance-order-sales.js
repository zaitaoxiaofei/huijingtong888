import crypto from 'node:crypto';

const fail=message=>{throw Object.assign(new Error(message),{statusCode:400});};
const money=value=>{
 if(value==null||value==='')fail('逐单销售缺少金额，不能按零解析');
 const n=Number(value);if(!Number.isFinite(n)||n<0||Math.abs(n)>1e9||Math.abs(n*100-Math.round(n*100))>0.00001)fail('逐单销售金额须为非负数、最多两位小数');return n;
};
const add=values=>Math.round(values.reduce((s,v)=>s+v,0)*100)/100;
function component(value,side){
 if(value==null)return {amount:0,partner:0,bonus:0,quantity:0,standard_fee:0};
 const quantity=Number(value.quantity);if(!Number.isSafeInteger(quantity)||quantity<0)fail(`${side}数量无效`);
 // These fields are present (including explicit zeroes) in Ozon's original CNY report.
 for(const key of ['amount','stars','bank_coinvestment','pick_up_point_coinvestment','bonus','standard_fee'])if(value[key]==null)fail(`逐单销售缺少${key}，请上传完整官方报告，不能补零`);
 return {amount:money(value.amount),partner:add(['stars','bank_coinvestment','pick_up_point_coinvestment'].map(k=>money(value[k]))),bonus:money(value.bonus),quantity,standard_fee:money(value.standard_fee)};
}
export function parseOrderSalesJson(buffer,{month,inferMonth=false}){
 let value;try{value=JSON.parse(buffer.toString('utf8'));}catch{fail('逐单销售JSON无效，请保留Ozon原始header和rows');}
 const {header:h,rows}=value||{};
 if(!h||!Array.isArray(rows)||!rows.length||rows.length>20000)fail('需要Ozon逐单销售报告header及1—20000行rows，不支持截图或手工金额JSON');
 if(h.currency_sys_name!=='CNY')fail('当前逐单核定仅支持合同CNY原始报告，其他币种不能猜测折算');
 if(!/^\d+$/.test(String(h.number||''))||!/^9[0-9A-Z]{17}$/.test(h.receiver_inn||''))fail('逐单报告缺少凭证编号或购买方税号，请下载完整原件');
 if(inferMonth&&!month&&/^20\d{2}-(0[1-9]|1[0-2])-01$/.test(h.start_date||''))month=h.start_date.slice(0,7);
 if(!month)fail('无法识别逐单报告的业务月份，请选择月份后重试');
 const last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
 if(h.start_date!==`${month}-01`||h.stop_date!==last)fail('逐单报告正文起止月份与所选业务月不符，请按正文月份上传');
 const seen=new Set();
 const order_rows=rows.map(r=>{
  const posting=String(r?.order?.posting_number||''),sku=String(r?.item?.sku||''),row=Number(r?.row_number);
  if(posting.length>128||sku.length>64||!/^\d+-\d+-\d+$/.test(posting)||!/^\d+$/.test(sku)||!Number.isSafeInteger(row)||row<1||seen.has(row))fail('逐单报告货件号、SKU或商品行编号缺失/重复，停止解析');seen.add(row);
  if(!Object.hasOwn(r,'delivery_commission')||!Object.hasOwn(r,'return_commission'))fail('逐单报告缺少销售/退回字段，请上传完整原件');
  if(r.delivery_commission==null&&r.return_commission==null)fail('逐单报告商品行缺少销售和退回内容');
  const sold=component(r.delivery_commission,'销售'),returned=component(r.return_commission,'退回');
  return {posting_number:posting,sku,row_number:row,sold:sold.amount,returned:returned.amount,partner:sold.partner,partner_returned:returned.partner,bonus:sold.bonus,bonus_returned:returned.bonus,sold_quantity:sold.quantity,returned_quantity:returned.quantity,standard_fee:sold.standard_fee,standard_fee_returned:returned.standard_fee};
 });
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify(order_rows)).digest('hex');
 return {version:'ozon-order-sales-1',kind:'order-sales',month,period:{from:month,to:month},currency:'CNY',document_number:String(h.number),buyer_tax_number:h.receiver_inn,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),business_key:crypto.createHash('sha256').update(`order-sales:${h.receiver_inn}:${month}:${h.number}`).digest('hex'),order_rows,order_fingerprint:fingerprint,facts:[],cash:[],controls:[],warnings:['逐单报告用于校对和确认调整；月度销售报告仍是公司汇总来源，不重复累计。原件已列合同CNY，不使用物流汇率二次折算。']};
}

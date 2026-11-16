import {summarizeOzonReturns} from './ozon-return-state.js';
const round=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
export function officialReturnReportRow(row,legacy) {
  if (Object.hasOwn(legacy,'official_actual_inputs_json')) { const {official_actual_inputs_json, ...display}=legacy; legacy=display; }
  const observations=(row.aftersale?.observations||[]).filter(r=>r.product?.sku==null||String(r.product.sku)===String(row.ozon_sku||''));
  const summary=summarizeOzonReturns(observations);
  if(!summary||summary.group==='closed')return legacy;
  const unmapped=observations.some(r=>r.product?.sku==null);
  const full=!unmapped&&['refunded','disposed','disposing','returned_to_warehouse','return_received'].includes(summary.status);
  const bucket=full?'official_after_delivery_return':!unmapped&&summary.status==='partial_compensation'?'official_partial_compensation':unmapped||summary.system_review?'official_possible_return':'official_return_processing';
  const quantities=observations.filter(r=>!['Solved','Cancelled'].includes(r.state?.state)).map(r=>r.product?.quantity);
  const explicitQuantity=quantities.length>0&&quantities.every(n=>Number.isSafeInteger(n)&&n>0);
  const knownQuantity=!unmapped&&(explicitQuantity||Number(row.quantity)===1);
  let inputs;try{inputs=typeof row.official_actual_inputs_json==='string'?JSON.parse(row.official_actual_inputs_json):row.official_actual_inputs_json;}catch{}
  const proof=inputs?.return_evidence||[];
  const reviewed=observations.filter(r=>!['Solved','Cancelled'].includes(r.state?.state)).every(r=>proof.some(p=>String(p.return_id)===String(r.return_id)&&String(p.sku)===String(row.ozon_sku)&&p.state===r.state?.state));
  const actual=unmapped||!reviewed||row.official_actual_profit_cny==null?null:Number(row.official_actual_profit_cny);
  return {...legacy,aftersale:summary,bucket,bucket_label:unmapped?'售后商品待匹配':summary.label,bucket_hint:'独立官方售后记录；日期按原订单归属月，退款完成时间未由接口提供。',
    outcome_type:full?'after_delivery_return':legacy.outcome_type,
    reason_label:summary.label,reason_code:summary.status,needs_review:summary.needs_review||actual===null||!knownQuantity||Boolean(inputs?.settlement_quality&&inputs.settlement_quality!=='official')?1:0,
    quantity:knownQuantity?(explicitQuantity?Math.min(Number(row.quantity),quantities.reduce((n,q)=>n+q,0)):1):0,
    return_quantity_unknown:knownQuantity?0:1,
    booked_profit_cny:row.official_actual_profit_cny,
    aftersale_accounting_review_required:!reviewed,
    actual_loss_cny:actual===null?null:round(Math.max(0,-actual)),
    estimated_loss_cny:actual===null?null:round(Math.max(0,-actual)),
    total_loss_cny:actual===null?null:round(Math.max(0,-actual)),
    component_loss_cny:null,loss_policy:'按账本净销售、实际费用与成本核算；部分补偿不清零整单，货物回收另凭证确认',
    should_include_aftersale_loss:1,official_return_record:1};
}

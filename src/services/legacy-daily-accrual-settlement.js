import {getProfitFormula} from './profit-formulas/registry.js';
import {readOrderFxFinanceRows} from './order-profit-fx-finance.js';
import {profitCalculationFingerprint} from './order-profit-calculation-versions.js';
const round=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const pending=code=>({ok:false,code,items:[]});
export function legacyDailyBatchDecision(policy,orderId,checkAllowlist=true){
 if(!policy)return null;
 if(!['allowlist','holdlist'].includes(policy.mode)||!Array.isArray(policy.held_order_ids)||!Array.isArray(policy.allowed_order_ids)
   ||[...policy.held_order_ids,...policy.allowed_order_ids].some(id=>!Number.isSafeInteger(Number(id))||Number(id)<=0))throw Error('真实利润补算清单配置无效，已停止写入');
 if(policy.held_order_ids.some(id=>Number(id)===Number(orderId)))return 'LEGACY_DAILY_USER_HOLD';
 if(checkAllowlist&&policy.mode==='allowlist'&&!policy.allowed_order_ids.some(id=>Number(id)===Number(orderId)))return 'LEGACY_DAILY_OUTSIDE_APPROVED_BATCH';
 return null;
}
export async function readLegacyDailyFinance({query,order,items,classifyCategory,lockForSettlement=false,legacyCurrencyEvidence=[]}){
 const result=await readOrderFxFinanceRows({query,order,items,classifyCategory,lockForSettlement,
  rateRubPerCny:1,allocationRateRubPerCny:1,legacySaleWeights:true,allowLegacyParentCollecting:true,
  convertRows:async(rows,options)=>{
   const parsed=getProfitFormula('V5').finance.convertLegacyDailyRows(rows,{...options,legacyCurrencyEvidence});
   if(!parsed.ok||!rows.length)return parsed;
   const ids=[...new Set(parsed.source_rows.map(r=>r.fx_id).filter(Boolean))];
   const archives=ids.length?await query(`SELECT id,DATE_FORMAT(business_date,'%Y-%m-%d') business_date,DATE_FORMAT(source_date,'%Y-%m-%d') source_date,currency_from,currency_to,source,rate FROM order_profit_daily_fx_rates WHERE id IN (${ids.map(()=>'?').join(',')})${lockForSettlement?' FOR SHARE':''}`,ids):[];
   const lookup=new Map(archives.map(r=>[String(r.id),r]));
   for(const row of rows){if(!String(row.operation_id).startsWith('accrual_by_day:'))continue;const raw=typeof row.raw_json==='string'?JSON.parse(row.raw_json):row.raw_json;const quote=raw._erp_fx_archive,stored=lookup.get(String(quote.id));
    if(!stored||['business_date','source_date','currency_from','currency_to','source'].some(key=>(stored[key] instanceof Date?stored[key].toISOString().slice(0,10):String(stored[key]))!==String(quote[key]))||Number(stored.rate)!==Number(quote.rate))return {ok:false,code:'LEGACY_DAILY_FX_ARCHIVE_MISMATCH',rows:[],source_rows:[]};
   }
   return parsed;
  }});
 if(result.allocation)result.allocation={...result.allocation,allocation_rate_rub_per_cny:null,allocation_basis:'frozen_legacy_cny_sale'};
 return result;
}
export function legacyDailySettlementFingerprint({order,items,finance,review}){
 return profitCalculationFingerprint({order,items,finance,...(review?{review}:{})});
}
// Pure projection; application and preview use this exact planner.
export async function planLegacyDailySettlement({order,items,finance,accounting,packagingFeeForSaleAmount}){
 if(!finance?.ok)return pending(finance?.code||'LEGACY_DAILY_FINANCE_PENDING');
 if(finance.income_mode!=='signed_accruals')return pending('LEGACY_DAILY_SOURCE_REQUIRED');
 if(!items.length||items.some(i=>!['V1','V5'].includes(i.formula_version||'V1')))return pending('LEGACY_DAILY_FORMULA_MIXED');
 const outcome=accounting.outcome_type;
 if(outcome==='active')return pending('LEGACY_DAILY_TERMINAL_STATUS_PENDING');
 // Cancellation and return accounting have different loss semantics. Preserve
 // the published legacy path until their own explicit compatibility is reviewed.
 if(outcome!=='delivered_signed')return pending('LEGACY_DAILY_OUTCOME_REVIEW_REQUIRED');
 const formula=getProfitFormula('V5'),signed=finance.category_signed_totals_cny;
 if(Object.entries(signed).some(([key,value])=>key!=='income'&&value>0.005))return pending('LEGACY_DAILY_CREDIT_REVIEW_REQUIRED');
 const totals=Object.fromEntries(Object.entries(signed).map(([k,v])=>[k,round(Math.max(0,-v))]));
 const sale=Number(finance.sale_accrual_cny);
 const purchaseKnown=items.every(i=>Number(i.purchase_cost_cny)>0||Number(i.frozen_purchase_cost)>0);
 if(!purchaseKnown)return pending('LEGACY_DAILY_PURCHASE_COST_PENDING');
 if(!(sale>0)||!(totals.commission>0)||!Object.hasOwn(signed,'collecting_fee')||!((totals.platform_delivery||0)+(totals.international_transport||0)>0))return pending('LEGACY_DAILY_FINAL_BILL_INCOMPLETE');
 const weights=items.map(i=>Number(i.sale_price)*Number(i.quantity));
 if(weights.some(v=>!Number.isFinite(v)||v<=0))return pending('LEGACY_DAILY_ALLOCATION_UNKNOWN');
 const weight=weights.reduce((a,b)=>a+b,0);
 // Allocate rounded cents with the final item receiving the exact remainder.
 const allocate=total=>{let used=0;return weights.map((v,n)=>{const amount=n===weights.length-1?round(total-used):round(total*v/weight);used=round(used+amount);return amount;});};
 const sales=allocate(sale),commissions=allocate(totals.commission),shipping=allocate(round((totals.platform_delivery||0)+(totals.international_transport||0))),collecting=allocate(totals.collecting_fee),service=allocate(totals.other||0),aftersale=allocate(totals.aftersale_loss||0);
 const packages=await Promise.all(items.map((item,n)=>item.packaging_cost_cny!=null&&Number.isFinite(Number(item.packaging_cost_cny))&&Number(item.packaging_cost_cny)>=0?Number(item.packaging_cost_cny):packagingFeeForSaleAmount(sales[n])));
 const projections=items.map((item,n)=>{
  const purchaseCost=round(Number(item.purchase_cost_cny)>0?Number(item.purchase_cost_cny):Number(item.frozen_purchase_cost)*Number(item.quantity));
  const domesticShipping=round(Number(item.domestic_shipping_cny)||Number(item.frozen_domestic_shipping||0)*Number(item.quantity));
  const advertisingCost=round(Number(item.advertising_cost_cny||0));
  const values={terminalNoRevenue:false,itemSale:sales[n],purchaseCost,domesticShipping,actualInternationalShipping:shipping[n],packagingCost:packages[n],commissionFeeCny:commissions[n],actualServiceFeeCny:service[n],returnLoss:aftersale[n],advertisingCost,otherFee:collecting[n]};
  return {item,...values,...formula.aggregateActualProfit(values),commissionRate:sales[n]?commissions[n]/sales[n]:0,totalFinanceFeeCny:round(shipping[n]+commissions[n]+service[n]+collecting[n]+aftersale[n])};
 });
 return {ok:true,code:null,formulaVersion:'V5',financeFxPolicy:finance.source_rows.some(row=>row.fx_policy==='legacy_posted_conversion')?'archived_accrual_day_and_legacy_parent_posted_conversion':'archived_accrual_operation_day',categoryTotals:totals,saleAmount:round(sale),allocation:finance.allocation,items:projections};
}

// The caller provides an authorized shop predicate and whole-transaction retry.
// Read-only previews never call a writer or create a historical baseline.
export async function settleLegacyDailyOrder(deps,orderId,options={}){
 const load=async(query,lock=false)=>{
  const order=(await query(`SELECT o.*,s.tenant_id FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=? AND ${deps.shopPredicate}${lock?' FOR UPDATE':''}`,[Number(orderId)]))[0];
  if(!order)throw Object.assign(new Error('订单不存在或不属于当前企业'),{statusCode:404});
  const items=await query(`SELECT oi.*,opi.purchase_cost_cny,opi.domestic_shipping_cny,opi.packaging_cost_cny,opi.advertising_cost_cny,opi.profit_status,opi.is_locked,opi.lock_reason,opi.locked_at,st.formula_version,proof.inputs_json AS actual_inputs_json
    FROM order_items oi LEFT JOIN order_profit_items opi ON opi.order_item_id=oi.id
    LEFT JOIN order_profit_calc_state st ON st.order_item_id=oi.id AND st.tenant_key=CASE WHEN ?>0 THEN CAST(? AS CHAR) ELSE 'admin' END COLLATE utf8mb4_0900_ai_ci
    LEFT JOIN order_profit_calc_revisions proof ON proof.id=st.current_actual_revision_id AND proof.tenant_key=st.tenant_key AND proof.order_item_id=oi.id AND proof.layer='actual'
    WHERE oi.order_id=? AND oi.quantity>0 ORDER BY oi.id${lock?' FOR UPDATE':''}`,[order.tenant_id,order.tenant_id,order.id]);
  const retained=items.flatMap(item=>{
    let inputs;try{inputs=typeof item.actual_inputs_json==='string'?JSON.parse(item.actual_inputs_json):item.actual_inputs_json;}catch{return [];}
    return (inputs?.finance_rows||[]).filter(row=>row.currency_source==='user_confirmation'&&row.currency_reference).map(row=>({shop_id:row.shop_id,operation_id:row.operation_id,finance_item_id:row.id,verified:true,currency_code:row.currency,source:'user_confirmation',reference:row.currency_reference}));
  });
  const finance=await readLegacyDailyFinance({query,order,items,classifyCategory:deps.classifyCategory,lockForSettlement:lock,legacyCurrencyEvidence:[...(options.legacy_currency_evidence||[]),...retained]});
  const accounting=getProfitFormula('V5').outcome.classifyOrderAccounting(order);
  let review=options.reviewed_settlement_policy||null;
  if(!review&&items.some(i=>i.formula_version==='V6')){
   try{const inputs=typeof items[0].actual_inputs_json==='string'?JSON.parse(items[0].actual_inputs_json):items[0].actual_inputs_json;review=inputs?.reviewed_settlement_policy||null;}catch{}
  }
  if(review?.order_ids?.includes(Number(order.id)))review={...review,order_ids:[Number(order.id)],returns:(review.returns||[]).filter(r=>Number(r.shop_id)===Number(order.shop_id)&&r.posting_number===order.posting_number)};
  const plan=review||items.some(i=>i.formula_version==='V6')
   ?await getProfitFormula('V6').planReviewedDailySettlement({order,items,finance,accounting,review})
   :await planLegacyDailySettlement({order,items,finance,accounting,packagingFeeForSaleAmount:deps.packagingFeeForSaleAmount});
  const token=legacyDailySettlementFingerprint({order,items,finance,...(review?{review}: {})});
  return {order,items,finance,plan,review,preview_token:token};
 };
 await deps.assertAuthorized();
 if(options.preview!==false){const value=await load(deps.query);return {...value.plan,order_id:value.order.id,preview:true,preview_token:value.preview_token};}
 return deps.transaction(async connection=>{
  await deps.assertAuthorized();
  const query=async(sql,args=[])=>(await connection.query(sql,args))[0];
  const current=await load(query,true);
  if(options.preview_token&&options.preview_token!==current.preview_token)throw Object.assign(new Error('订单或账单已变化，请重新预览'),{statusCode:409,code:'LEGACY_DAILY_PREVIEW_STALE'});
  if(!current.plan.ok)return {...current.plan,order_id:current.order.id};
  // Already confirmed historical V1 actuals are not silently migrated.
  if(current.items.some(i=>!['finance_accrued_legacy_daily','finance_reviewed_daily','finance_reviewed_daily_provisional'].includes(i.lock_reason)&&Number(i.is_locked)===1&&i.profit_status==='accrued'&&i.settlement_state==='accrued'))return pending('LEGACY_DAILY_EXISTING_ACTUAL_PROTECTED');
  const reviewed=current.plan.formulaVersion==='V6';
  const lockReason=reviewed?(current.plan.quality==='official'?'finance_reviewed_daily':'finance_reviewed_daily_provisional'):'finance_accrued_legacy_daily';
  for(const projection of current.plan.items){
   const {item}=projection;
   await deps.writeVersioned(item.id,{connection,layer:'actual',expectedFormulaVersion:item.formula_version||'V1',legacyDailyUpgrade:!reviewed,reviewedDailyUpgrade:reviewed,
    source:reviewed?'ozon_finance_reviewed_daily':'ozon_finance_legacy_daily',reason:'已核对账单补算；保留原预估及历史实际记录',
    inputs:{finance_model:current.plan.formulaVersion,upgraded_from:reviewed?'reviewed_legacy':'V1',finance_fx_policy:current.plan.financeFxPolicy,finance_rows:current.finance.source_rows,
     parent_allocation:current.finance.allocation,category_totals:current.plan.categoryTotals,
     costs:{purchase:projection.purchaseCost,domestic:projection.domesticShipping,packaging:projection.packagingCost,advertising:projection.advertisingCost},
     ...(reviewed?{reviewed_settlement_policy:current.review,settlement_quality:current.plan.quality,estimated_collecting:current.plan.estimatedCollecting,return_evidence:current.plan.returnEvidence}: {})},
    rateVersion:{finance_fx_policy:current.plan.financeFxPolicy,finance_rows:current.finance.source_rows},commandId:options.command_id||null},async()=>{
     await connection.execute("UPDATE order_items SET actual_profit=?,platform_fee_actual=?,settlement_state='accrued' WHERE id=?",[projection.actualProfit,projection.totalFinanceFeeCny,item.id]);
     await connection.execute(`INSERT INTO order_profit_items(order_item_id,sale_amount_cny,purchase_cost_cny,domestic_shipping_cny,international_shipping_cny,packaging_cost_cny,commission_rate,commission_fee_cny,ozon_service_fee_cny,return_loss_cny,advertising_cost_cny,other_fee_cny,gross_profit_cny,net_profit_cny,profit_status,is_locked,locked_at,lock_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'accrued',1,CURRENT_TIMESTAMP,'finance_accrued_legacy_daily')
      ON DUPLICATE KEY UPDATE sale_amount_cny=VALUES(sale_amount_cny),purchase_cost_cny=VALUES(purchase_cost_cny),domestic_shipping_cny=VALUES(domestic_shipping_cny),international_shipping_cny=VALUES(international_shipping_cny),packaging_cost_cny=VALUES(packaging_cost_cny),commission_rate=VALUES(commission_rate),commission_fee_cny=VALUES(commission_fee_cny),ozon_service_fee_cny=VALUES(ozon_service_fee_cny),return_loss_cny=VALUES(return_loss_cny),advertising_cost_cny=VALUES(advertising_cost_cny),other_fee_cny=VALUES(other_fee_cny),gross_profit_cny=VALUES(gross_profit_cny),net_profit_cny=VALUES(net_profit_cny),profit_status='accrued',is_locked=1,locked_at=CURRENT_TIMESTAMP,lock_reason='finance_accrued_legacy_daily'`,
      [item.id,projection.itemSale,projection.purchaseCost,projection.domesticShipping,projection.actualInternationalShipping,projection.packagingCost,projection.commissionRate,projection.commissionFeeCny,projection.actualServiceFeeCny,projection.returnLoss,projection.advertisingCost,projection.otherFee,projection.grossProfit,projection.actualProfit]);
     if(reviewed){
      const status=current.plan.quality==='official'?'accrued':'reviewed_provisional';
      await connection.execute('UPDATE order_items SET settlement_state=? WHERE id=?',[status,item.id]);
      await connection.execute('UPDATE order_profit_items SET profit_status=?,lock_reason=?,locked_at=COALESCE(?,locked_at) WHERE order_item_id=?',[status,lockReason,item.locked_at||null,item.id]);
     }
    });
  }
  return {...current.plan,order_id:current.order.id,updated:current.plan.items.length};
 });
}

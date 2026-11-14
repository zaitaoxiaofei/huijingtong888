import { validateDailyFxSnapshot, moneyToCny } from '../v2/fx.js';
import { resolveFxFinanceCurrency } from '../../order-profit-fx-finance.js';
const fields=['amount','accruals_for_sale','sale_commission','delivery_charge','return_delivery_charge'];
const fail=code=>({ok:false,code,rows:[],source_rows:[],unknown_rows:[]});
// V5 retains the posted operation-day conversion, rather than inventing an
// order/signature-day FX snapshot for legacy orders whose originals are absent.
export function convertLegacyDailyRows(source,{shopId,legacyCurrencyEvidence=[]}) {
 const rows=[],source_rows=[],operations=new Map(),seen=new Set();
 for(const row of source){
  if(Number(row.shop_id)!==Number(shopId))return fail('LEGACY_DAILY_SHOP_MISMATCH');
  if(!String(row.operation_id).startsWith('accrual_by_day:')){
   const evidence=legacyCurrencyEvidence.find(value=>Number(value.shop_id)===Number(shopId)&&String(value.operation_id)===String(row.operation_id)&&String(value.finance_item_id)===String(row.id));
   const currency=resolveFxFinanceCurrency(row,{shopId,currencyEvidence:evidence});if(!currency.ok)return fail(currency.code);
   if(evidence&&currency.currency!==evidence.currency_code)return fail('FX_FINANCE_CURRENCY_CONFLICT');
   const rate=Number(row.exchange_rate);if(!(rate>0))return fail('LEGACY_DAILY_LEGACY_RATE_MISSING');
   const result={...row,currency_code:currency.currency,currency_source:currency.source};
   for(const field of fields){const value=Number(row[field]),saved=Number(row[field+'_cny']);
    const converted=value/(currency.currency==='RUB'?rate:1),legacyRounded=Math.round((converted+Number.EPSILON)*100)/100;
    if(row[field]==null||row[field+'_cny']==null||!Number.isFinite(value)||!Number.isFinite(saved)||(Math.abs(saved-converted)>.00011&&Math.abs(saved-legacyRounded)>.000001))return fail('LEGACY_DAILY_CONVERSION_MISMATCH');
    result[field]=value;result[field+'_cny']=saved;
   }
   result.fee_amount=Math.max(0,-result.amount);result.fee_amount_cny=Math.max(0,-result.amount_cny);rows.push(result);
   source_rows.push({id:row.id,operation_id:row.operation_id,posting_number:row.posting_number,fx_policy:'legacy_posted_conversion',exchange_rate:rate,currency:currency.currency,currency_source:currency.source,currency_reference:currency.reference||null,shop_id:row.shop_id,amount:result.amount,amount_cny:result.amount_cny});continue;
  }
  let raw;try{raw=typeof row.raw_json==='string'?JSON.parse(row.raw_json):row.raw_json;}catch{return fail('LEGACY_DAILY_SOURCE_INVALID');}
  if(!String(row.operation_id).startsWith('accrual_by_day:')||raw?._source_endpoint!=='/v1/finance/accrual/by-day'||raw?._normalization?.reconciliation?.ok!==true)return fail('LEGACY_DAILY_NORMALIZATION_PENDING');
  const currency=resolveFxFinanceCurrency(row,{shopId});if(!currency.ok)return fail(currency.code);
  let fx;try{fx=validateDailyFxSnapshot(raw._erp_fx_archive,{businessDate:String(row.operation_date instanceof Date?row.operation_date.toISOString():row.operation_date).slice(0,10)});}catch{return fail('LEGACY_DAILY_FX_ARCHIVE_MISSING');}
  const identity=`${row.operation_id}:${row.service_type}`;if(seen.has(identity))return fail('LEGACY_DAILY_DUPLICATE_LINE');seen.add(identity);
  const total=Number(raw._normalization.reconciliation.total_amount);if(!Number.isFinite(total))return fail('LEGACY_DAILY_TOTAL_MISSING');
  const operation=operations.get(row.operation_id)||{total,currency:currency.currency,amount:0};
  if(operation.currency!==currency.currency||operation.total!==total)return fail('LEGACY_DAILY_OPERATION_CONFLICT');
  operation.amount+=Number(row.amount);operations.set(row.operation_id,operation);
  const result={...row,currency_code:currency.currency,currency_source:currency.source};
  for(const field of fields){
   if(row[field]===null||row[field]===undefined||row[`${field}_cny`]===null||row[`${field}_cny`]===undefined)return fail('LEGACY_DAILY_AMOUNT_MISSING');
   const amount=Number(row[field]),saved=Number(row[`${field}_cny`]);
   if(!Number.isFinite(amount)||!Number.isFinite(saved)||Math.abs(saved-moneyToCny(amount,currency.currency,fx))>.00011)return fail('LEGACY_DAILY_CONVERSION_MISMATCH');
   result[field]=amount;result[`${field}_cny`]=saved;
  }
  result.fee_amount=Math.max(0,-result.amount);result.fee_amount_cny=Math.max(0,-result.amount_cny);rows.push(result);
  source_rows.push({id:row.id,operation_id:row.operation_id,posting_number:row.posting_number,fx_id:fx.id,fx_business_date:fx.business_date,currency:currency.currency,amount:result.amount,amount_cny:result.amount_cny});
 }
 if([...operations.values()].some(op=>!Number.isFinite(op.amount)||Math.abs(op.amount-op.total)>.00011))return fail('LEGACY_DAILY_OPERATION_INCOMPLETE');
 return {ok:true,rows,source_rows,unknown_rows:[]};
}

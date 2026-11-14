import {createHash} from 'node:crypto';
const fail=()=>{throw Object.assign(Error('旧新账单逐笔核对依据缺失、过期或有重复风险，停止补录'),{code:'ORDER_FINANCE_BOUNDARY_REVIEW_INVALID',statusCode:409});};
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
export function reviewedBoundaryUnits(operation){
 const unit=String(operation.posting_number||operation.unit_number||'');
 if(!/^\d+-\d+(?:-\d+)?$/.test(unit))fail();
 const parent=unit.split('-').slice(0,2).join('-');return {unit,parent};
}
export function createReviewedBoundaryProof({shopId,tenantKey,operation,businessDate,legacyRows,reference}){
 if(!Number.isSafeInteger(Number(shopId))||Number(shopId)<=0||tenantKey==null||!String(tenantKey).trim()||!String(reference||'').trim()||!Array.isArray(legacyRows)
  ||!operation?.reconciliation?.ok||!Array.isArray(operation.rows)||!operation.rows.length
  ||!String(operation.operation_id||'').startsWith('accrual_by_day:')||String(operation.operation_date).slice(0,10)!==businessDate)fail();
 const {unit,parent}=reviewedBoundaryUnits(operation),categories=new Set(operation.rows.map(r=>r.normalized_category));
 const material=legacyRows.map(r=>{
  if(Number(r.shop_id)!==Number(shopId)||String(r.operation_id).startsWith('accrual_by_day:')
    ||!(r.posting_number===parent||String(r.posting_number).startsWith(parent+'-')))fail();
  // Only independently preserved legacy acquiring rows may coexist with a
  // different daily category. Unknown legacy representations remain blocked.
  const acquiring=/MarketplaceRedistributionOfAcquiringOperation/i.test([r.service_type,r.service_name,r.operation_type].join(' '));
  if(!acquiring||categories.has('collecting_fee')||Number(r.accruals_for_sale)!==0)fail();
  if(![r.amount,r.accruals_for_sale].every(x=>x!=null&&Number.isFinite(Number(x))))fail();
  return {id:String(r.id),shop_id:Number(r.shop_id),operation_id:String(r.operation_id),posting_number:r.posting_number,
   service_type:r.service_type,service_name:r.service_name,amount:Number(r.amount).toFixed(4),accruals_for_sale:Number(r.accruals_for_sale).toFixed(4)};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 return {version:1,shop_id:Number(shopId),tenant_key:String(tenantKey),operation_id:operation.operation_id,
  business_date:businessDate,unit,parent,reference:String(reference),operation_hash:digest(operation),legacy_rows_hash:digest(material),legacy_row_ids:material.map(r=>r.id)};
}
export function verifyReviewedBoundaryProof(proof,input){
 if(!proof||proof.version!==1)fail();
 const expected=createReviewedBoundaryProof({...input,reference:proof.reference});
 if(canonical(expected)!==canonical(proof))fail();return expected;
}

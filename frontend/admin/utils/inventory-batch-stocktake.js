import {validateInventoryAdjustment} from '../../../src/inventory-adjustment-reasons.js';
export function stocktakePayload(row,requestKey){
 const n=row.counted_quantity;
 if(n===null||n===''||!Number.isSafeInteger(Number(n))||Number(n)<0)throw Error('请填写实际数量，无货请填0');
 if(!row.ledger||row.ledger.physical_estimate==null)throw Error('当前实物数量不完整，请先核对库存流水');
 validateInventoryAdjustment(row.reason_code,row.reason_note,Number(n)-Number(row.ledger.physical_estimate));
 return {product_id:row.product_id,counted_quantity:Number(n),reason_code:row.reason_code,reason_note:row.reason_note,action_type:'stocktake',stocktake_type:'physical',revision:row.ledger.revision,request_key:requestKey};
}
export async function submitStocktakeRows(rows,api,isCurrent){
 for(const row of rows){
  if(!isCurrent())break;
  if(row.status==='success')continue;
  row.error='';
  try{
   row.payload ||= stocktakePayload(row,crypto.randomUUID());
   row.status='saving';
   await api.post('/api/inventory/ledger',row.payload);
   if(!isCurrent())break;
   row.status='success';
  }catch(e){
   if(!isCurrent())break;
   row.status='error';row.error=e.message;
   if([400,403,404,409].includes(e.status)){
    row.payload=null;
    if(e.status===409){row.ledger=null;row.error='库存已变化，请重新读取并核对后提交';}
   }
   if(e.status===401||e.status===403)break;
  }
 }
}

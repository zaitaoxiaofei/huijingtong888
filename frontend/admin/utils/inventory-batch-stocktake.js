import {validateInventoryAdjustment} from '../../../src/inventory-adjustment-reasons.js';
export function stocktakePayload(row,requestKey){
 const n=row.counted_quantity;
 if(n===null||n===''||!Number.isSafeInteger(Number(n))||Number(n)<0)throw Error('请填写实际数量，无货请填0');
 if(!row.ledger||row.ledger.physical_estimate==null)throw Error('当前实物数量不完整，请先核对库存流水');
 validateInventoryAdjustment(row.reason_code,row.reason_note,Number(n)-Number(row.ledger.physical_estimate));
 return {product_id:row.product_id,counted_quantity:Number(n),reason_code:row.reason_code,reason_note:row.reason_note,action_type:'stocktake',stocktake_type:'physical',revision:row.ledger.revision,request_key:requestKey};
}
export function fillStocktakeQuantities(rows,quantity){
 if(quantity===null||quantity===''||!Number.isSafeInteger(Number(quantity))||Number(quantity)<0)throw Error('批量填入数量须为非负整数');
 for(const row of rows)if(row.status!=='success'&&!row.payload)row.counted_quantity=Number(quantity);
}
export async function submitStocktakeRows(rows,api,isCurrent,state){
 if(!isCurrent())return;
 if(!state.payload){
  const items=rows.filter(r=>r.status!=='success').map(r=>{const p=stocktakePayload(r,'batch');return {product_id:p.product_id,counted_quantity:p.counted_quantity,revision:p.revision,reason_code:p.reason_code,reason_note:p.reason_note};});
  state.payload={request_key:crypto.randomUUID(),items};
 }
 const targets=rows.filter(r=>state.payload.items.some(i=>i.product_id===r.product_id));
 for(const row of targets){row.payload=state.payload;row.status='saving';row.error='';}
 try{
  const result=await api.post('/api/inventory/batch-stocktake',state.payload);
  if(!isCurrent())return;
  if(result.results?.length!==targets.length||new Set(result.results.map(r=>Number(r.product_id))).size!==targets.length||targets.some(r=>!result.results.some(i=>Number(i.product_id)===Number(r.product_id))))throw Error('批量结果不完整，请重试确认，操作不会重复入账');
  for(const row of targets)row.status='success';
 }catch(e){
  if(!isCurrent())return;
  const definitive=[400,403,404,409].includes(e.status);
  for(const row of targets){row.status='error';row.error=e.message;if(definitive){row.payload=null;if(e.status===409)row.ledger=null;}}
  if(definitive)state.payload=null;
 }
}

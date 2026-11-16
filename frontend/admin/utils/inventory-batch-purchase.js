export function purchaseBackfillPayload(row,key){
 if(row.order_item_ids&&!row.order_date)throw Error('关联订单缺少下单日期（ordered_at），请先核对并同步订单信息');
 if(row.order_item_ids&&row.purchased_at!==row.order_date)throw Error('订单下单日期已变化，请重新读取订单');
 const quantity=Number(row.quantity),amount=Number(row.amount),shipping=Number(row.shipping_amount||0);
 if(row.quantity==null||row.quantity===''||!Number.isSafeInteger(quantity)||quantity<=0||quantity>Number(row.missing_quantity??row.ledger?.missing_purchase??0))throw Error('补录数量须为正整数且不超过缺采购数量');
 if(row.amount==null||row.amount===''||!Number.isFinite(amount)||amount<=0)throw Error('请填写实际总货款');
 if(!Number.isFinite(shipping)||shipping<0)throw Error('采购运费不能为负数');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(row.purchased_at||'')||!Number.isFinite(Date.parse(row.purchased_at))||new Date(row.purchased_at).toISOString().slice(0,10)!==row.purchased_at)throw Error('请填写真实采购日期');
 return {...(row.order_item_ids?{order_item_ids:row.order_item_ids,purchase_date_basis:'order_date'}:{}),product_id:row.product_id,quantity,amount,shipping_amount:shipping,purchased_at:row.purchased_at+'T00:00:00+08:00',action_type:'historical_purchase_bulk',inventory_effect:'already_accounted',reason:row.order_item_ids?`补录缺失采购记录；按关联订单日期；${row.average&&!row.unit_cost_manual&&!row.amount_manual?'货款按历史采购加权均价预填':'货款经人工填写或调整'}`:'补录缺失采购记录',revision:row.ledger.revision,request_key:key};
}
export async function submitPurchaseBackfills(rows,api,isCurrent){
 for(const row of rows){
  if(!isCurrent())break;
  if(row.status==='success')continue;
  if(!row.payload||!row.preview)throw Error('请先预览采购补录影响');
  row.error='';row.status='saving';
  try{
   if(row.payload.purchase_date_basis==='order_date'&&!row.attempted){
    const ledger=await api.get(`/api/procurement/ledger?product_id=${row.product_id}`,{noCache:true});if(!isCurrent())break;
    const payload={...row.payload,revision:ledger.revision};
    const preview=await api.post('/api/procurement/ledger/preview',payload);if(!isCurrent())break;
    const signature=p=>JSON.stringify({local_before:p.local_before,local_after:p.local_after,allocations:p.allocations});
    if(signature(preview)!==signature(row.preview))throw Object.assign(Error('订单覆盖或库存已变化，请重新读取并预览'),{status:409});
    row.payload=payload;
   }
   row.attempted=true;
   await api.post('/api/procurement/ledger',row.payload);if(!isCurrent())break;row.status='success';}
  catch(e){if(!isCurrent())break;row.status='error';row.error=e.message;
   if([400,403,404,409].includes(e.status)){row.payload=null;row.preview=null;row.attempted=false;if(e.status===409){row.ledger=null;row.error='采购记录已变化，请重新读取并预览';}}
   if([401,403].includes(e.status))break;
  }
 }
}

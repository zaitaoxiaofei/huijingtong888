import { createHash } from 'node:crypto';
import { buildSplitShippingPackagesMysql } from './mysql-order-shipping-packages.js';
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{statusCode});};
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const sameProducts=(left,right)=>{
 const sum=rows=>{const m=new Map();for(const r of rows){const id=String(r.product_id);m.set(id,(m.get(id)||0)+Number(r.quantity));}return JSON.stringify([...m].sort());};
 return sum(left)===sum(right);
};
export function validateSplitReceipt(response,original,packages){
 const data=response?.result||response;
 if(data?.parent_posting?.posting_number!==original||!Array.isArray(data.postings)||!data.postings.length)fail('Ozon 未返回可核实的拆单结果，请核对官方子单；未自动备货',502);
 const usable=rows=>rows.every(p=>p?.posting_number&&Array.isArray(p.products)&&p.products.length&&p.products.every(r=>Number.isSafeInteger(Number(r.product_id))&&Number(r.product_id)>0&&Number.isSafeInteger(Number(r.quantity))&&Number(r.quantity)>0));
 const candidates=[data.postings,...(data.postings.some(p=>p.posting_number===original)?[]:[[data.parent_posting,...data.postings]])];
 const allocationKey=rows=>JSON.stringify(rows.map(p=>JSON.stringify([...p.products].map(r=>[String(r.product_id),Number(r.quantity)]).sort())).sort());
 const valid=candidates.find(rows=>rows.length===packages.length&&new Set(rows.map(p=>p.posting_number)).size===rows.length&&usable(rows)&&sameProducts(packages.flatMap(p=>p.products),rows.flatMap(p=>p.products))&&allocationKey(packages)===allocationKey(rows));
 if(!valid)fail('Ozon 返回的子单或商品分配与请求不符，请核对官方结果；未自动备货',502);
 return {parent_posting:data.parent_posting,postings:valid};
}
export function createOrderSplitService({query,execute,authorize,splitRemote,fetchRemote,importPostings,fetchSiblings}){
 async function reconcile(operation,context){
  if(!operation.result_json){
   const created = operation.created_at instanceof Date ? operation.created_at.getTime() : Date.parse(String(operation.created_at||'').replace(' ','T').replace(/Z?$/,'Z'));
   const staleSubmitting = operation.state==='submitting' && Number.isFinite(created) && Date.now()-created>120000;
   if(!fetchSiblings || (operation.state!=='unknown'&&!staleSubmitting))fail('拆单请求仍在处理中或结果未核实，请稍后重新同步结果；不能重复拆单或自动备货');
   context=await authorize(operation.order_id);
   const siblings=await fetchSiblings(context);
   const postings=siblings.map(p=>({posting_number:p.posting_number,products:(p.items||[]).map(i=>({product_id:Number(i.ozon_product_id),quantity:Number(i.quantity)}))}));
   const receipt=validateSplitReceipt({parent_posting:{posting_number:operation.posting_number},postings},operation.posting_number,parse(operation.request_json).packages);
   await execute("UPDATE order_split_operations SET state='confirmed',result_json=? WHERE tenant_id=? AND id=?",[JSON.stringify(receipt),context.tenantId,operation.id]);
   operation={...operation,result_json:receipt,state:'confirmed'};
  }
  const receipt=parse(operation.result_json),numbers=[...new Set([operation.posting_number,...receipt.postings.map(p=>p.posting_number)])];
  const postings=[];
  for(const number of numbers){
   context=await authorize(operation.order_id);
   const posting=await fetchRemote(context.shop,number);
   if(posting?.posting_number!==number)fail(`子单 ${number} 的官方详情尚未返回，请稍后重新同步；未自动备货`);
   const expectedPosting=receipt.postings.find(p=>p.posting_number===number);
   if(expectedPosting&&!sameProducts(expectedPosting.products,(posting.items||[]).map(i=>({product_id:Number(i.ozon_product_id),quantity:Number(i.quantity)}))))fail(`子单 ${number} 的官方商品分配与拆单回执不一致，请核对后重新同步；未自动备货`);
   postings.push(posting);
  }
  const expected=receipt.postings.flatMap(p=>p.products);
  const actual=postings.filter(p=>receipt.postings.some(r=>r.posting_number===p.posting_number)).flatMap(p=>(p.items||[]).map(i=>({product_id:Number(i.ozon_product_id),quantity:Number(i.quantity)})));
  if(!sameProducts(expected,actual))fail('子单官方商品数量尚未与拆单回执一致，请核对后重新同步；未自动备货');
  context=await authorize(operation.order_id);
  // Import children first: a partial sync must not release the original demand before child demand exists.
  const rows=await importPostings(context,[...postings].sort((a,b)=>Number(a.posting_number===operation.posting_number)-Number(b.posting_number===operation.posting_number)));
  await execute("UPDATE order_split_operations SET state='synced',active_order_id=NULL,error_message=NULL WHERE tenant_id=? AND id=?",[context.tenantId,operation.id]);
  return {ok:true,split_confirmed:true,prepared:false,operation_id:Number(operation.id),posting_numbers:receipt.postings.map(p=>p.posting_number),orders:rows};
 }
 return async function split(body={},actorId){
  const orderId=Number(body.order_id),key=String(body.client_request_id||'');
  if(body.action==='inspect'){
   if(!Number.isSafeInteger(orderId)||orderId<=0)fail('订单编号无效',400);
   const context=await authorize(orderId);
   const row=(await query('SELECT * FROM order_split_operations WHERE tenant_id=? AND active_order_id=?',[context.tenantId,orderId]))[0];
   if(!row)return null;
   const saved=parse(row.request_json);
   return {request_key:row.request_key,state:row.state,packages:saved.allocation,items:saved.items};
  }
  if(!Number.isSafeInteger(orderId)||orderId<=0||!/^[A-Za-z0-9_-]{8,128}$/.test(key))fail('缺少订单或拆单操作标识，请重新打开拆单窗口',400);
  let context=await authorize(orderId);
  const previous=(await query('SELECT * FROM order_split_operations WHERE tenant_id=? AND request_key=?',[context.tenantId,key]))[0];
  const hash=createHash('sha256').update(JSON.stringify({orderId,packages:body.packages})).digest('hex');
  if(previous){
   if(Number(previous.order_id)!==orderId||previous.request_hash!==hash)fail('同一拆单操作不能修改分配内容，请先核对上次结果');
   if(previous.state==='failed')throw Object.assign(new Error(previous.error_message||'上次拆单未成功，请核对后重试'),{statusCode:409,validation:{split_retry_safe:true}});
   return reconcile(previous,context);
  }
  if(body.action==='reconcile')fail('没有找到该拆单操作，请先核对 Ozon 结果',404);
  const active=(await query('SELECT id FROM order_split_operations WHERE tenant_id=? AND active_order_id=?',[context.tenantId,orderId]))[0];
  if(active)fail('此订单已有尚未核实的拆单操作，请先核对其结果，不能重复拆单或自动备货');
  let live;
  try { live=await fetchRemote(context.shop,context.order.posting_number); }
  catch(error) { error.validation={...error.validation,split_retry_safe:true};throw error; }
  context=await authorize(orderId);
  if(live?.posting_number!==context.order.posting_number||live.status!=='awaiting_packaging')fail('Ozon 订单已不在待备货状态，请同步后核对，不能拆单或自动备货');
  const items=context.items.map(item=>{const match=(live.items||[]).filter(r=>String(r.ozon_sku)===String(item.ozon_sku));if(match.length!==1||Number(match[0].quantity)!==Number(item.quantity))fail('Ozon 商品数量已变化，请刷新订单后重新分配');return {...item,product_id:Number(match[0].ozon_product_id)};});
  if(items.length!==(live.items||[]).length||items.some(i=>!Number.isSafeInteger(i.product_id)||i.product_id<=0))fail('Ozon 商品组成尚未核实，请同步订单后重试');
  const packages=buildSplitShippingPackagesMysql(items,body.packages);
  let operationId;
  try{const result=await execute('INSERT INTO order_split_operations (tenant_id,order_id,shop_id,active_order_id,request_key,request_hash,posting_number,request_json,created_by) VALUES (?,?,?,?,?,?,?,?,?)',[context.tenantId,orderId,context.shop.id,orderId,key,hash,context.order.posting_number,JSON.stringify({packages,allocation:body.packages,items:context.items}),actorId]);operationId=result.insertId;}
  catch(error){if(error.code==='ER_DUP_ENTRY')fail('另一拆单请求已提交，请先核对结果，不能重复拆单');throw error;}
  let response;
  try{
   context=await authorize(orderId);
   response=await splitRemote(context.shop,context.order.posting_number,packages);
   const receipt=validateSplitReceipt(response,context.order.posting_number,packages);
   await execute("UPDATE order_split_operations SET state='confirmed',result_json=? WHERE tenant_id=? AND id=?",[JSON.stringify(receipt),context.tenantId,operationId]);
  }catch(error){
   const status=Number(error.statusCode||0),definite=status>=400&&status<500;
   await execute('UPDATE order_split_operations SET state=?,active_order_id=?,error_message=? WHERE tenant_id=? AND id=?',[definite?'failed':'unknown',definite?null:orderId,String(error.message||'拆单结果未知').slice(0,1000),context.tenantId,operationId]);
   error.validation={...error.validation,split_retry_safe:definite};
   throw error;
  }
  const operation=(await query('SELECT * FROM order_split_operations WHERE tenant_id=? AND id=?',[context.tenantId,operationId]))[0];
  try{return await reconcile(operation,context);}catch(error){
   // A confirmed upstream mutation must never be reported as safe to resubmit.
   if(Number(error.statusCode)===403)throw error;
   return {ok:false,split_confirmed:true,prepared:false,sync_pending:true,operation_id:Number(operationId),posting_numbers:parse(operation.result_json).postings.map(p=>p.posting_number),error:`Ozon 已确认拆单，子单同步待完成：${error.message}。请重新同步结果，勿重复拆单。`};
  }
 };
}

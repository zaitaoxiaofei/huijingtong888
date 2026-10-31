import {createHash} from 'node:crypto';
import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';
import {hasPermission} from '../shared/permissions.js';
import {loadInventoryComposition} from './inventory-composition.js';
import {physicalInventoryComponents} from '../shared/inventory-composition.js';
import {bundleReviewRevision,bundleReviewContentRevision,planPurchaseBundleReview,suggestBundleCostAllocation} from '../shared/purchase-bundle-review.js';
import {invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const timestamp=value=>{
 const utc=value instanceof Date?value:new Date(String(value).includes('T')?String(value):String(value).replace(' ','T')+'Z');
 return new Date(utc.getTime()+8*3600000).toISOString().slice(0,19)+'+08:00';
};

// Called inside the existing arrival/receipt transaction. Only current BOM
// rows are shared-locked; no global product graph or historical costs are locked.
export async function assertWholeBundleReview(q,scope,batch){
 const ids=new Set([Number(batch.product_id)]),edges=[];let frontier=[Number(batch.product_id)];
 for(let depth=0;frontier.length&&depth<12;depth++){
  const rows=await q(`SELECT c.product_id,c.component_product_id,c.quantity FROM product_components c WHERE c.product_id IN (${frontier.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'c')} FOR SHARE`,frontier);
  if(!depth&&!rows.length)return;
  edges.push(...rows);const next=[];for(const e of rows)if(!ids.has(Number(e.component_product_id))){ids.add(Number(e.component_product_id));next.push(Number(e.component_product_id));}frontier=next;
 }
 const components=physicalInventoryComponents(batch.product_id,[...ids].map(id=>({id,active:1})),edges);
 const [row]=await q("SELECT detail_json FROM inventory_flow_events WHERE tenant_id=? AND product_id=? AND action='purchase_bundle_review' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.result.inbound_id'))=? ORDER BY id DESC LIMIT 1",[scope.id,batch.product_id,String(batch.id)]);
 const saved=row?parse(row.detail_json):null;
 if(saved?.result?.mode!=='whole'||saved.content_revision!==bundleReviewContentRevision(batch,components))throw fail('此批次原先按套装登记，请先核对实际采购内容；只买配件请更正为配件批次，不会按整套确认到货或入库');
}

export function createPurchaseBundleReview({ledger,query=mysqlQuery,transaction=withMysqlTransaction}){
 async function source(id,scope,q=query,lock=false){
  const row=await assertInventoryRecord(scope,'inbound',id,q,{lock});
  const [purchase]=await q(`SELECT id,purchased_at,status FROM purchase_orders po WHERE id=? AND ${inventoryTenantSql(scope,'po')}${lock?' FOR UPDATE':''}`,[row.purchase_order_id||0]);
  const [legacy]=purchase?[]:await q(`SELECT id,created_at AS purchased_at,status FROM procurement_requests pr WHERE id=? AND ${inventoryTenantSql(scope,'pr')}${lock?' FOR UPDATE':''}`,[row.procurement_request_id||0]);
  if((!purchase||!purchase.purchased_at||['cancelled','pending_purchase'].includes(purchase.status))&&legacy?.status!=='purchased')throw fail('此批次尚未完成真实采购，请先核对采购来源');
  return{...row,purchased_at:purchase?.purchased_at||legacy?.purchased_at||row.created_at};
 }
 function contextFor(batch,components,product){
  return{batch,product,components:components.map(p=>({...p,quantity:Number(batch.quantity)*p.per_set_quantity})),revision:bundleReviewRevision(batch,components),content_revision:bundleReviewContentRevision(batch,components)};
 }
 async function context(params,session){
  const current=await authorizeBusinessTaskSession(session);
  if(!hasPermission(current,'procurement'))throw fail('请由本企业采购人员查看并核对采购内容',403);
  const scope=await resolveInventoryTenantScope(current.tenant.id,query),id=Number(params.id);
  if(!Number.isSafeInteger(id)||id<=0)throw fail('请选择需要核对的采购批次',400);
  const batch=await source(id,scope),graph=await loadInventoryComposition(query,scope);
  if(!graph.isBundle(batch.product_id))throw fail('此记录已经是最小实物库存，无需核对套装组成');
  const result=contextFor(batch,graph.components(batch.product_id),graph.products.get(Number(batch.product_id)));
  const costs=await query(`SELECT p.id,p.purchase_cost FROM products p WHERE p.id IN (${result.components.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'p')}`,result.components.map(c=>c.product_id));
  result.components=suggestBundleCostAllocation(batch,result.components,costs);return result;
 }
 async function review(body,session){
  const current=await authorizeBusinessTaskSession(session);
  if(!hasPermission(current,'procurement'))throw fail('请由本企业采购人员核对真实采购内容',403);
  const scope=await resolveInventoryTenantScope(current.tenant.id,query),id=Number(body.id),key=String(body.request_key||'');
  if(!Number.isSafeInteger(id)||id<=0||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))throw fail('采购核对标识无效，请重新打开批次');
  if(body.items!=null&&!Array.isArray(body.items))throw fail('采购配件明细格式错误',400);
  await ledger.prepare();
  // Ownership must still be checked on retries, but the original purchase may
  // already be cancelled by the successful atomic correction.
  const original=await assertInventoryRecord(scope,'inbound',id,query),graph=await loadInventoryComposition(query,scope);
  const reachable=new Set([Number(original.product_id)]);
  for(let depth=0;depth<12;depth++){let changed=false;for(const e of graph.edges)if(reachable.has(Number(e.product_id))&&!reachable.has(Number(e.component_product_id))){reachable.add(Number(e.component_product_id));changed=true;}if(!changed)break;}
  const payload={id,revision:body.revision,mode:body.mode,note:String(body.note||'').trim(),arrived:body.arrived===true,allocation_confirmed:body.allocation_confirmed===true,confirm_amount_change:body.confirm_amount_change===true,items:(body.items||[]).map(i=>({product_id:Number(i.product_id),quantity:Number(i.quantity),amount:Number(i.amount),shipping_amount:Number(i.shipping_amount||0)})).sort((a,b)=>a.product_id-b.product_id)};
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const result=await transaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0];
   const products=[];
   for(const productId of [...reachable].sort((a,b)=>a-b))products.push(await assertInventoryRecord(scope,'product',productId,q,{lock:true}));
   await q('SELECT id FROM people WHERE id=? FOR UPDATE',[current.personId]);
   const fresh=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR SHARE',args));
   if(Number(fresh.tenant.id)!==scope.id||!hasPermission(fresh,'procurement'))throw fail('采购权限已变化，请刷新登录后重试',403);
   const [prior]=await q("SELECT detail_json FROM inventory_flow_events WHERE tenant_id=? AND action='purchase_bundle_review' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? LIMIT 1 FOR UPDATE",[scope.id,key]);
   if(prior){const saved=parse(prior.detail_json);if(saved.hash!==hash)throw fail('此核对已提交，不能用相同标识修改内容');return{...saved.result,duplicate:true};}
   const batch=await source(id,scope,q,true);
   if(Number(batch.product_id)!==Number(original.product_id)||batch.status!=='pending_arrival')throw fail('批次已入库、取消或归属变化，不能修改历史收货；请到采购对账核查');
   const ids=[...reachable],edges=await q(`SELECT c.product_id,c.component_product_id,c.quantity FROM product_components c WHERE c.product_id IN (${ids.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'c')} FOR UPDATE`,ids);
   if(edges.some(e=>!reachable.has(Number(e.component_product_id))))throw fail('套装组成刚刚变化，请重新打开核对');
   const components=physicalInventoryComponents(batch.product_id,products,edges);
   if(components.length===1&&Number(components[0].product_id)===Number(batch.product_id))throw fail('此商品已不是套装，请刷新批次');
   const ctx=contextFor(batch,components,products.find(p=>Number(p.id)===Number(batch.product_id))),plan=planPurchaseBundleReview(ctx,body);
   const created=[];
   if(plan.items.length){
    const before=await ledger.read({product_id:batch.product_id,include_fbp:false},scope.id,c);
    await ledger.apply({action_type:'revise_pending_batch',product_id:Number(batch.product_id),inbound_id:id,quantity:0,amount:0,shipping_amount:0,reason:`${plan.mode==='whole'?'整套采购按实物拆分':'套装误录更正'}：${payload.note}`,revision:before.revision,request_key:key+'-source'},current.personId,c,scope.id,'bundle-review');
    for(let index=0;index<plan.items.length;index++){
     const item=plan.items[index],state=await ledger.read({product_id:item.product_id,include_fbp:false},scope.id,c);
     const saved=await ledger.apply({action_type:'record_purchase',...item,inventory_effect:'in_transit',purchased_at:timestamp(batch.purchased_at),reason:`更正自套装采购批次 #${id}：${payload.note}`,revision:state.revision,request_key:key+'-part-'+index},current.personId,c,scope.id);
     const [child]=await q('SELECT id FROM inbound_records WHERE purchase_order_id=? AND product_id=?',[saved.purchase_order_id,item.product_id]);
     if(!child)throw fail('配件采购未完整保存，本次更正已回滚');
     await c.execute(`UPDATE inbound_records SET courier_company=?,tracking_number=?,received_at=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND ${inventoryTenantSql(scope)}`,[batch.courier_company||null,batch.tracking_number||null,body.arrived===true?batch.received_at||new Date():null,child.id]);
     const [buyer]=await q('SELECT person_id FROM tenant_members WHERE tenant_id=? AND person_id=? LIMIT 1',[scope.id,batch.person_id||0]);
     if(buyer){await c.execute('UPDATE inbound_records SET person_id=? WHERE id=?',[buyer.person_id,child.id]);await c.execute('UPDATE purchase_orders SET created_by_person_id=? WHERE id=?',[buyer.person_id,saved.purchase_order_id]);}
     created.push({product_id:item.product_id,inbound_id:Number(child.id),purchase_order_id:saved.purchase_order_id,quantity:item.quantity});
    }
   }
   const saved={ok:true,mode:plan.mode,inbound_id:id,created,physical_changed:false};
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,batch.product_id,current.personId,'purchase_bundle_review',JSON.stringify({request_key:key,hash,source:ctx.batch,content_revision:ctx.content_revision,note:payload.note,result:saved})]);
   return saved;
  });
  invalidateOrderProcurementCoverage();return result;
 }
 return{context,review};
}

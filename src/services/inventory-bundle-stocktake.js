import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';
import {physicalInventoryComponents} from '../shared/inventory-composition.js';
import {hasPermission} from '../shared/permissions.js';
import {ledgerRevision} from './procurement-ledger.js';
import {inventoryStocktakeResultView} from './inventory-ledger-view.js';
import {invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';

const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const identity=p=>({id:Number(p.id),name:p.name,inventory_number:p.inventory_number||'',stock_unit:p.stock_unit||'件',active:Number(p.active)!==0,image_url:`/api/products/${p.id}/image?thumb=1`});
const positive=value=>{const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)throw fail('请选择有效的套装库存',400);return id;};

export function createInventoryBundleStocktake({ledger,query=mysqlQuery,transaction=withMysqlTransaction,authorize=authorizeBusinessTaskSession,resolveScope=resolveInventoryTenantScope,assertProduct=assertInventoryRecord,invalidate=invalidateOrderProcurementCoverage}){
 async function access(session,q,permission,lock=false){
  const current=await authorize(session,lock?(sql,args)=>q(`${sql} FOR SHARE`,args):q);
  if(!hasPermission(current,permission))throw fail('查看套装需要库存查看权限，更新子库存需要库存管理权限，请联系企业管理员授权',403);
  return{current,scope:await resolveScope(current.tenant.id,q)};
 }
 async function graph(id,scope,q,lock=false){
  const products=new Map(),edges=[];let frontier=[id];
  for(let depth=0;frontier.length&&depth<12;depth++){
   for(const productId of frontier)products.set(productId,await assertProduct(scope,'product',productId,q,{lock}));
   const rows=await q(`SELECT c.product_id,c.component_product_id,c.quantity FROM product_components c WHERE c.product_id IN (${frontier.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'c')}${lock?' FOR SHARE':''}`,frontier);
   edges.push(...rows);frontier=[...new Set(rows.map(row=>Number(row.component_product_id)).filter(productId=>!products.has(productId)))];
   if(products.size+frontier.length>100)throw fail('套装展开超过 100 项库存，请先核对套装组成');
  }
  if(frontier.length)throw fail('套装层级过深，请先修复组成');
  if(!edges.some(edge=>Number(edge.product_id)===id))throw fail('此商品没有子库存，请使用单品更新库存');
  // Keep stopped products visible for review, but never permit writing them.
  const components=physicalInventoryComponents(id,[...products.values()].map(p=>({...p,active:1})),edges);
  const normalized=edges.map(e=>[Number(e.product_id),Number(e.component_product_id),Number(e.quantity)]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  return{products,edges,components,revision:ledgerRevision({edges:normalized,products:[...products.values()].map(p=>[Number(p.id),Number(p.active)]).sort((a,b)=>a[0]-b[0])})};
 }
 async function context(params,session){
  const {scope}=await access(session,query,'inventory.read'),id=positive(params.product_id),g=await graph(id,scope,query);
  const components=[];let incomplete=[...g.products.values()].some(p=>Number(p.active)===0);
  for(const part of g.components){
   const item={...identity(part),product_id:Number(part.id),per_set_quantity:part.per_set_quantity};
   if(item.active){const snapshot=await ledger.read({product_id:part.id,include_fbp:false},scope.id);Object.assign(item,{physical_stock:snapshot.physical_estimate,open_order_demand:snapshot.open_order_demand,fbp_reserved:snapshot.fbp_reserved,revision:snapshot.revision});}
   components.push(item);
  }
  return{product:identity(g.products.get(id)),revision:g.revision,incomplete,
   structure:g.edges.map(edge=>({parent_product_id:Number(edge.product_id),...identity(g.products.get(Number(edge.component_product_id))),quantity:Number(edge.quantity),is_bundle:g.edges.some(e=>Number(e.product_id)===Number(edge.component_product_id))})),components};
 }
 async function apply(body,session){
  const {scope,current}=await access(session,query,'inventory.write'),id=positive(body.product_id),key=String(body.request_key||'');
  if(!/^[a-zA-Z0-9-]{16,50}$/.test(key)||!Array.isArray(body.items)||!body.items.length||body.items.length>100)throw fail('套装更新标识或子库存明细无效，请重新打开后填写',400);
  const items=body.items.map(item=>{
   const product_id=positive(item.product_id),counted_quantity=item.counted_quantity;
   if(!Number.isSafeInteger(counted_quantity)||counted_quantity<0||!String(item.revision||''))throw fail('请逐项填写子库存的实际总数，无货填 0，并重新读取库存版本',400);
   return{product_id,counted_quantity,revision:String(item.revision)};
  }).sort((a,b)=>a.product_id-b.product_id);
  if(new Set(items.map(i=>i.product_id)).size!==items.length)throw fail('同一个子库存只能填写一次',400);
  const payload={product_id:id,revision:String(body.revision||''),reason_code:String(body.reason_code||''),reason_note:String(body.reason_note||'').trim(),items},hash=ledgerRevision(payload);
  await ledger.prepare();let initial,graphError;
  try{initial=await graph(id,scope,query);}catch(e){graphError=e;}
  const result=await transaction(async connection=>{
   const q=async(sql,args=[])=>(await connection.query(sql,args))[0];
   // Sorted product locks match the single-product ledger's ordering. All
   // child ledger writes below share this one transaction.
   for(const productId of (initial?[...initial.products.keys()]:[id]).sort((a,b)=>a-b))await assertProduct(scope,'product',productId,q,{lock:true});
   const fresh=await access(session,q,'inventory.write',true);
   if(fresh.scope.id!==scope.id||fresh.current.personId!==current.personId)throw fail('企业或操作人已变化，请重新登录后核对',403);
   const [prior]=await q("SELECT person_id,detail_json FROM inventory_flow_events WHERE tenant_id=? AND product_id=? AND action='bundle_stocktake' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? ORDER BY id DESC LIMIT 1 FOR UPDATE",[scope.id,id,key]);
   if(prior){const saved=typeof prior.detail_json==='string'?JSON.parse(prior.detail_json):prior.detail_json;if(saved.hash!==hash||Number(prior.person_id)!==Number(current.personId))throw fail('同一更新标识不能提交不同内容，请重新打开核对');return saved.result;}
   if(graphError)throw graphError;
   const g=await graph(id,scope,q,true);
   if(payload.revision!==g.revision)throw fail('套装组成已经变化，请重新打开核对全部子库存');
   if([...g.products.values()].some(p=>Number(p.active)===0))throw fail('套装含已停用子库存，请先修复组成后再更新');
   const ids=g.components.map(p=>Number(p.id)).sort((a,b)=>a-b);
   if(JSON.stringify(ids)!==JSON.stringify(items.map(i=>i.product_id)))throw fail('必须完整填写当前套装的所有实际子库存，不可遗漏、添加或提交父套装');
   const results=[];
   for(const item of items)results.push({product_id:item.product_id,...inventoryStocktakeResultView(await ledger.apply({...item,action_type:'stocktake',stocktake_type:'physical',reason_code:payload.reason_code,reason_note:payload.reason_note,request_key:ledgerRevision({key,root:id,child:item.product_id})},current.personId,connection,scope.id,'inventory'))});
   const result={ok:true,product_id:id,results};
   await q("INSERT INTO inventory_flow_events (tenant_id,product_id,person_id,action,detail_json) VALUES (?,?,?,'bundle_stocktake',?)",[scope.id,id,current.personId,JSON.stringify({request_key:key,hash,result})]);
   return result;
  });
  invalidate({tenantId:scope.id,productIds:[id,...items.map(i=>i.product_id)]});return result;
 }
 return{context,apply};
}

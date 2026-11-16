import {createHash} from 'node:crypto';
import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,inventoryTenantSql} from './inventory-tenant-scope.js';
import {hasPermission} from '../shared/permissions.js';
import {loadOrderProcurementCoverage,invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
import {ledgerRevision,planLedgerAction} from './procurement-ledger.js';
const fail=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode,status:statusCode});
function productIds(value){
 const ids=(Array.isArray(value)?value:String(value||'').split(',')).map(Number);
 if(!ids.length||ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(ids).size!==ids.length)throw fail('请勾选1～100个不同的库存商品',400);
 return ids.sort((a,b)=>a-b);
}
export function createInventoryBatchStocktake({prepare=async()=>{},query=mysqlQuery,transaction=withMysqlTransaction,authorize=authorizeBusinessTaskSession,coverage=loadOrderProcurementCoverage,invalidate=invalidateOrderProcurementCoverage}={}){
 async function access(session,q,permission,lock=false){
  const current=await authorize(session,lock?(sql,args)=>q(`${sql} FOR SHARE`,args):q);
  if(!hasPermission(current,permission))throw fail('批量库存操作需要本企业库存管理权限，请联系管理员授权',403);
  return {current,scope:await resolveInventoryTenantScope(current.tenant.id,q)};
 }
 async function snapshots(ids,scope,q){
  const marks=ids.map(()=>'?').join(',');
  const products=await q(`SELECT id,name,DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f') AS updated_at FROM products p WHERE p.id IN (${marks}) AND ${inventoryTenantSql(scope,'p')} AND p.active=1 ORDER BY p.id`,ids);
  if(products.length!==ids.length)throw fail('所选库存有已删除、停用或不属于当前企业的商品，请刷新列表',404);
  const components=await q(`SELECT product_id FROM product_components c WHERE c.product_id IN (${marks}) AND ${inventoryTenantSql(scope,'c')} LIMIT 1`,ids);
  if(components.length)throw fail(`库存 #${components[0].product_id} 是虚拟套装，请展开实际子库存后更新`,400);
  const projection=await coverage(q,'',{productIds:ids,tenantId:scope.id,localStateOnly:true,fresh:true});
  const tasks=await q(`SELECT t.id,t.product_id,t.quantity,t.resolved_quantity FROM procurement_stock_cost_tasks t JOIN products p ON p.id=t.product_id WHERE t.product_id IN (${marks}) AND ${inventoryTenantSql(scope,'p')} ORDER BY t.id`,ids);
  const evidence=await q(`SELECT product_id,MAX(id) last_id,COUNT(*) row_count,SUM(quantity_delta) quantity_sum,SUM(CASE WHEN UPPER(COALESCE(stock_location,'')) NOT IN ('FBP','FBO','OGR') AND (source_type IS NULL OR source_type NOT IN ('fbp_replenishment_reserve','fbp_replenishment_reserve_release')) THEN quantity_delta ELSE 0 END) ledger FROM inventory_movements m WHERE m.product_id IN (${marks}) AND m.status='posted' AND ${inventoryTenantSql(scope,'m')} GROUP BY product_id`,ids);
  const stocks=new Map((projection.inventory_stocks||[]).map(r=>[Number(r.product_id),r]));
  const demand=new Map();for(const order of projection.values())if(order.stock_location!=='FBP'&&order.needs_fulfillment)for(const item of order.items||[]){const id=Number(item.product_id),n=demand.get(id)||{quantity:0,stock:0};n.quantity+=Number(item.quantity||0);n.stock+=Number(item.stock_quantity||0);demand.set(id,n);}
  return products.map(product=>{
   const id=Number(product.id),stock=stocks.get(id)||{},open=demand.get(id)||{},local=Number(evidence.find(e=>Number(e.product_id)===id)?.ledger||0),physical=local+Number(stock.open_deducted||0),reserved=Number(stock.fbp_reserved||0),orders=Number(open.quantity||0);
   const row={product,local_stock:local,physical_estimate:physical,open_order_deducted:Number(stock.open_deducted||0),open_order_demand:orders,current_stock_reserved:Number(open.stock||0),fbp_reserved:reserved,available_estimate:Math.max(0,physical-orders-reserved),stocktake_id:Number(stock.stocktake_id||0),cost_tasks:tasks.filter(t=>Number(t.product_id)===id),movement_evidence:evidence.find(e=>Number(e.product_id)===id)||null};
   row.revision=ledgerRevision(row);return row;
  });
 }
 async function context(params,session){
  await prepare();const {scope}=await access(session,query,'inventory.read'),ids=productIds(params.product_ids);
  const rows=await snapshots(ids,scope,query);
  return {rows:rows.map(r=>({product_id:Number(r.product.id),revision:r.revision,physical_estimate:r.physical_estimate,open_order_demand:r.open_order_demand,fbp_reserved:r.fbp_reserved}))};
 }
 async function apply(body,session){
  await prepare();const {scope,current}=await access(session,query,'inventory.write');
  if(!body||!Array.isArray(body.items)||body.items.some(r=>!r||typeof r!=='object'))throw fail('请填写批量库存明细（items）',400);
  const ids=productIds(body.items.map(r=>r.product_id)),key=String(body.request_key||'');
  if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw fail('批量操作标识无效，请重新打开窗口',400);
  const items=body.items.map(r=>({product_id:Number(r.product_id),counted_quantity:r.counted_quantity,revision:String(r.revision||''),reason_code:String(r.reason_code||''),reason_note:String(r.reason_note||'').trim()})).sort((a,b)=>a.product_id-b.product_id);
  if(items.some(r=>!Number.isSafeInteger(r.counted_quantity)||r.counted_quantity<0||!r.revision||r.reason_note.length>500))throw fail('请逐项填写非负整数实际数量、调整原因，并重新读取库存版本',400);
  const hash=ledgerRevision(items),keys=items.map((r,i)=>createHash('sha256').update(`stocktake-batch:${scope.id}:${key}${i?':'+r.product_id:''}`).digest('hex'));
  const result=await transaction(async connection=>{
   const q=async(sql,args=[])=>(await connection.query(sql,args))[0],marks=ids.map(()=>'?').join(',');
   // First database read locks products in a stable order, before opening the
   // repeatable-read snapshot. This serializes single and batch stock writers.
   const owned=await q(`SELECT id FROM products p WHERE p.id IN (${marks}) AND ${inventoryTenantSql(scope,'p')} ORDER BY id FOR UPDATE`,ids);
   if(owned.length!==ids.length)throw fail('库存不属于当前企业或已不存在，请重新选择',404);
   const fresh=await access(session,q,'inventory.write',true);
   if(fresh.scope.id!==scope.id||fresh.current.personId!==current.personId)throw fail('企业或操作人已变化，请重新登录',403);
   const [prior]=await q('SELECT person_id,before_json,result_json FROM procurement_ledger_actions WHERE request_key=? FOR UPDATE',[keys[0]]);
   if(prior){const before=typeof prior.before_json==='string'?JSON.parse(prior.before_json):prior.before_json,result=typeof prior.result_json==='string'?JSON.parse(prior.result_json):prior.result_json;if(before.batch_hash!==hash||Number(prior.person_id)!==Number(current.personId))throw fail('同一批量操作标识不能提交不同内容，请重新核对');return {ok:true,results:result.batch_results};}
   await q(`SELECT id FROM inventory_movements m WHERE m.product_id IN (${marks}) AND ${inventoryTenantSql(scope,'m')} ORDER BY product_id,id FOR UPDATE`,ids);
   const rows=await snapshots(ids,scope,q);
   const plans=rows.map((r,i)=>{if(r.revision!==items[i].revision)throw fail(`库存「${r.product.name}」已变化，本批未保存，请重新读取后确认`);try{return planLedgerAction(r,{...items[i],action_type:'stocktake',stocktake_type:'physical'});}catch(e){throw fail(`库存「${r.product.name}」：${e.message}`,400);}});
   const placeholders=items.map(()=>'(?,?,?,?,?,?)').join(',');
   await q(`INSERT INTO procurement_ledger_actions (request_key,product_id,action_type,person_id,reason,before_json) VALUES ${placeholders}`,items.flatMap((r,i)=>[keys[i],r.product_id,'stocktake',current.personId,plans[i].reason,JSON.stringify({...rows[i],batch_hash:hash,submitted:r})]));
   const actions=await q(`SELECT id,request_key FROM procurement_ledger_actions WHERE request_key IN (${keys.map(()=>'?').join(',')})`,keys),actionIds=new Map(actions.map(a=>[a.request_key,Number(a.id)]));
   const results=items.map((r,i)=>{const p=plans[i];return {product_id:r.product_id,ok:true,action_id:actionIds.get(keys[i]),action_type:'stocktake',physical_before:p.physical_before,physical_after:p.counted_quantity,stocktake_delta:p.stocktake_delta,available_before:p.available_before,available_after:p.available_after,cost_task_quantity:p.cost_task_quantity||0};});
   await q(`INSERT INTO inventory_movements (tenant_id,product_id,owner_person_id,source_type,source_ref,quantity_delta,stock_location,stock_location_source,unit_cost,amount,status,note,movement_type,related_posting_number,operator) VALUES ${items.map(()=>"(?,?,?,'reconciliation_stocktake',?,?,'LOCAL','explicit',0,0,'posted',?,?,?,?)").join(',')}`,items.flatMap((r,i)=>{const action=results[i].action_id,ref=`reconciliation_${action}`;return[scope.id,r.product_id,current.personId,ref,plans[i].local_delta,`对账 #${action}：${plans[i].reason}`,plans[i].local_delta>=0?'MANUAL_ADJUST':'ORDER_SHIPPED',ref,String(current.personId)];}));
   // Match the existing ledger's incremental inventory_current semantics; do not
   // rewrite other warehouses, reservations, damage or in-transit quantities.
   await q(`INSERT INTO inventory_current (real_product_id,available_stock,reserved_stock,damaged_stock,in_transit_stock) VALUES ${items.map(()=>'(?,?,0,0,0)').join(',')} ON DUPLICATE KEY UPDATE available_stock=available_stock+VALUES(available_stock),last_updated_at=CURRENT_TIMESTAMP`,items.flatMap((r,i)=>[r.product_id,plans[i].local_delta]));
   const pending=items.flatMap((r,i)=>plans[i].cost_task_quantity>0?[[r.product_id,results[i].action_id,plans[i].cost_task_quantity,current.personId,plans[i].reason]]:[]);
   if(pending.length)await q(`INSERT INTO procurement_stock_cost_tasks (product_id,stocktake_action_id,quantity,person_id,reason) VALUES ${pending.map(()=>'(?,?,?,?,?)').join(',')}`,pending.flat());
   await q(`UPDATE procurement_ledger_actions SET result_json=CASE id ${results.map(()=> 'WHEN ? THEN CAST(? AS JSON)').join(' ')} END WHERE id IN (${results.map(()=>'?').join(',')})`,[...results.flatMap((r,i)=>[r.action_id,JSON.stringify(i===0?{...r,batch_results:results}:r)]),...results.map(r=>r.action_id)]);
   return {ok:true,results};
  });
  invalidate({tenantId:scope.id,productIds:ids});return result;
 }
 return {context,apply};
}

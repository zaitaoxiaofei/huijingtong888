import {mapBundleReads} from './bundle-read-map.js';
import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession,assertBusinessTaskPermission} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';
import {loadInventoryComposition} from './inventory-composition.js';
import {ledgerRevision} from './procurement-ledger.js';
import {invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';

const fail=message=>Object.assign(new Error(message),{statusCode:409});
const integer=(value,label)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0||n>1000000)throw fail(`请填写有效的${label}（1 至 1000000 的整数）`);return n;};
const parse=value=>typeof value==='string'?JSON.parse(value):value;

import {remainingAssemblyBatches} from '../shared/bundle-finished-stock.js';

export function createInventoryBundleConversion({ledger,postMovement,reconcile,query=mysqlQuery,transaction=withMysqlTransaction}){
 async function access(session,q,write=false,lock=false){
  const current=await authorizeBusinessTaskSession(session,lock?(sql,args)=>q(`${sql} FOR SHARE`,args):q);
  assertBusinessTaskPermission(current,write?'inventory.write':'inventory.read');
  return{current,scope:await resolveInventoryTenantScope(current.tenant.id,q)};
 }
 async function read(id,scope,q,connection){
  await assertInventoryRecord(scope,'product',id,q);
  const graph=await loadInventoryComposition(q,scope);
  if(!graph.isBundle(id))throw fail('此商品没有套装组成，请先在商品资料中设置配件和每套数量');
  const parts=graph.components(id);
  const snapshots=await mapBundleReads([id,...parts.map(p=>p.id)],product_id=>ledger.read({product_id,include_fbp:false},scope.id,connection),connection?1:2);
  const root=snapshots[0];
  const components=[];
  for(const [index,part] of parts.entries()){
   const stock=snapshots[index+1];
   components.push({product_id:Number(part.id),name:part.name,inventory_number:part.inventory_number,stock_unit:part.stock_unit,per_set_quantity:part.per_set_quantity,physical_stock:stock.physical_estimate,available_stock:stock.available_estimate,reserved_for_bundle:stock.orders.filter(o=>o.needs_fulfillment&&o.assembly_required&&Number(o.root_product_id)===id&&o.stock_location!=='FBP').reduce((n,o)=>n+Number(o.stock_quantity||0),0),revision:stock.revision,unit_cost:Number(stock.product.purchase_cost)||0});
  }
  const events=await q("SELECT id,action,detail_json,created_at FROM inventory_flow_events WHERE tenant_id=? AND product_id=? AND action IN ('bundle_assembly','bundle_disassembly') ORDER BY id",[scope.id,id]);
  const batches=remainingAssemblyBatches(events,root.physical_estimate);
  const assemblable=Math.max(0,Math.min(...components.map(c=>Math.floor(c.available_stock/c.per_set_quantity))));
  const assemblyCapacity=Math.max(0,Math.min(...components.map(c=>Math.floor((c.available_stock+c.reserved_for_bundle)/c.per_set_quantity))));
  const revision=ledgerRevision({root:root.revision,components,edges:graph.edges.filter(e=>Number(e.product_id)===id),events});
  return{product:root.product,revision,finished_physical:root.physical_estimate,finished_available:root.available_estimate,finished_reserved:root.open_order_demand+root.fbp_reserved,assemblable,assembly_capacity:assemblyCapacity,maximum_available:root.available_estimate+assemblable,components,batches,history:events.slice(-30).reverse().map(e=>{const d=parse(e.detail_json);return{id:Number(e.id),action:e.action,quantity:d.quantity,batch_id:d.batch_id||null,note:d.note||'',created_at:e.created_at};})};
 }
 function publicView(value){return{...value,product:{id:value.product.id,name:value.product.name,inventory_number:value.product.inventory_number,stock_unit:value.product.stock_unit},components:value.components.map(({unit_cost,...c})=>c),batches:value.batches.map(b=>({id:b.id,created_at:b.created_at,remaining:b.remaining,components:b.components.map(({unit_cost,...c})=>c)}))};}
 async function context(params,session){await ledger.prepare();const {scope}=await access(session,query);return publicView(await read(integer(params.product_id,'套装库存 ID'),scope,query));}
 async function apply(body,session){
  await ledger.prepare();
  const id=integer(body.product_id,'套装库存 ID'),quantity=integer(body.quantity,'转换数量'),action=body.action;
  if(!['assemble','disassemble'].includes(action))throw fail('请选择组装入库或拆包返还');
  if(body.stock_location&&body.stock_location!=='LOCAL')throw fail('本次转换只支持本地仓，不能转换 FBP 平台库存');
  const key=String(body.request_key||'');if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw fail('操作标识无效，请重新打开转换窗口');
  const payload={product_id:id,quantity,action,revision:String(body.revision||''),batch_id:action==='disassemble'?integer(body.batch_id,'原组装批次'):null,note:String(body.note||'').trim().slice(0,500)};
  const hash=ledgerRevision(payload),{scope,current}=await access(session,query,true);
  const result=await transaction(async connection=>{
   const q=async(sql,args=[])=>(await connection.query(sql,args))[0];
   // Same ascending product locks as inventory writes; cover shared and nested
   // parts and open-order reallocations in this one atomic conversion.
   await q(`SELECT p.id FROM products p WHERE ${inventoryTenantSql(scope,'p')} ORDER BY p.id FOR UPDATE`);
   const fresh=await access(session,q,true,true);
   if(fresh.scope.id!==scope.id||fresh.current.personId!==current.personId)throw fail('企业或操作人已变化，请重新登录');
   const prior=await q("SELECT detail_json FROM inventory_flow_events WHERE tenant_id=? AND product_id=? AND action IN ('bundle_assembly','bundle_disassembly') AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? FOR UPDATE",[scope.id,id,key]);
   if(prior[0]){const saved=parse(prior[0].detail_json);if(saved.hash!==hash||saved.person_id!==current.personId)throw fail('同一操作标识不能提交不同内容');return saved.result;}
   const before=await read(id,scope,q,connection);
   if(payload.revision!==before.revision)throw fail('库存、订单占用或套装组成已变化，请刷新并重新核对；本次未记账');
   let components=before.components;
   if(action==='assemble'&&quantity>before.assembly_capacity)throw fail(`散件未占用库存不足，当前最多可组装 ${before.assembly_capacity} 套；请核对订单及 FBP 占用`);
   if(action==='disassemble'){
    if(quantity>before.finished_available)throw fail(`成品未占用库存不足，当前可拆 ${before.finished_available} 套；请先解除订单或 FBP 占用`);
    const batch=before.batches.find(b=>b.id===payload.batch_id);if(!batch||quantity>batch.remaining)throw fail('所选组装批次剩余数量不足，请刷新后核对');
    components=batch.components;
    for(const part of components){const product=await assertInventoryRecord(scope,'product',part.product_id,q,{lock:true});if(Number(product.active)===0)throw fail('原批次配件已停用，请先恢复配件资料后拆包');}
   }
   const direction=action==='assemble'?1:-1,source_type=direction>0?'bundle_assembly':'bundle_disassembly';
   const unitCost=components.reduce((sum,c)=>sum+c.per_set_quantity*c.unit_cost,0);
   const detail={...payload,quantity,request_key:key,hash,person_id:current.personId,components,unit_cost:unitCost,cost_known:components.every(c=>Number(c.unit_cost)>0)};
   const [event]=await connection.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,id,current.personId,source_type,JSON.stringify(detail)]);
   const source_ref=`bundle_conversion_${event.insertId}`;
   const movement=async(product_id,delta,cost)=>postMovement(connection,{product_id,quantity_delta:delta,source_type,source_ref,stock_location:'LOCAL',movement_type:'MANUAL_ADJUST',unit_cost:cost,amount:Math.abs(delta)*cost,operator:String(current.personId),note:payload.note||`${direction>0?'组装':'拆包'}套装 ${id}，${quantity} 套`});
   for(const c of components)await movement(c.product_id,-direction*quantity*c.per_set_quantity,c.unit_cost);
   await movement(id,direction*quantity,unitCost);
   // Existing open-order deductions must move from parts to finished units in
   // this transaction, so conversion never deducts the same parts twice.
   await reconcile(connection,scope);
   const result={ok:true,event_id:Number(event.insertId),product_id:id,action,quantity};
   await q('UPDATE inventory_flow_events SET detail_json=? WHERE id=? AND tenant_id=?',[JSON.stringify({...detail,result}),event.insertId,scope.id]);
   return result;
  });
  invalidateOrderProcurementCoverage({tenantId:scope.id});return result;
 }
 return{context,apply};
}

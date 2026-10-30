import {stockTopupRecipients} from './warehouse-stock-topup.js';
import {procurementDemandType,INVENTORY_DEMAND_TYPES} from '../shared/inventory-workflow.js';
import {createHash} from 'node:crypto';
import {withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord} from './inventory-tenant-scope.js';
import {hasPermission} from '../shared/permissions.js';
import {createInventoryWorkflowService} from './inventory-workflow.js';
import {invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
import {broadcastGlobalEvent} from '../server/notifications.js';
import {PROCUREMENT_GAP_CAUSES as DEMAND_CAUSES,PROCUREMENT_GAP_FIELDS as fields} from '../shared/procurement-demand-types.js';
export {DEMAND_CAUSES};
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const subKey=(key,type)=>{const h=createHash('sha256').update(key+':'+type).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
export function createProcurementDemandRequest({transaction=withMysqlTransaction,broadcast=broadcastGlobalEvent}={}){
 return async(body,session)=>{
  const id=Number(body.product_id),types=[...new Set(Array.isArray(body.demand_types)?body.demand_types:[])].sort(),cause=String(body.cause||''),note=String(body.note||'').trim(),key=String(body.request_key||'');
  if(!Number.isSafeInteger(id)||id<=0||!types.length||types.some(t=>!fields[t])||!DEMAND_CAUSES[cause]||!note||note.length>300||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(key))throw fail('请选择FBS订单、本地保障或FBP备货申请需求，选择缺口成因并填写1至300字说明');
  const result=await transaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0],current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
   if(!hasPermission(current,'packing')&&!hasPermission(current,'inventory.write')&&!hasPermission(current,'procurement'))throw fail('请由本企业仓库、库存管理或采购人员创建需求',403);
   const scope=await resolveInventoryTenantScope(current.tenant.id,q);await assertInventoryRecord(scope,'product',id,q,{lock:true});
   const [previous]=await q("SELECT detail_json FROM inventory_flow_events WHERE tenant_id=? AND person_id=? AND action='procurement_demand_request' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? LIMIT 1 FOR UPDATE",[scope.id,current.personId,key]);
   if(previous){const old=typeof previous.detail_json==='string'?JSON.parse(previous.detail_json):previous.detail_json;if(old.product_id!==id||old.note!==note||old.cause!==cause||JSON.stringify(old.types)!==JSON.stringify(types))throw fail('此需求已经创建，请勿用原标识修改商品、类型或说明',409);return{ok:true,duplicate:true,requests:old.requests,tenantId:scope.id};}
   const workflow=createInventoryWorkflowService({query:q,transaction:work=>work(c),broadcast:()=>{}}),[state]=await workflow.batch([id],scope.id,{fresh:true,cache:false});
   if(!state.supply_plan?.known)throw fail('库存数量尚未核实，请先核对本地实物，再创建采购需求',409);
   const requests=[],sources=(await workflow.workspaceSources([id],scope.id)).requests;
   const members=await q('SELECT p.id,p.role,p.roles_json,tm.role AS tenant_role,tm.business_roles_json,t.slug AS tenant_slug FROM tenant_members tm JOIN people p ON p.id=tm.person_id AND p.active=1 JOIN tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=? AND tm.active=1',[scope.id]);
   const buyers=stockTopupRecipients(members);if(!buyers.length)throw fail('本企业暂无有效采购接收人，请先配置采购岗位',409);
   for(const type of types){const quantity=Number(state.supply_plan[fields[type]]);if(!(quantity>0))throw fail('所选需求已被现货或采购在途覆盖，请重新核对，避免重复采购',409);
    const existing=sources.filter(r=>procurementDemandType(r)===type&&['submitted','pending'].includes(r.status)&&r.request_reason_code===`flow_${type}`);
    const linked=existing.reduce((sum,r)=>sum+Math.max(0,Number(r.quantity)||0),0),createdQuantity=Math.max(0,quantity-linked);
    const request=createdQuantity?await workflow.submit({product_id:id,quantity:createdQuantity,demand_type:type,request_key:subKey(key,type),note:`缺口成因：${DEMAND_CAUSES[cause]}；${note}`},current):{id:Number(existing[0].id)};
    if(!createdQuantity)for(const personId of buyers)await c.execute(`INSERT INTO system_notifications(tenant_id,recipient_person_id,notification_type,title,content,severity,route,entity_type,entity_id,dedupe_key,status) VALUES(?,?,'stock_topup',?,?,?,?,'procurement',?,?,'unread')`,[scope.id,personId,'已有采购需求 · 补充缺口说明',`当前库存缺口${quantity}件，沿用已有${INVENTORY_DEMAND_TYPES.find(t=>t.key===type)?.label||'采购'}需求，不重复增加数量。成因：${DEMAND_CAUSES[cause]}；${note}`,type==='local_safety'?'warning':'danger',`/procurement/workspace?mode=inventory&product_id=${id}`,String(request.id),`${scope.id}:demand-note:${current.personId}:${key}:${type}:${personId}`]);
    requests.push({id:request.id,type,quantity,created_quantity:createdQuantity,linked_quantity:Math.min(quantity,linked)});}
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,id,current.personId,'procurement_demand_request',JSON.stringify({request_key:key,product_id:id,types,cause,note,requests})]);
   return{ok:true,duplicate:false,requests,tenantId:scope.id};
  });
  invalidateOrderProcurementCoverage();if(!result.duplicate)try{broadcast('system-notification',{refresh:true},{tenantId:result.tenantId});}catch{}
  const {tenantId,...publicResult}=result;return publicResult;
 };
}
export const procurementDemandRequest=createProcurementDemandRequest();

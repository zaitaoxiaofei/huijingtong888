import {withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';
import {hasPermission,getRoles} from '../shared/permissions.js';
import {stockTopupRecipients} from './warehouse-stock-topup.js';
import {createInventoryWorkflowService} from './inventory-workflow.js';
import {broadcastGlobalEvent} from '../server/notifications.js';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export function createInventorySupplyFeedback({transaction=withMysqlTransaction,broadcast=broadcastGlobalEvent,readState=async(q,id,tenantId)=>(await createInventoryWorkflowService({query:q}).batch([id],tenantId,{fresh:true,cache:false}))[0]}={}){
 return async function feedback(body,session,{connection=null,automatic=false,stateSnapshot=null}={}){
  const id=Number(body.product_id),note=String(body.note||'').trim(),key=String(body.request_key||'');
  if(!Number.isSafeInteger(id)||id<=0||!note||note.length>500||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(key))throw fail('请选择实际库存商品并填写1至500字反馈说明；本次反馈标识无效时请重新打开');
  const write=async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0];
   const current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
   if(!hasPermission(current,'packing')&&!hasPermission(current,'inventory.write')&&!hasPermission(current,'procurement'))throw fail('反馈库存需要本企业仓库、库存管理或采购岗位',403);
   const scope=await resolveInventoryTenantScope(current.tenant.id,q),product=await assertInventoryRecord(scope,'product',id,q,{lock:true});
   const parts=await q(`SELECT component_product_id FROM product_components c WHERE c.product_id=? AND ${inventoryTenantSql(scope,'c')} LIMIT 1`,[id]);
   if(parts.length)throw fail('此商品是组合库存，请在SKU库存组成中打开实际库存子件后反馈；采购按实物子件汇总，避免重复购买组合父商品',409);
   const prefix=`${scope.id}:supply-feedback:${current.personId}:${key}:`;
   const previous=await q("SELECT entity_id,content FROM system_notifications WHERE tenant_id=? AND dedupe_key LIKE ? LIMIT 1 FOR UPDATE",[scope.id,prefix+'%']);
   if(previous.length){if(Number(previous[0].entity_id)!==id||!previous[0].content.endsWith('反馈说明：'+note))throw fail('此反馈已提交，不能使用原标识修改商品或说明，请刷新查看',409);return{ok:true,duplicate:true,notified:0,recipients:[],tenantId:scope.id};}
   if(stateSnapshot&&Number(stateSnapshot.product_id)!==id)throw fail('库存反馈快照与商品不一致，请刷新核对',409);
   const state=stateSnapshot||await readState(q,id,scope.id),plan=state.supply_plan||{};
   if(automatic&&plan.known&&!(plan.required_purchase>0)&&!(plan.optional_purchase>0))return{ok:true,notified:0,recipients:[],tenantId:scope.id};
   const people=await q(`SELECT p.id,p.name,p.role,p.roles_json,tm.role AS tenant_role,tm.business_roles_json,t.slug AS tenant_slug FROM tenant_members tm JOIN people p ON p.id=tm.person_id AND p.active=1 JOIN tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=? AND tm.active=1 FOR UPDATE`,[scope.id]);
   const buyers=stockTopupRecipients(people);
   const recipients=[...new Set([...buyers,...people.filter(p=>getRoles({roles:p.business_roles_json??p.roles_json??p.role}).includes('operations')).map(p=>Number(p.id))])];
   if(!recipients.length)throw fail('本企业暂无管理员、采购或运营接收人，请先配置有效岗位再反馈',409);
   const sender=people.find(p=>Number(p.id)===current.personId)?.name||'企业成员';
   const quantity=v=>v==null?'待核对':`${v}件`;
   const content=`${sender}反馈：${product.name}。FBS必须采购${quantity(plan.required_fbs)}；正式FBP必须采购${quantity(plan.required_fbp)}；本地保障建议${quantity(plan.optional_local)}；FBP预测建议${quantity(plan.optional_fbp)}。采购在途${quantity(state.incoming)}，已有货源不重复采购。反馈说明：${note}`;
   for(const personId of recipients)await c.execute(`INSERT INTO system_notifications(tenant_id,recipient_person_id,notification_type,title,content,severity,route,entity_type,entity_id,dedupe_key,status) VALUES(?,?,'stock_topup',?,?,?,?,'inventory',?,?,'unread')`,[scope.id,personId,`${sender} · 库存缺口反馈`,content,plan.required_purchase>0?'danger':'warning',`${buyers.includes(personId)?'/procurement/workspace':'/orders'}?mode=inventory&product_id=${id}`,String(id),prefix+personId]);
   return{ok:true,duplicate:false,notified:recipients.length,recipients,tenantId:scope.id,required_purchase:plan.required_purchase??null};
  };
  const result=connection?await write(connection):await transaction(write);
  // An outer FBP transaction broadcasts only after its own commit.
  if(!connection)for(const personId of result.recipients)try{broadcast('system-notification',{refresh:true},{tenantId:result.tenantId,personId});}catch{}
  const {recipients,tenantId,...publicResult}=result;return publicResult;
 };
}
export const inventorySupplyFeedback=createInventorySupplyFeedback();

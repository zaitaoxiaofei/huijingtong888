import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';
import {hasPermission} from '../shared/permissions.js';
import {createInventoryWorkflowService} from './inventory-workflow.js';
import {loadOrderProcurementCoverage,invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
import {calculateLocalInventorySafety} from './inventory-flow-summary-model.js';
import {validateFlowSettings,whole} from './inventory-flow-rules.js';
import {classifyOrderLogistics} from './order-logistics-classification.js';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const parse=v=>typeof v==='string'?JSON.parse(v):v||{};

export function createProcurementDemandDetails({query=mysqlQuery,transaction=withMysqlTransaction}={}){
 const workflow=createInventoryWorkflowService({query});
 async function actor(session,write=false,q=query){
  const current=await authorizeBusinessTaskSession(session,q);
  if(!(write?(hasPermission(current,'inventory.write')||hasPermission(current,'procurement')):hasPermission(current,'inventory.read')))throw fail('请由本企业采购或库存管理人员操作',403);
  return current;
 }
 async function details(productId,session){
  const current=await actor(session),scope=await resolveInventoryTenantScope(current.tenant.id,query),id=Number(productId);
  const product=await assertInventoryRecord(scope,'product',id,query);
  const coverage=await loadOrderProcurementCoverage(query,'',{fresh:true,productId:id,tenantId:scope.id});
  const [state]=await workflow.batch([id],scope.id,{fresh:true,coverage,cache:false});
  const all=[...coverage.values()].flatMap(o=>(o.items||[]).filter(i=>Number(i.product_id)===id).map(i=>({...i,order_id:o.order_id,ordered_at:o.ordered_at,transport_at:o.transport_at,needs_fulfillment:o.needs_fulfillment,entered_transport:o.entered_transport,stock_location:o.stock_location})));
  const open=all.filter(i=>i.needs_fulfillment&&i.stock_location!=='FBP'),itemIds=[...new Set(open.map(i=>Number(i.order_item_id)))];
  const metadata=itemIds.length?await query(`SELECT oi.id AS order_item_id,o.id AS order_id,o.posting_number,o.ordered_at,o.status,s.name AS shop_name,oi.ozon_sku,oi.ozon_name,oi.ozon_image_url,om.note AS manual_note,raw.raw_json
    FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')}
    LEFT JOIN order_marks om ON om.order_id=o.id LEFT JOIN ozon_orders_raw raw ON raw.store_id=o.shop_id AND raw.posting_number=o.posting_number
    WHERE oi.id IN (${itemIds.map(()=>'?').join(',')})`,itemIds):[];
  const orders=open.map(i=>{const row=metadata.find(m=>Number(m.order_item_id)===Number(i.order_item_id));if(!row)return null;const {raw_json,...safe}=row;return{...safe,quantity:i.quantity,stock_quantity:i.stock_quantity,incoming_quantity:i.incoming_quantity,shortage_quantity:i.shortage_quantity,logistics:classifyOrderLogistics({raw_json}).logistics_display_name||'物流渠道待核对'};}).filter(Boolean);
  const records=await query('SELECT product_id,settings_json,revision,updated_by,updated_at FROM inventory_flow_settings WHERE tenant_id=? AND product_id IN(0,?)',[scope.id,id]);
  const defaults=parse(records.find(r=>!Number(r.product_id))?.settings_json),own=records.find(r=>Number(r.product_id)===id);
  const settings=validateFlowSettings({...defaults,...parse(own?.settings_json),holidays:defaults.holidays||[]});
  const safety=calculateLocalInventorySafety({product,orders:all},settings);
  const sources=await workflow.workspaceSources([id],scope.id);
  const reports=await query(`SELECT e.detail_json,e.created_at,p.name AS person_name FROM inventory_flow_events e LEFT JOIN people p ON p.id=e.person_id AND EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.person_id=p.id AND tm.tenant_id=e.tenant_id AND tm.active=1) WHERE e.tenant_id=? AND e.product_id=? AND e.action='procurement_demand_request' ORDER BY e.id DESC LIMIT 20`,[scope.id,id]);
  const people=own?.updated_by?await query('SELECT p.name FROM people p JOIN tenant_members tm ON tm.person_id=p.id AND tm.tenant_id=? AND tm.active=1 WHERE p.id=?',[scope.id,own.updated_by]):[];
  return{product:{id,name:product.name,inventory_number:product.inventory_number},state,orders,
   reports:reports.map(r=>({types:parse(r.detail_json).types,cause:parse(r.detail_json).cause,note:parse(r.detail_json).note,created_at:r.created_at,person_name:r.person_name})),
   safety:{...safety,updated_by_name:people[0]?.name||'',updated_at:own?.updated_at,revision:Number(own?.revision||0),holidays:settings.holidays,override_note:settings.local_safety_override_note},
   applications:sources.applications.filter(a=>a.status!=='draft'),requests:sources.requests,
   batches:await workflow.workspaceBatches([id],scope.id)};
 }
 async function safety(body,session){
  const id=Number(body.product_id),value=body.quantity==null?null:whole(body.quantity,'人工本地保障'),note=String(body.note||'').trim();
  if(!id||id<1||note.length>500||(value!=null&&!note))throw fail('请选择库存，填写人工保障数量及调整原因；恢复系统建议时数量留空');
  const result=await transaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0],current=await actor(session,true,(sql,args)=>q(sql+' FOR UPDATE',args));
   const scope=await resolveInventoryTenantScope(current.tenant.id,q);await assertInventoryRecord(scope,'product',id,q,{lock:true});
   const [old]=await q('SELECT settings_json,revision FROM inventory_flow_settings WHERE tenant_id=? AND product_id=? FOR UPDATE',[scope.id,id]);
   if(Number(old?.revision||0)!==Number(body.revision))throw fail('保障规则已被其他同事修改，请重新打开核对后再保存',409);
   const settings={...parse(old?.settings_json),local_safety_override:value,local_safety_override_note:value==null?'':note};
   await c.execute(`INSERT INTO inventory_flow_settings(tenant_id,product_id,settings_json,updated_by) VALUES(?,?,?,?)
     ON DUPLICATE KEY UPDATE settings_json=VALUES(settings_json),updated_by=VALUES(updated_by),revision=revision+1`,[scope.id,id,JSON.stringify(settings),current.personId]);
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,id,current.personId,'local_safety_override',JSON.stringify({quantity:value,note,previous:parse(old?.settings_json).local_safety_override??null})]);
   return{ok:true,quantity:value};
  });invalidateOrderProcurementCoverage();return result;
 }
 return{details,safety};
}
export const procurementDemandDetails=createProcurementDemandDetails();

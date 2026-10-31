import {mysqlQuery,withMysqlTransaction} from '../mysql-pool.js';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope,assertInventoryRecord,inventoryTenantSql} from './inventory-tenant-scope.js';
import {inventoryProductSearch} from './inventory-product-search.js';
import {inventoryIdentifierSearch,isInventoryIdentifier,inventoryNamePattern} from './inventory-search.js';
import {hasPermission} from '../shared/permissions.js';
import {invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export const procurementArrivalState=r=>r.status==='approved'?'received':r.status==='cancelled'?'cancelled':r.received_at?'arrived':'open';

export function createProcurementArrivals({query=mysqlQuery,transaction=withMysqlTransaction}={}){
 async function list(params,session){
  const current=await authorizeBusinessTaskSession(session);if(!hasPermission(current,'inventory.read'))throw fail('请由本企业库存或采购人员查看到货情况',403);
  const scope=await resolveInventoryTenantScope(current.tenant.id,query),where=[inventoryTenantSql(scope,'ir'),inventoryTenantSql(scope,'p'),"(po.purchased_at IS NOT NULL OR pr.status='purchased')"],args=[];
  const status=params.status||'open';if(status==='open')where.push("ir.status='pending_arrival' AND ir.received_at IS NULL");else if(status==='arrived')where.push("ir.status='pending_arrival' AND ir.received_at IS NOT NULL");else if(status==='received')where.push("ir.status='approved'");else if(status!=='all')throw fail('请选择未到货、已到货待验收、已入库或全部记录');
  if(params.product_id){await assertInventoryRecord(scope,'product',Number(params.product_id),query);where.push('ir.product_id=?');args.push(Number(params.product_id));}
  const search=inventoryProductSearch(params,scope);if(search.sql){where.push(search.sql);args.push(...search.params);}
  const text=String(params.query||'').trim();if(text&&(!params.searchMode||params.searchMode==='auto')){if(isInventoryIdentifier(text)){const id=inventoryIdentifierSearch(text,'inventory_id');where.push(`p.id IN (${id.sql})`);args.push(...id.params);}else{where.push("(p.name LIKE ? ESCAPE '=' OR po.order_no LIKE ? ESCAPE '=')");args.push(inventoryNamePattern(text),inventoryNamePattern(text));}}
  const joins=`FROM inbound_records ir JOIN products p ON p.id=ir.product_id
    LEFT JOIN purchase_orders po ON po.id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
    LEFT JOIN procurement_requests pr ON pr.id=ir.procurement_request_id AND ${inventoryTenantSql(scope,'pr')}
    LEFT JOIN purchase_order_items poi ON poi.id=ir.purchase_order_item_id AND poi.product_id=ir.product_id AND poi.purchase_order_id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'poi')}
    LEFT JOIN people buyer ON buyer.id=ir.person_id AND EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=${scope.id} AND tm.person_id=buyer.id AND tm.active=1)
    WHERE ${where.map(w=>'('+w+')').join(' AND ')}`;
  const page=Math.max(1,Math.min(1000000,Math.trunc(Number(params.page)||1))),pageSize=Math.min(100,Math.max(1,Math.trunc(Number(params.pageSize)||20)));
  const summaryFilter=[...where.filter(w=>!w.startsWith("ir.status=")),"ir.status='pending_arrival'"];
  const summaryJoins=joins.slice(0,joins.indexOf('WHERE '+where.map(w=>'('+w+')').join(' AND ')))+'WHERE '+summaryFilter.map(w=>'('+w+')').join(' AND ');
  const [summaryRow]=await query(`SELECT SUM(ir.status='pending_arrival' AND ir.received_at IS NULL) AS open,SUM(ir.status='pending_arrival' AND ir.received_at IS NOT NULL) AS arrived,
    SUM(CASE WHEN ir.received_at IS NULL THEN ir.quantity ELSE 0 END) AS open_quantity,
    SUM(CASE WHEN ir.received_at IS NOT NULL THEN ir.quantity ELSE 0 END) AS arrived_quantity ${summaryJoins}`,args);
  const summary={open:Number(summaryRow?.open)||0,arrived:Number(summaryRow?.arrived)||0,open_quantity:Number(summaryRow?.open_quantity)||0,arrived_quantity:Number(summaryRow?.arrived_quantity)||0};
  if(params.summary_only==='1')return{rows:[],total:0,page,pageSize,summary};
  const [counts,rows]=await Promise.all([query(`SELECT COUNT(*) AS n ${joins}`,args),query(`SELECT ir.id,ir.product_id,p.name AS product_name,p.inventory_number,ir.quantity,ir.status,ir.received_at,ir.approved_at,ir.updated_at,ir.note,ir.courier_company,ir.tracking_number,po.id AS purchase_order_id,po.order_no,COALESCE(po.purchased_at,ir.created_at) AS purchased_at,poi.actual_quantity AS ordered_quantity,buyer.name AS buyer_name ${joins} ORDER BY COALESCE(po.purchased_at,ir.created_at) DESC,ir.id DESC LIMIT ? OFFSET ?`,[...args,pageSize,(page-1)*pageSize])]);
  return{rows:rows.map(r=>({...r,arrival_state:procurementArrivalState(r)})),total:Number(counts[0]?.n)||0,page,pageSize,summary};
 }
 async function logistics(body,session){
  const id=Number(body.id),courier=String(body.courier_company||'').trim(),tracking=String(body.tracking_number||'').trim();
  if(!Number.isSafeInteger(id)||id<=0||courier.length>128||tracking.length>128||!body.expected_updated_at)throw fail('请选择采购批次并填写不超过128字的快递信息；请先刷新最新记录');
  return transaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0],current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
   if(!hasPermission(current,'procurement'))throw fail('只有本企业采购岗位可以修改采购物流',403);
   const scope=await resolveInventoryTenantScope(current.tenant.id,q),before=await assertInventoryRecord(scope,'inbound',id,q);
   await assertInventoryRecord(scope,'product',Number(before.product_id),q,{lock:true});
   const row=await assertInventoryRecord(scope,'inbound',id,q,{lock:true});
   if(Number(row.product_id)!==Number(before.product_id)||row.status!=='pending_arrival')throw fail('采购批次已经变化或关闭，请刷新后重试',409);
   const [purchased]=await q(`SELECT id FROM purchase_orders po WHERE id=? AND purchased_at IS NOT NULL AND status NOT IN('cancelled','pending_purchase') AND ${inventoryTenantSql(scope,'po')} FOR UPDATE`,[row.purchase_order_id||0]);
   const [legacy]=purchased?[]:await q(`SELECT id FROM procurement_requests pr WHERE id=? AND product_id=? AND status='purchased' AND ${inventoryTenantSql(scope,'pr')} FOR UPDATE`,[row.procurement_request_id||0,row.product_id]);
   if(!purchased&&!legacy)throw fail('此批次尚未登记真实采购，不能修改到货物流',409);
   if(String(row.courier_company||'')===courier&&String(row.tracking_number||'')===tracking)return{ok:true,duplicate:true};
   const stamp=v=>new Date(typeof v==='string'&&!/[TZ]/.test(v)?v.replace(' ','T')+'Z':v).getTime();
   if(stamp(row.updated_at)!==stamp(body.expected_updated_at)||String(row.courier_company||'')!==String(body.expected_courier_company||'')||String(row.tracking_number||'')!==String(body.expected_tracking_number||''))throw fail('采购物流已被修改，请刷新后重新填写',409);
   await c.execute(`UPDATE inbound_records SET courier_company=?,tracking_number=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND ${inventoryTenantSql(scope)}`,[courier||null,tracking||null,id]);
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,row.product_id,current.personId,'purchase_logistics',JSON.stringify({inbound_id:id,courier_company:courier,tracking_number:tracking,before:{courier_company:row.courier_company,tracking_number:row.tracking_number}})]);
   return{ok:true};
  });
 }
 async function confirm(body,session){
  if(body.operation==='logistics')return logistics(body,session);
  const id=Number(body.id),note=String(body.note||'').trim(),key=String(body.request_key||'');
  if(!Number.isSafeInteger(id)||id<=0||!note||note.length>500||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)||!body.expected_updated_at)throw fail('请选择采购批次，填写到货说明，并重新打开最新记录后确认');
  const result=await transaction(async c=>{
   const q=async(sql,args=[])=>(await c.query(sql,args))[0],current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
   if(!hasPermission(current,'procurement'))throw fail('只有本企业采购岗位可以确认采购到货；仓库请使用验货入库',403);
   const scope=await resolveInventoryTenantScope(current.tenant.id,q),before=await assertInventoryRecord(scope,'inbound',id,q);
   await assertInventoryRecord(scope,'product',Number(before.product_id),q,{lock:true});
   const row=await assertInventoryRecord(scope,'inbound',id,q,{lock:true});if(Number(row.product_id)!==Number(before.product_id))throw fail('批次库存归属已变化，请刷新核对',409);
   if(row.received_at||row.status==='approved')return{ok:true,duplicate:true};
   if(row.status!=='pending_arrival')throw fail('此批次已关闭或取消，请刷新到货记录',409);
   const [purchase]=await q(`SELECT po.id FROM purchase_orders po WHERE po.id=? AND po.purchased_at IS NOT NULL AND po.status NOT IN('cancelled','pending_purchase') AND ${inventoryTenantSql(scope,'po')} FOR UPDATE`,[row.purchase_order_id||0]);
   const [legacy]=purchase?[]:await q(`SELECT id FROM procurement_requests pr WHERE pr.id=? AND pr.product_id=? AND pr.status='purchased' AND ${inventoryTenantSql(scope,'pr')} FOR UPDATE`,[row.procurement_request_id||0,row.product_id]);
   if(!purchase&&!legacy)throw fail('此批次尚未登记真实采购，不能确认到货',409);
   const stamp=v=>new Date(typeof v==='string'&&!/[TZ]/.test(v)?v.replace(' ','T')+'Z':v).getTime();
   if(stamp(row.updated_at)!==stamp(body.expected_updated_at))throw fail('采购批次已变化，请刷新后重新确认到货',409);
   await c.execute(`UPDATE inbound_records SET received_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND ${inventoryTenantSql(scope)}`,[id]);
   await c.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',[scope.id,row.product_id,current.personId,'purchase_arrival',JSON.stringify({inbound_id:id,note,request_key:key,quantity:Number(row.quantity)})]);
   return{ok:true,duplicate:false};
  });invalidateOrderProcurementCoverage();return result;
 }
 return{list,confirm};
}
export const procurementArrivals=createProcurementArrivals();

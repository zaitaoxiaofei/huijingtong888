import { mysqlQuery, withMysqlTransaction } from '../mysql-pool.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { resolveInventoryTenantScope, assertInventoryRecord, inventoryTenantSql } from './inventory-tenant-scope.js';
import { hasPermission } from '../shared/permissions.js';
import { procurementArrivalStage,PROCUREMENT_INSPECTION_HOURS } from '../shared/inventory-procurement-stage.js';
import { invalidateOrderProcurementCoverage } from './mysql-order-procurement-coverage.js';

const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const pending=['submitted','pending','suggested'];
export function createInventoryNodeRecords({query=mysqlQuery,transaction=withMysqlTransaction,ledger}={}) {
  async function access(session,q=query,permission='inventory.read') {
    const current=await authorizeBusinessTaskSession(session,q);
    if(!hasPermission(current,permission))throw fail('当前岗位没有操作权限，请联系企业管理员授权',403);
    return {current,scope:await resolveInventoryTenantScope(current.tenant.id,q)};
  }
  async function records(params,session) {
    const {current,scope}=await access(session),id=Number(params.product_id),node=String(params.node),page=Number(params.page||1),offset=(page-1)*50;
    if(!Number.isSafeInteger(page)||page<1||page>1000000)throw fail('页码须为有效正整数，请重新查询');
    await assertInventoryRecord(scope,'product',id,query);
    if(node==='safety') {
      const rows=await query('SELECT product_id,settings_json,revision FROM inventory_flow_settings WHERE tenant_id=? AND product_id IN (0,?)',[scope.id,id]);
      const parse=r=>typeof r?.settings_json==='string'?JSON.parse(r.settings_json):r?.settings_json||{};
      const defaults=parse(rows.find(r=>!Number(r.product_id))),own=rows.find(r=>Number(r.product_id)===id);
      const [product]=await query(`SELECT production_lead_days,warehouse_logistics_days FROM products WHERE id=? AND ${inventoryTenantSql(scope)}`,[id]);
      return {settings:{...defaults,...parse(own),holidays:defaults.holidays||[]},revision:Number(own?.revision||0),product};
    }
    if(node==='requests') {
      const rows=await query(`SELECT COUNT(*) OVER() AS total,pr.id,pr.quantity,pr.created_at,pr.updated_at,pr.status,pr.approval_status,pr.note,pr.request_reason_note,pr.purchase_order_id,
        CASE WHEN EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=${scope.id} AND tm.person_id=p.id AND tm.active=1) THEN p.name END AS applicant_name
        FROM procurement_requests pr LEFT JOIN people p ON p.id=pr.created_by_person_id
        WHERE pr.product_id=? AND ${inventoryTenantSql(scope,'pr')}
        AND (pr.status IN ('submitted','pending','suggested','merged') OR ${params.all==='1'?'1=1':"pr.created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MONTH)"})
        ORDER BY pr.id DESC LIMIT 50 OFFSET ?`,[id,offset]);
      return {rows,total:Number(rows[0]?.total||0)};
    }
    if(['incoming','receiving','purchase-confirm'].includes(node)) {
      // Warehouse users see dates and quantities; costs remain procurement-only.
      const financial=hasPermission(current,'procurement');
      const inspectionFilter=node==='receiving'?`AND (ir.received_at IS NOT NULL OR po.purchased_at<=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ${PROCUREMENT_INSPECTION_HOURS} HOUR))`:'';
      const rows=await query(`SELECT COUNT(*) OVER() AS total,ir.id,ir.product_id,ir.purchase_order_id,ir.quantity,ir.status,ir.received_at,ir.updated_at,
        po.order_no,po.purchased_at,ir.courier_company,ir.tracking_number,
        ${financial?'ir.amount,ir.shipping_amount,':' '}
        CASE WHEN EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=${scope.id} AND tm.person_id=buyer.id AND tm.active=1) THEN buyer.name END AS person_name
        FROM inbound_records ir JOIN products p ON p.id=ir.product_id AND ${inventoryTenantSql(scope,'p')}
        JOIN purchase_orders po ON po.id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
        LEFT JOIN people buyer ON buyer.id=ir.person_id
        WHERE ir.product_id=? AND ${inventoryTenantSql(scope,'ir')} AND ir.status IN ('approved','pending_arrival') AND po.status NOT IN ('cancelled','pending_purchase')
        AND ${node==='purchase-confirm'?(params.all==='1'?"ir.status IN ('approved','pending_arrival')":"(ir.status='pending_arrival' OR po.purchased_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 MONTH))"):"ir.status='pending_arrival'"}
        ${inspectionFilter}
        ORDER BY po.purchased_at DESC,ir.id DESC LIMIT 50 OFFSET ?`,[id,offset]);
      const requests=await query(`SELECT pr.purchase_order_id,pr.quantity,pr.created_at,pr.request_reason_note,
        CASE WHEN EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.tenant_id=${scope.id} AND tm.person_id=person.id AND tm.active=1) THEN person.name END AS applicant_name
        FROM procurement_requests pr LEFT JOIN people person ON person.id=pr.created_by_person_id
        WHERE pr.product_id=? AND ${inventoryTenantSql(scope,'pr')} AND pr.purchase_order_id IS NOT NULL`,[id]);
      const checks=await query("SELECT JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.record_id')) AS record_id,MAX(created_at) AS checked_at FROM inventory_flow_events WHERE tenant_id=? AND product_id=? AND action='transit-check' GROUP BY record_id",[scope.id,id]);
      const values=rows.map(row=>({...row,...procurementArrivalStage(row),checked_at:checks.find(c=>Number(c.record_id)===Number(row.id))?.checked_at,requests:requests.filter(r=>Number(r.purchase_order_id)===Number(row.purchase_order_id))}));
      return {rows:values,financial,total:Number(rows[0]?.total||0)};
    }
    if(node==='orders') {
      const local=await ledger({product_id:id,include_flow:'local'},scope.id);
      const ids=[...new Set((local.orders||[]).filter(r=>r.needs_fulfillment).map(r=>Number(r.order_item_id)))];
      if(!ids.length)return{rows:[]};
      const details=await query(`SELECT oi.*,o.id AS order_id,o.ordered_at,o.posting_number,o.logistics_status,s.name AS shop_name,
        mark.note AS mark_note,mark.mark_type,osh.warehouse_name,osh.tpl_provider
        FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')}
        LEFT JOIN order_marks mark ON mark.order_id=o.id LEFT JOIN order_status_history osh ON osh.id=(SELECT h.id FROM order_status_history h WHERE h.order_id=o.id AND h.shop_id=o.shop_id ORDER BY h.observed_at DESC,h.id DESC LIMIT 1)
        WHERE oi.id IN (${ids.map(()=>'?').join(',')})`,ids);
      return{rows:details.map(r=>({order_id:r.order_id,order_item_id:r.id,posting_number:r.posting_number,ordered_at:r.ordered_at,
        image_url:r.image_url||r.ozon_image_url||'',product_name:r.ozon_name||r.product_name||r.name||'',shop_name:r.shop_name,
        logistics:r.warehouse_name||r.tpl_provider||r.logistics_status,mark_note:r.mark_note||'',mark_type:r.mark_type||''}))};
    }
    throw fail('请选择采购、到货或FBS订单节点');
  }
  async function mutate(body,session) {
    const result=await transaction(async c=>{
      const q=async(sql,args=[]) => (await c.query(sql,args))[0];
      const {current,scope}=await access(session,(sql,args)=>q(sql+' FOR SHARE',args));
      const id=Number(body.product_id);await assertInventoryRecord(scope,'product',id,q,{lock:true});
      const action=String(body.action),recordId=Number(body.id),note=String(body.note||'').trim();
      if(note.length>1000)throw fail('备注最多1000字');
      if(['arrived','transit-check'].includes(action)) {
        if(!hasPermission(current,'procurement')&&!hasPermission(current,'packing'))throw fail('确认到货需要采购或仓库岗位权限',403);
        await assertInventoryRecord(scope,'inbound',recordId,q,{lock:true});
        const [row]=await q(`SELECT ir.* FROM inbound_records ir JOIN purchase_orders po ON po.id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
          WHERE ir.id=? AND ir.product_id=? AND ${inventoryTenantSql(scope,'ir')} AND po.status NOT IN ('pending_purchase','cancelled') AND po.purchased_at IS NOT NULL FOR UPDATE`,[recordId,id]);
        if(!row||row.status!=='pending_arrival')throw fail('批次已入库、已取消或不存在，请刷新核对',409);
        if(action==='arrived'){
          if(row.received_at)return{ok:true,duplicate:true};
          await q('UPDATE inbound_records SET received_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=?',[recordId]);
        }
      }else if(action==='reject') {
        if(!hasPermission(current,'procurement'))throw fail('拒绝采购申请需要采购权限',403);
        if(!note)throw fail('请填写拒绝原因：重复采购、需求变动或其他人工说明');
        await assertInventoryRecord(scope,'request',recordId,q,{lock:true});
        const [row]=await q('SELECT * FROM procurement_requests WHERE id=? FOR UPDATE',[recordId]);
        if(Number(row.product_id)!==id||!pending.includes(row.status)||row.purchase_order_id)throw fail('申请已进入采购或已处理，请刷新，不能重复拒绝',409);
        await q("UPDATE procurement_requests SET status='cancelled',approval_status='rejected',note=CONCAT(COALESCE(note,''),?),cancelled_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=?",[`\n拒绝原因：${note}`,recordId]);
      }else if(action==='order-note') {
        if(!['orders.manage','packing','procurement','inventory.write'].some(p=>hasPermission(current,p)))throw fail('当前岗位无订单协作备注权限',403);
        await assertInventoryRecord(scope,'order',recordId,q,{lock:true});
        // Verify this order actually consumes the selected physical product.
        const local=await ledger({product_id:id,include_flow:'local'},scope.id);
        if(!local.orders?.some(r=>Number(r.order_id)===recordId&&r.needs_fulfillment))throw fail('订单不属于此库存的待履约需求，请刷新',409);
        const [old]=await q('SELECT note,mark_type FROM order_marks WHERE order_id=? FOR UPDATE',[recordId]);
        if(String(old?.note||'')!==String(body.expected_note||''))throw fail('其他同事刚修改了备注，请刷新后再保存',409);
        if(!note)throw fail('请填写需要提醒运营、采购或仓库的备注');
        await q(`INSERT INTO order_marks(order_id,mark_type,note,updated_by_person_id,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP())
          ON DUPLICATE KEY UPDATE mark_type=VALUES(mark_type),note=VALUES(note),updated_by_person_id=VALUES(updated_by_person_id),updated_at=VALUES(updated_at)`,[recordId,old?.mark_type||'follow',note,current.personId]);
      }else throw fail('不支持的库存节点操作');
      await q('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES (?,?,?,?,?)',[scope.id,id,current.personId,action,JSON.stringify({record_id:recordId,note})]);
      return {ok:true};
    });
    if(body.action==='reject')invalidateOrderProcurementCoverage();return result;
  }
  return {records,mutate};
}

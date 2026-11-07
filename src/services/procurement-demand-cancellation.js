import {withMysqlTransaction} from '../mysql-pool.js';
import {createHash} from 'node:crypto';
import {authorizeBusinessTaskSession} from './business-task-tenant.js';
import {resolveInventoryTenantScope, assertInventoryRecord, inventoryTenantSql} from './inventory-tenant-scope.js';
import {hasPermission} from '../shared/permissions.js';
import {PROCUREMENT_CANCELLATION_CAUSES, activeDemandCancellations} from '../shared/procurement-demand-cancellation.js';
import {loadOrderProcurementCoverage, invalidateOrderProcurementCoverage} from './mysql-order-procurement-coverage.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), {statusCode});
export function demandCancellationRevision(orders, active, productId) {
  const sources = orders.map(row => [Number(row.order_item_id),Number(row.order_id),Boolean(row.needs_fulfillment),
    Number(row.quantity),Number(row.stock_quantity),Number(row.incoming_quantity),Number(row.shortage_quantity),Boolean(row.quantity_needs_review)])
    .sort((a,b) => a[0]-b[0]);
  const decisions = [...active.values()].filter(row => row.product_id === Number(productId)).map(row => [row.order_item_id,row.event_id]).sort((a,b) => a[0]-b[0]);
  return createHash('sha256').update(JSON.stringify({sources,decisions})).digest('hex');
}

export async function readDemandCancellationEvents(query, tenantId, productIds) {
  if (!productIds.length) return [];
  return query(`SELECT e.id,e.product_id,e.person_id,e.detail_json,e.created_at,p.name AS person_name
    FROM inventory_flow_events e LEFT JOIN people p ON p.id=e.person_id AND EXISTS(
      SELECT 1 FROM tenant_members tm WHERE tm.person_id=p.id AND tm.tenant_id=e.tenant_id AND tm.active=1)
    WHERE e.tenant_id=? AND e.product_id IN (${productIds.map(() => '?').join(',')})
      AND e.action='procurement_demand_cancellation' ORDER BY e.id`, [tenantId, ...productIds]);
}

export function createProcurementDemandCancellation({transaction = withMysqlTransaction,
  coverage = loadOrderProcurementCoverage, invalidate = invalidateOrderProcurementCoverage,
  readState = async (id,tenantId) => (await (await import('./inventory-workflow.js')).createInventoryWorkflowService().batch([id],tenantId,{fresh:true,cache:false}))[0]} = {}) {
  return async function cancel(body, session) {
    const id = Number(body.product_id), ids = [...new Set((Array.isArray(body.order_item_ids) ? body.order_item_ids : []).map(Number))].sort((a,b) => a-b);
    const operation = body.operation || 'cancel', cause = String(body.cause || ''), note = String(body.note || '').trim(), key = String(body.request_key || '');
    if (!Number.isSafeInteger(id) || id <= 0 || !ids.length || ids.length > 100 || ids.some(value => !Number.isSafeInteger(value) || value <= 0)
      || !['cancel','restore'].includes(operation) || !PROCUREMENT_CANCELLATION_CAUSES[cause] || !note || note.length > 300
      || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(key)) {
      throw fail('请选择本次不采购的订单商品，选择原因并填写1至300字说明；提交标识无效时请重新打开');
    }
    const fingerprint = JSON.stringify({product_id:id,order_item_ids:ids,operation,cause,note});
    const result = await transaction(async connection => {
      const q = async (sql,args=[]) => (await connection.query(sql,args))[0];
      const current = await authorizeBusinessTaskSession(session,(sql,args) => q(sql+' FOR UPDATE',args));
      if (!hasPermission(current,'procurement')) throw fail('取消或恢复本次采购需要本企业采购权限',403);
      const scope = await resolveInventoryTenantScope(current.tenant.id,q);
      await assertInventoryRecord(scope,'product',id,q,{lock:true});
      const [previous] = await q(`SELECT id,detail_json FROM inventory_flow_events WHERE tenant_id=? AND person_id=?
        AND action='procurement_demand_cancellation' AND JSON_UNQUOTE(JSON_EXTRACT(detail_json,'$.request_key'))=? LIMIT 1 FOR UPDATE`,[scope.id,current.personId,key]);
      if (previous) {
        const detail = typeof previous.detail_json === 'string' ? JSON.parse(previous.detail_json) : previous.detail_json;
        if (detail.fingerprint !== fingerprint) throw fail('此采购决定已保存，不能用原标识修改订单或原因，请刷新后重新操作',409);
        return {ok:true,duplicate:true,event_id:Number(previous.id),product_id:id,operation,sources:detail.sources,tenantId:scope.id};
      }
      const owned = await q(`SELECT oi.id FROM order_items oi JOIN orders o ON o.id=oi.order_id
        JOIN shops s ON s.id=o.shop_id AND ${inventoryTenantSql(scope,'s')}
        WHERE oi.id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,ids);
      if (owned.length !== ids.length) throw fail('部分订单商品不存在或不属于当前企业，请刷新明细',404);
      const events = await readDemandCancellationEvents(q,scope.id,[id]), active = activeDemandCancellations(events);
      const snapshot = await coverage(q,'',{fresh:true,productId:id,tenantId:scope.id});
      const orders = [...snapshot.values()].filter(order => order.stock_location !== 'FBP').flatMap(order => (order.items || [])
        .filter(item => Number(item.product_id) === id).map(item => ({...item,order_id:order.order_id,needs_fulfillment:order.needs_fulfillment})));
      if (String(body.expected_revision || '') !== demandCancellationRevision(orders,active,id)) throw fail('订单缺货或采购决定已变化，请刷新明细后重新选择，避免取消已经变动的需求',409);
      const sources = ids.map(order_item_id => {
        const order = orders.find(row => Number(row.order_item_id) === order_item_id), old = active.get(`${id}:${order_item_id}`);
        if (operation === 'restore') {
          if (!old) throw fail('所选订单商品没有已取消的采购决定，请刷新后核对',409);
          return {order_item_id,order_id:old.order_id,quantity:old.quantity};
        }
        if (!order || !order.needs_fulfillment || !(Number(order.shortage_quantity) > 0) || order.quantity_needs_review) throw fail('所选订单已无确定缺货，或库存绑定已经变化，请刷新明细后重试',409);
        if (old) throw fail('所选订单商品已取消本次采购；如需重新采购，请先恢复',409);
        return {order_item_id,order_id:Number(order.order_id),quantity:Number(order.shortage_quantity)};
      });
      const [inserted] = await connection.execute('INSERT INTO inventory_flow_events(tenant_id,product_id,person_id,action,detail_json) VALUES(?,?,?,?,?)',
        [scope.id,id,current.personId,'procurement_demand_cancellation',JSON.stringify({request_key:key,fingerprint,operation,cause,note,sources})]);
      if (operation === 'cancel') await connection.execute(`UPDATE procurement_requests SET status='cancelled',approval_status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
        note=CONCAT(COALESCE(note,''),'；取消本次采购：',?) WHERE product_id=? AND ${inventoryTenantSql(scope)}
        AND source_order_item_id IN (${ids.map(() => '?').join(',')}) AND demand_type='real_order'
        AND status IN('suggested','pending','submitted') AND purchase_order_id IS NULL`,[`${PROCUREMENT_CANCELLATION_CAUSES[cause]}；${note}`,id,...ids]);
      return {ok:true,duplicate:false,event_id:Number(inserted.insertId),product_id:id,operation,sources,tenantId:scope.id};
    });
    invalidate({tenantId:result.tenantId,productIds:[id]});
    const {tenantId,...response} = result;
    try { response.state = await readState(id,tenantId); }
    catch { response.refresh_needed = true; }
    return response;
  };
}
export const procurementDemandCancellation = createProcurementDemandCancellation();

import { mysqlQuery, withMysqlTransaction } from '../mysql-pool.js';
import { inventoryWorkflow, INVENTORY_DEMAND_TYPES, procurementDemandType } from '../shared/inventory-workflow.js';
import { inventoryFlow } from './inventory-flow.js';
import { resolveInventoryTenantScope, assertInventoryRecord, inventoryTenantSql } from './inventory-tenant-scope.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { stockTopupRecipients } from './warehouse-stock-topup.js';
import { loadOrderProcurementCoverage, invalidateOrderProcurementCoverage } from './mysql-order-procurement-coverage.js';
import { loadProductFbpStocks } from './fbp-inventory-display.js';
import { createInventoryFlowSummaryReader } from './inventory-flow-summary.js';
import { broadcastGlobalEvent } from '../server/notifications.js';
import { workflowCache, workflowRevision } from './inventory-workflow-cache.js';
import { hasPermission } from '../shared/permissions.js';
import { calculateLocalInventorySafety, buildInventoryFlowSummary } from './inventory-flow-summary-model.js';
import { validateFlowSettings } from './inventory-flow-rules.js';

const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export function createInventoryWorkflowService({ledger,receiveRecords,previewReceipts,query=mysqlQuery,transaction=withMysqlTransaction,forecast=inventoryFlow.detail,broadcast=broadcastGlobalEvent}={}){
  async function batch(ids,tenantId,{fresh=false,coverage:providedCoverage}={}){
    const scope=await resolveInventoryTenantScope(tenantId,query),marks=ids.map(()=>'?').join(',');
    const products=await query(`SELECT id,name,production_lead_days,warehouse_logistics_days FROM products WHERE id IN (${marks}) AND ${inventoryTenantSql(scope)}`,ids);
    if(products.length!==ids.length)throw fail('部分库存商品不存在或不属于当前企业，请刷新列表',404);
    const epoch=workflowRevision(),values=new Map(ids.map(id=>[id,workflowCache.get(`light:${scope.id}:${id}`)?.value]));
    const missing=ids.filter(id=>fresh||!(workflowCache.get(`light:${scope.id}:${id}`)?.expires>Date.now()));
    if(missing.length){
      const placeholders=missing.map(()=>'?').join(',');
      const [coverage,settingsRows,incoming,requests,applicationRows]=await Promise.all([
        providedCoverage||loadOrderProcurementCoverage(query,'',{productIds:missing,tenantId:scope.id,includeLegacyTenantNull:scope.isDefault}),
        query(`SELECT product_id,settings_json FROM inventory_flow_settings WHERE tenant_id=? AND product_id IN (0,${placeholders})`,[scope.id,...missing]),
        query(`SELECT poi.product_id,SUM(ir.quantity) AS quantity FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
          JOIN inbound_records ir ON ir.purchase_order_item_id=poi.id AND ir.product_id=poi.product_id AND ${inventoryTenantSql(scope,'ir')}
          WHERE poi.product_id IN (${placeholders}) AND ${inventoryTenantSql(scope,'poi')} AND ir.status='pending_arrival' AND po.status NOT IN ('cancelled','pending_purchase') GROUP BY poi.product_id`,missing),
        query(`SELECT id,product_id,quantity,status,demand_type,source_type,request_reason_code,source_order_item_id FROM procurement_requests WHERE product_id IN (${placeholders}) AND ${inventoryTenantSql(scope)} AND status IN ('submitted','pending','suggested')`,missing),
        query(`SELECT wp.id AS product_id,wo.id AS order_id,wi.id AS item_id,wo.status,
          wi.requested_qty * CASE WHEN wr.id IS NULL AND wi.product_id=wp.id THEN 1 ELSE SUM(COALESCE(wri.quantity,wc.quantity,1)) END AS requested_quantity
          FROM fbp_replenishment_order_items wi JOIN fbp_replenishment_orders wo ON wo.id=wi.order_id AND wo.shop_id=wi.shop_id
          JOIN shops ws ON ws.id=wo.shop_id AND ${inventoryTenantSql(scope,'ws')}
          JOIN products wp ON wp.id IN (${placeholders}) AND ${inventoryTenantSql(scope,'wp')}
          LEFT JOIN sku_inventory_recipes wr ON wr.shop_id=wi.shop_id AND wr.ozon_sku=wi.ozon_sku AND wr.active=1
          LEFT JOIN sku_inventory_recipe_items wri ON wri.recipe_id=wr.id AND wri.product_id=wp.id
          LEFT JOIN product_components wc ON wc.product_id=wi.product_id AND wc.component_product_id=wp.id AND wr.id IS NULL AND ${inventoryTenantSql(scope,'wc')}
          WHERE wo.status IN ('draft','pending_review','approved','ozon_created')
            AND ((wr.id IS NULL AND wi.product_id=wp.id) OR COALESCE(wri.product_id,wc.component_product_id)=wp.id)
            AND (wi.product_id IS NULL OR EXISTS(SELECT 1 FROM products parent WHERE parent.id=wi.product_id AND ${inventoryTenantSql(scope,'parent')}))
            AND (wi.mapping_id IS NULL OR EXISTS(SELECT 1 FROM sku_mappings m WHERE m.id=wi.mapping_id AND m.shop_id=wi.shop_id AND m.product_id=wi.product_id AND ${inventoryTenantSql(scope,'m')}))
          GROUP BY wp.id,wo.id,wi.id,wo.status,wi.requested_qty,wr.id,wi.product_id`,missing)
      ]);
      const parse=row=>typeof row?.settings_json==='string'?JSON.parse(row.settings_json):row?.settings_json||{};
      const defaults=parse(settingsRows.find(row=>!Number(row.product_id)));
      for(let offset=0;offset<missing.length;offset+=2)await Promise.all(missing.slice(offset,offset+2).map(async id=>{
        const product=products.find(p=>Number(p.id)===id),stock=coverage.inventory_stocks?.find(s=>Number(s.product_id)===id);
        const orders=[...coverage.values()].filter(o=>o.stock_location!=='FBP').flatMap(o=>o.items.filter(i=>Number(i.product_id)===id).map(i=>({...i,order_id:o.order_id,ordered_at:o.ordered_at,transport_at:o.transport_at,entered_transport:o.entered_transport,needs_fulfillment:o.needs_fulfillment,stock_location:o.stock_location})));
        const open=orders.filter(o=>o.needs_fulfillment),sum=key=>open.reduce((s,o)=>s+Number(o[key]||0),0);
        const local={product,physical_estimate:Number(stock?.ledger||0)+Number(stock?.open_deducted||0),open_order_demand:sum('quantity'),fbp_reserved:Number(stock?.fbp_reserved||0),current_shortage:sum('shortage_quantity'),current_incoming:sum('incoming_quantity'),incoming_quantity:Number(incoming.find(r=>Number(r.product_id)===id)?.quantity||0),orders};
        const settings=validateFlowSettings({...defaults,...parse(settingsRows.find(r=>Number(r.product_id)===id)),holidays:defaults.holidays||[]});
        const applications=applicationRows.filter(row=>Number(row.product_id)===id);
        local.flow_summary=buildInventoryFlowSummary(local,calculateLocalInventorySafety(local,settings),orders,applications);
        const result={...inventoryWorkflow(local,{applications,requests:requests.filter(r=>Number(r.product_id)===id)}),product_id:id};
        values.set(id,result);
        if(epoch===workflowRevision())workflowCache.set(`light:${scope.id}:${id}`,{expires:Date.now()+20000,value:result});
      }));
    }
    return ids.map(id=>values.get(id));
  }
  async function receiptSession(session,connection){
    const current=await authorizeBusinessTaskSession(session,connection?async(sql,args)=>(await connection.query(sql+' FOR SHARE',args))[0]:undefined);
    if(!hasPermission(current,'packing')&&!hasPermission(current,'procurement'))throw fail('登记入库需要本企业仓库打包或采购权限',403);
    return current;
  }
  async function receipts(productId,session){
    const current=await receiptSession(session),scope=await resolveInventoryTenantScope(current.tenant.id,query);
    await assertInventoryRecord(scope,'product',Number(productId),query);
    return query(`SELECT ir.id,ir.quantity,ir.updated_at,po.order_no FROM inbound_records ir
      LEFT JOIN purchase_orders po ON po.id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
      LEFT JOIN procurement_requests pr ON pr.id=ir.procurement_request_id AND ${inventoryTenantSql(scope,'pr')}
      WHERE ir.product_id=? AND ${inventoryTenantSql(scope,'ir')} AND ir.status='pending_arrival'
        AND ((po.status IN ('purchased','partial_inbound') AND po.purchased_at IS NOT NULL) OR pr.status='purchased')
      ORDER BY ir.id`,[Number(productId)]);
  }
  async function receive(body,session){
    const current=await receiptSession(session),id=Number(body.product_id),rows=await receipts(id,current);
    const selected=Array.isArray(body.records)?body.records:[];
    if(!selected.length||selected.length>100)throw fail('请选择实际验收合格的到货批次，单次最多100条');
    if(new Set(selected.map(r=>Number(r.id))).size!==selected.length)throw fail('到货批次重复，请刷新后重试');
    const checked=selected.map(row=>{
      const saved=rows.find(r=>Number(r.id)===Number(row.id)),amount=Number(row.quantity);
      if(!saved||!Number.isSafeInteger(amount)||amount<=0||amount>Number(saved.quantity)||Number(row.expected_quantity)!==Number(saved.quantity))throw fail('实收件数须大于0且不超过当前待收数量；批次已变化时请刷新核对',409);
      if(amount<Number(saved.quantity)&&!String(row.reason||'').trim())throw fail('部分入库须说明未收部分：尚未到货、验货不合格或其他原因');
      return{id:Number(saved.id),receive_quantity:amount,expected_remaining_quantity:Number(saved.quantity),receipt_difference_reason:String(row.reason||'').slice(0,100),receipt_difference_note:String(row.note||'').slice(0,500),version_updated_at:saved.updated_at};
    });
    const impact=await previewReceipts({records:checked},current.tenant.id);
    let payload;
    if(impact.suggest_historical){
      const count=Number(body.counted_quantity);
      if(!Number.isSafeInteger(count)||count<0||body.counted_quantity==null)throw fail('本商品有历史出库或盘点，请填写当前实际在仓总数（counted_quantity），避免重复增加已经盘点过的货');
      const reference=impact.impacts.find(r=>Number(r.product_id)===id);
      payload={request_key:String(body.request_key||''),historical_receipt_groups:[{product_id:id,revision:reference?.revision,counted_quantity:count,receipts:checked}]};
    }else payload={receipt_impact_confirmed:true,records:checked.map(r=>({id:r.id,payload:{...r,status:'approved',qc_status:'approved',receipt_context:'统一库存详情登记入库'}}))};
    return receiveRecords(payload,current.personId,current.tenant.id,{receipt:true,beforeWrite:connection=>receiptSession(session,connection)});
  }
  async function read(productId,tenantId,{fresh=false}={}){
    const scope=await resolveInventoryTenantScope(tenantId,query),id=Number(productId);
    await assertInventoryRecord(scope,'product',id,query);
    const key=`${scope.id}:${id}`,epoch=workflowRevision(),cached=workflowCache.get(key);
    if(!fresh&&cached&&cached.expires>Date.now())return cached.promise;
    const promise=(async()=>{
      const [local,fbp,requests]=await Promise.all([
        ledger({product_id:id,include_flow:'local'},scope.id),ledger({product_id:id,view:'fbp'},scope.id),
        query(`SELECT pr.id,pr.quantity,pr.status,pr.demand_type,pr.request_reason_code,pr.request_reason_note,pr.source_type,pr.source_order_id,pr.source_order_item_id,pr.created_at,
          CASE WHEN EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.person_id=p.id AND tm.tenant_id=? AND tm.active=1) THEN p.name ELSE NULL END AS applicant_name
          FROM procurement_requests pr LEFT JOIN people p ON p.id=pr.created_by_person_id
          WHERE pr.product_id=? AND ${inventoryTenantSql(scope,'pr')} AND pr.status IN ('pending','submitted','suggested') ORDER BY pr.created_at DESC`,[scope.id,id])
      ]);
      let prediction,forecastError='';
      try{prediction=await forecast(id,scope.id,{official:fbp.fbp_inventory,balance:{physical_stock:local.physical_estimate,open_order_demand_qty:local.open_order_demand,fbp_reserved_qty:local.fbp_reserved}});}
      catch(e){if([403,404].includes(e.statusCode))throw e;forecastError='FBP备货预测暂不可用，可查看现有申请或手动选择SKU备货';}
      const projected={...local,fbp_inventory:fbp.fbp_inventory,flow_summary:{...local.flow_summary,applications:fbp.applications,applications_pending:false}};
      const result=inventoryWorkflow(projected,{applications:fbp.applications,forecast:prediction,requests});
      return {...result,product_id:id,forecast_error:forecastError,settings:prediction?.settings,
        skus:(prediction?.skus||[]).map(r=>({shop_id:r.shop_id,shop_name:r.shop_name,ozon_sku:r.ozon_sku,mapping_id:r.mapping_id,offer_id:r.offer_id,per_set_quantity:r.per_set_quantity,category:r.category,suggested_qty:r.suggested_qty,available:r.available,status:r.status})),
        applications:fbp.applications,
        purchases:(local.purchases||[]).filter(p=>Number(p.pending_quantity)>0).map(p=>({id:p.id,order_no:p.order_no,person_name:p.person_name,purchased_at:p.purchased_at,pending_quantity:p.pending_quantity})),
        batches:(local.batches||[]).filter(b=>b.status==='pending_arrival').map(b=>({id:b.id,quantity:b.quantity,purchase_order_no:b.purchase_order_no,status:b.status})),
        requests:requests.map(r=>({...r,type:procurementDemandType(r)}))};
    })();
    if(workflowCache.size>3000)workflowCache.clear();
    workflowCache.set(key,{promise,expires:Date.now()+20000});
    try{return await promise;}catch(e){if(workflowRevision()===epoch)workflowCache.delete(key);throw e;}
  }
  async function submit(body,session){
    const id=Number(body.product_id),quantity=Number(body.quantity),type=String(body.demand_type||''),note=String(body.note||'').trim(),requestKey=String(body.request_key||'');
    if(!INVENTORY_DEMAND_TYPES.some(t=>t.key===type)||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000||!Number.isSafeInteger(id)||id<1)throw fail('请选择三类采购需求之一、库存商品和大于0的整数件数');
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestKey)||note.length>500)throw fail('本次申请标识无效或说明超过500字，请重新打开申请表');
    const result=await transaction(async c=>{
      const q=async(sql,args=[])=>(await c.query(sql,args))[0];
      const current=await authorizeBusinessTaskSession(session,(sql,args)=>q(sql+' FOR UPDATE',args));
      const scope=await resolveInventoryTenantScope(current.tenant.id,q);
      const product=await assertInventoryRecord(scope,'product',id,q,{lock:true});
      const group=`WF-${current.personId}-${requestKey}`,reason=`flow_${type}`;
      const previous=await q('SELECT id,product_id,quantity,request_reason_code,request_reason_note FROM procurement_requests WHERE tenant_id=? AND request_group_no=? FOR UPDATE',[scope.id,group]);
      if(previous[0]){const old=previous[0];if(Number(old.product_id)!==id||Number(old.quantity)!==quantity||old.request_reason_code!==reason||String(old.request_reason_note||'')!==note)throw fail('本次申请已提交，不能使用原标识修改内容，请刷新查看申请',409);return{ok:true,id:Number(old.id),duplicate:true,recipients:[],tenantId:scope.id};}
      let orderId=Number(body.order_id)||null;
      if(orderId||type==='real_order'){
        const coverage=await loadOrderProcurementCoverage(q,'',{fresh:true,productId:id,tenantId:scope.id,includeLegacyTenantNull:scope.isDefault});
        const orders=[...coverage.entries()].filter(([oid,row])=>(!orderId||Number(oid)===orderId)&&row.needs_fulfillment&&row.stock_location!=='FBP'&&row.items?.some(i=>Number(i.product_id)===id));
        if(!orders.length)throw fail('FBS订单需求须关联本企业待履约且已绑定此库存的订单，请先核对绑定或选择本地安全保障需求');
        orderId=Number(orders[0][0]);await assertInventoryRecord(scope,'order',orderId,q);
      }
      if(type==='fbp_stock'){
        const stocks=await loadProductFbpStocks(q,id,scope);
        const summary=await createInventoryFlowSummaryReader({query:q})({product:{id},fbp_inventory:stocks},scope.id,{fbpOnly:true});
        const pending=summary.applications.filter(a=>a.status==='pending_review');
        const locked=pending.length?await q(`SELECT wo.id FROM fbp_replenishment_orders wo JOIN shops ws ON ws.id=wo.shop_id AND ${inventoryTenantSql(scope,'ws')} WHERE wo.id IN (${[...new Set(pending.map(a=>Number(a.order_id)))].map(()=>'?').join(',')}) AND wo.status='pending_review' FOR UPDATE`,[...new Set(pending.map(a=>Number(a.order_id)))]):[];
        if(!locked.length)throw fail('请先提交FBP备货申请；备货机会和草稿不产生正式采购需求');
      }
      const members=await q(`SELECT p.id,p.name,p.role,p.roles_json,tm.role AS tenant_role,tm.business_roles_json,t.slug AS tenant_slug FROM tenant_members tm
        JOIN people p ON p.id=tm.person_id AND p.active=1 JOIN tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=? AND tm.active=1 FOR UPDATE`,[scope.id]);
      const recipients=stockTopupRecipients(members);if(!recipients.length)throw fail('本企业暂无有效管理员或采购岗位，请先在企业人员中配置接收人',409);
      const label=INVENTORY_DEMAND_TYPES.find(t=>t.key===type).label;
      const [r]=await c.execute(`INSERT INTO procurement_requests(tenant_id,request_group_no,product_id,binding_status,person_id,created_by_person_id,quantity,amount,shipping_amount,approval_status,status,note,urgency,source_type,source_order_id,demand_type,request_reason_code,request_reason_note,purchase_mode)
        VALUES(?,?,?,'bound',?,?,?,0,0,'submitted','submitted',?,'normal','warehouse',?,'warehouse_request',?,?,'shortage_purchase')`,[scope.id,group,id,current.personId,current.personId,quantity,`${label}：${note}`,orderId,reason,note||null]);
      const requestId=Number(r.insertId),sender=members.find(m=>Number(m.id)===current.personId)?.name||'企业成员';
      for(const recipient of recipients)await c.execute(`INSERT INTO system_notifications(tenant_id,recipient_person_id,notification_type,title,content,severity,route,entity_type,entity_id,dedupe_key,status)
        VALUES(?,?,'stock_topup',?,?,'warning',?,'procurement',?,?,'unread')`,[scope.id,recipient,label,`${sender}提请采购：${product.name}，${quantity}件。${note}`,`/procurement/workspace?demandType=${type}&message_request_id=${requestId}`,String(requestId),`${scope.id}:workflow:${requestId}:${recipient}`]);
      return{ok:true,id:requestId,duplicate:false,recipients,tenantId:scope.id};
    });
    invalidateOrderProcurementCoverage();
    for(const personId of result.recipients){try{broadcast('system-notification',{refresh:true},{tenantId:result.tenantId,personId});}catch{}}
    return{ok:true,id:result.id,duplicate:result.duplicate,notified:result.recipients.length};
  }
  return{read,batch,submit,receipts,receive};
}

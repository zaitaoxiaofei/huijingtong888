import { createInventoryDemandSnapshot, limitInventoryDemandQueries } from './inventory-demand-snapshot.js';
import { createInventoryWorkspaceReader } from './inventory-workspace-reader.js';
import { inventoryProductSearch } from './inventory-product-search.js';
import { inventoryIdentifierSearch,isInventoryIdentifier,inventoryNamePattern } from './inventory-search.js';
import { mysqlQuery, withMysqlTransaction } from '../mysql-pool.js';
import { inventoryWorkflow, INVENTORY_DEMAND_TYPES, procurementDemandType } from '../shared/inventory-workflow.js';
import { fbpSupplyState } from '../shared/fbp-supply-state.js';
import { loadFbpSafetyProjections } from './fbp-safety-projection.js';
import { inventoryFlow, createInventoryFlowService } from './inventory-flow.js';
import { resolveInventoryTenantScope, assertInventoryRecord, inventoryTenantSql } from './inventory-tenant-scope.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { stockTopupRecipients } from './warehouse-stock-topup.js';
import { loadOrderProcurementCoverage, invalidateOrderProcurementCoverage } from './mysql-order-procurement-coverage.js';
import { loadProductsFbpStockTotals, loadProductFbpStocks } from './fbp-inventory-display.js';
import { createInventoryFlowSummaryReader } from './inventory-flow-summary.js';
import { broadcastGlobalEvent } from '../server/notifications.js';
import { workflowCache, workflowRevision } from './inventory-workflow-cache.js';
import { hasPermission } from '../shared/permissions.js';
import { calculateLocalInventorySafety, buildInventoryFlowSummary } from './inventory-flow-summary-model.js';
import { validateFlowSettings } from './inventory-flow-rules.js';

const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
export function createInventoryWorkflowService({ledger,receiveRecords,previewReceipts,query=mysqlQuery,transaction=withMysqlTransaction,forecast=inventoryFlow.detail,broadcast=broadcastGlobalEvent}={}){
  async function batch(ids,tenantId,{fresh=false,coverage:providedCoverage,localOnly=false,cache=true}={}){
    const scope=await resolveInventoryTenantScope(tenantId,query),marks=ids.map(()=>'?').join(',');
    const products=await query(`SELECT id,name,production_lead_days,warehouse_logistics_days FROM products WHERE id IN (${marks}) AND ${inventoryTenantSql(scope)}`,ids);
    if(products.length!==ids.length)throw fail('部分库存商品不存在或不属于当前企业，请刷新列表',404);
    const prefix=localOnly?'local:':'light:';
    const epoch=workflowRevision(),values=new Map(ids.map(id=>[id,workflowCache.get(`${prefix}${scope.id}:${id}`)?.value]));
    const missing=ids.filter(id=>fresh||!(workflowCache.get(`${prefix}${scope.id}:${id}`)?.expires>Date.now()));
    if(missing.length){
      const placeholders=missing.map(()=>'?').join(',');
      const [coverage,settingsRows,incoming,sourceRows]=await Promise.all([
        providedCoverage||loadOrderProcurementCoverage(query,'',{productIds:missing,tenantId:scope.id,includeLegacyTenantNull:scope.isDefault,localStateOnly:localOnly}),
        query(`SELECT product_id,settings_json FROM inventory_flow_settings WHERE tenant_id=? AND product_id IN (0,${placeholders})`,[scope.id,...missing]),
        localOnly?Promise.resolve([]):query(`SELECT poi.product_id,SUM(ir.quantity) AS quantity FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
          JOIN inbound_records ir ON ir.purchase_order_item_id=poi.id AND ir.product_id=poi.product_id AND ${inventoryTenantSql(scope,'ir')}
          WHERE poi.product_id IN (${placeholders}) AND ${inventoryTenantSql(scope,'poi')} AND ir.status='pending_arrival' AND po.status NOT IN ('cancelled','pending_purchase') GROUP BY poi.product_id`,missing),
        localOnly?Promise.resolve({requests:[],applications:[]}):workspaceSources(missing,scope.id)
      ]);
      const {requests,applications:applicationRows}=sourceRows;
      const parse=row=>typeof row?.settings_json==='string'?JSON.parse(row.settings_json):row?.settings_json||{};
      const defaults=parse(settingsRows.find(row=>!Number(row.product_id)));
      const group=rows=>{const values=new Map();for(const row of rows){const id=Number(row.product_id);if(!values.has(id))values.set(id,[]);values.get(id).push(row);}return values;};
      const byProduct=new Map(products.map(row=>[Number(row.id),row]));
      const stocks=new Map((coverage.inventory_stocks||[]).map(row=>[Number(row.product_id),row]));
      const settingsByProduct=new Map(settingsRows.map(row=>[Number(row.product_id),row]));
      const incomingByProduct=new Map(incoming.map(row=>[Number(row.product_id),row]));
      const requestsByProduct=group(requests),applicationsByProduct=group(applicationRows),ordersByProduct=new Map();
      const fbpForecasts=localOnly?new Map():await loadFbpSafetyProjections(query,missing.map(id=>byProduct.get(id)),scope,id=>({...defaults,...parse(settingsByProduct.get(id)),holidays:defaults.holidays||[]}));
      // Index once: global warning pages must not scan the entire order history for every product.
      for(const order of coverage.values())if(order.stock_location!=='FBP')for(const item of order.items||[]){
        const id=Number(item.product_id);if(!ordersByProduct.has(id))ordersByProduct.set(id,[]);
        ordersByProduct.get(id).push({...item,order_id:order.order_id,ordered_at:order.ordered_at,transport_at:order.transport_at,entered_transport:order.entered_transport,needs_fulfillment:order.needs_fulfillment,stock_location:order.stock_location});
      }

      for(let offset=0;offset<missing.length;offset+=2)await Promise.all(missing.slice(offset,offset+2).map(async id=>{
        const product=byProduct.get(id),stock=stocks.get(id);
        const orders=ordersByProduct.get(id)||[];
        const open=orders.filter(o=>o.needs_fulfillment),sum=key=>open.reduce((s,o)=>s+Number(o[key]||0),0);
        const local={product,physical_estimate:Number(stock?.ledger||0)+Number(stock?.open_deducted||0),open_order_demand:sum('quantity'),fbp_reserved:Number(stock?.fbp_reserved||0),current_shortage:sum('shortage_quantity'),current_incoming:sum('incoming_quantity'),incoming_quantity:Number(incomingByProduct.get(id)?.quantity||0),orders};
        const settings=validateFlowSettings({...defaults,...parse(settingsByProduct.get(id)),holidays:defaults.holidays||[]});
        const applications=applicationsByProduct.get(id)||[];
        local.flow_summary=buildInventoryFlowSummary(local,calculateLocalInventorySafety(local,settings),orders,applications);
        const policy={...inventoryWorkflow(local,{applications,forecast:fbpForecasts.get(id),requests:requestsByProduct.get(id)||[]}),applications};
        // A local-only snapshot has no procurement-allocation evidence. Expose quantities only.
        const result=localOnly?{product_id:id,physical:policy.physical,free:policy.free,order_demand:policy.order_demand,safety:policy.safety,locked:policy.locked}:{...policy,product_id:id};
        values.set(id,result);
        if(cache&&epoch===workflowRevision())workflowCache.set(`${prefix}${scope.id}:${id}`,{expires:Date.now()+20000,value:result});
      }));
    }
    return ids.map(id=>values.get(id));
  }
  const workspaceStates=createInventoryWorkspaceReader({batch,coverage:(ids,tenantId)=>loadOrderProcurementCoverage(query,'',{...(ids.length<=32?{productIds:ids}:{}),tenantId}),revision:workflowRevision});
  async function workspaceSources(ids,tenantId){
    if(!ids.length)return {requests:[],applications:[]};
    const scope=await resolveInventoryTenantScope(tenantId,query),placeholders=ids.map(()=>'?').join(',');
    const [requests,applications]=await Promise.all([
        query(`SELECT pr.id,pr.product_id,pr.quantity,pr.status,pr.demand_type,pr.source_type,pr.request_reason_code,pr.source_order_item_id,pr.created_at,
          CASE WHEN EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.person_id=person.id AND tm.tenant_id=${scope.id} AND tm.active=1) THEN person.name ELSE NULL END AS applicant_name
          FROM procurement_requests pr LEFT JOIN people person ON person.id=pr.created_by_person_id WHERE pr.product_id IN (${placeholders}) AND ${inventoryTenantSql(scope,'pr')} AND pr.status IN ('submitted','pending','suggested')`,ids),
        query(`SELECT wp.id AS product_id,wo.id AS order_id,wi.id AS item_id,wo.status,wi.shop_id,wi.ozon_sku,ws.name AS shop_name,wo.order_no,wo.submitted_at,wo.created_at,
          CASE WHEN EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.person_id=applicant.id AND tm.tenant_id=${scope.id} AND tm.active=1) THEN applicant.name ELSE NULL END AS applicant_name,
          wi.requested_qty * CASE WHEN wr.id IS NULL AND wi.product_id=wp.id THEN 1 ELSE SUM(COALESCE(wri.quantity,wc.quantity,1)) END AS requested_quantity
          FROM fbp_replenishment_order_items wi JOIN fbp_replenishment_orders wo ON wo.id=wi.order_id AND wo.shop_id=wi.shop_id
          JOIN shops ws ON ws.id=wo.shop_id AND ${inventoryTenantSql(scope,'ws')}
          LEFT JOIN people applicant ON applicant.id=COALESCE(wi.requested_by,wo.created_by)
          JOIN products wp ON wp.id IN (${placeholders}) AND ${inventoryTenantSql(scope,'wp')}
          LEFT JOIN sku_inventory_recipes wr ON wr.shop_id=wi.shop_id AND wr.ozon_sku=wi.ozon_sku AND wr.active=1
          LEFT JOIN sku_inventory_recipe_items wri ON wri.recipe_id=wr.id AND wri.product_id=wp.id
          LEFT JOIN product_components wc ON wc.product_id=wi.product_id AND wc.component_product_id=wp.id AND wr.id IS NULL AND ${inventoryTenantSql(scope,'wc')}
          WHERE wo.status IN ('draft','pending_review','approved','ozon_created')
            AND ((wr.id IS NULL AND wi.product_id=wp.id) OR COALESCE(wri.product_id,wc.component_product_id)=wp.id)
            AND (wi.product_id IS NULL OR EXISTS(SELECT 1 FROM products parent WHERE parent.id=wi.product_id AND ${inventoryTenantSql(scope,'parent')}))
            AND (wi.mapping_id IS NULL OR EXISTS(SELECT 1 FROM sku_mappings m WHERE m.id=wi.mapping_id AND m.shop_id=wi.shop_id AND m.product_id=wi.product_id AND ${inventoryTenantSql(scope,'m')}))
          GROUP BY wp.id,wo.id,wi.id,wo.status,wi.shop_id,wi.ozon_sku,wi.requested_qty,wr.id,wi.product_id,ws.name,wo.order_no,wo.submitted_at,wo.created_at,applicant.id,applicant.name`,ids)
    ]);return{requests,applications};
  }
  const backgroundQuery=limitInventoryDemandQueries(query);let backgroundService;
  const background=()=>backgroundService??=createInventoryWorkflowService({query:backgroundQuery});
  const workspaceSnapshot=createInventoryDemandSnapshot({query,calculate:(ids,tenantId,options)=>background().workspaceStates(ids,tenantId,options),products:tenantId=>background().workspaceProducts({},tenantId),revision:workflowRevision});
  async function localQuantities(ids,tenantId){
    const scope=await resolveInventoryTenantScope(tenantId,query),marks=ids.map(()=>'?').join(',');
    const parts=await query(`SELECT c.product_id,c.component_product_id,c.quantity FROM product_components c WHERE c.product_id IN (${marks}) AND ${inventoryTenantSql(scope,'c')}`,ids);
    const all=[...new Set([...ids,...parts.map(row=>Number(row.component_product_id))])];
    const values=await batch(all,scope.id,{localOnly:true}),byId=new Map(values.map(row=>[row.product_id,row]));
    const official=await loadProductsFbpStockTotals(query,ids,scope);
    return ids.map(id=>{
      const children=parts.filter(row=>Number(row.product_id)===id),value=byId.get(id);
      const count=key=>{if(!children.length)return value?.[key]??null;const quantities=children.map(row=>{const v=byId.get(Number(row.component_product_id))?.[key],units=Number(row.quantity);return v!=null&&units>0?Math.floor(v/units):null;});return quantities.every(v=>v!==null)?Math.min(...quantities):null;};
      return {product_id:id,workflow_free:count('free'),physical_stock:count('physical'),fbp_stock_known:official.get(id)?.present??null};
    });
  }
  async function workspaceProducts(params,tenantId){
    const scope=await resolveInventoryTenantScope(tenantId,query),search=String(params.query||'').trim().slice(0,200),mode=String(params.searchMode||'auto');
    const criteria=inventoryProductSearch({...params,query:mode==='sku'?'':search},scope,'p'),where=criteria.sql?[criteria.sql]:[],args=[...criteria.params];
    if(search&&(mode==='auto'||mode==='sku')){
      const exact=mode==='sku'||isInventoryIdentifier(search),operator=exact?'=':"LIKE",text=exact?search:inventoryNamePattern(search),escape=exact?'':" ESCAPE '='";
      const skuSql=`(EXISTS(SELECT 1 FROM sku_mappings m JOIN shops s ON s.id=m.shop_id AND ${inventoryTenantSql(scope,'s')} JOIN products root ON root.id=m.product_id AND ${inventoryTenantSql(scope,'root')}
        WHERE m.active=1 AND ${inventoryTenantSql(scope,'m')} AND (m.ozon_sku ${operator} ?${escape} OR m.offer_id ${operator} ?${escape})
        AND ((NOT EXISTS(SELECT 1 FROM sku_inventory_recipes r WHERE r.active=1 AND r.shop_id=m.shop_id AND r.ozon_sku=m.ozon_sku)
          AND (m.product_id=p.id OR EXISTS(SELECT 1 FROM product_components c WHERE c.product_id=m.product_id AND c.component_product_id=p.id AND ${inventoryTenantSql(scope,'c')})))
          OR EXISTS(SELECT 1 FROM sku_inventory_recipes r JOIN sku_inventory_recipe_items i ON i.recipe_id=r.id WHERE r.active=1 AND r.shop_id=m.shop_id AND r.ozon_sku=m.ozon_sku AND i.product_id=p.id)))
        OR EXISTS(SELECT 1 FROM sku_inventory_recipes r JOIN sku_inventory_recipe_items i ON i.recipe_id=r.id JOIN shops s ON s.id=r.shop_id AND ${inventoryTenantSql(scope,'s')} WHERE r.active=1 AND i.product_id=p.id AND r.ozon_sku ${operator} ?${escape}))`;
      if(mode==='sku'){where.push(skuSql);args.push(text,text,text);}
      else if(exact){const id=inventoryIdentifierSearch(search,'inventory_id');where.push(`(p.id IN (${id.sql}) OR ${skuSql})`);args.push(...id.params,text,text,text);}
      else{const name=inventoryProductSearch({searchMode:'name',query:search},scope);where.push(`((${name.sql}) OR ${skuSql})`);args.push(...name.params,text,text,text);}
    }
    // Include never-stocked physical products, not a second copy of their virtual parent.
    return query(`SELECT p.id AS product_id,p.name AS product_name,p.inventory_number,p.code AS inventory_id FROM products p
      WHERE p.active=1 AND COALESCE(p.product_type,'main')!='selection' AND ${inventoryTenantSql(scope,'p')}
        AND NOT EXISTS(SELECT 1 FROM product_components c WHERE c.product_id=p.id AND ${inventoryTenantSql(scope,'c')})
        ${where.length?'AND '+where.map(w=>'('+w+')').join(' AND '):''} ORDER BY p.id`,args);
  }
  async function workspaceFeedback(ids,tenantId){
    if(!ids.length)return[];
    const scope=await resolveInventoryTenantScope(tenantId,query);
    if(ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw fail('请选择最多100个库存商品');
    return query(`SELECT n.entity_id AS product_id,n.title,n.content,MAX(n.created_at) AS created_at FROM system_notifications n
      JOIN products p ON p.id=n.entity_id AND ${inventoryTenantSql(scope,'p')}
      WHERE n.tenant_id=? AND n.notification_type='stock_topup' AND n.entity_type='inventory' AND n.entity_id IN (${ids.map(()=>'?').join(',')})
      GROUP BY n.entity_id,n.title,n.content ORDER BY created_at DESC LIMIT 500`,[scope.id,...ids]);
  }
  async function workspaceBatches(ids,tenantId){
    const scope=await resolveInventoryTenantScope(tenantId,query);
    if(!ids.length)return[];
    if(ids.length>100||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw fail('请选择最多100个库存商品');
    return query(`SELECT ir.id,ir.product_id,ir.quantity,ir.updated_at,ir.status,ir.received_at,ir.purchase_order_id,ir.tracking_number,ir.courier_company,po.order_no,po.purchased_at,po.status AS purchase_status
      FROM inbound_records ir JOIN products p ON p.id=ir.product_id AND ${inventoryTenantSql(scope,'p')}
      LEFT JOIN purchase_orders po ON po.id=ir.purchase_order_id AND ${inventoryTenantSql(scope,'po')}
      LEFT JOIN procurement_requests pr ON pr.id=ir.procurement_request_id AND ${inventoryTenantSql(scope,'pr')}
      WHERE ir.product_id IN (${ids.map(()=>'?').join(',')}) AND ${inventoryTenantSql(scope,'ir')} AND ir.status='pending_arrival'
        AND ((po.status IN ('purchased','partial_inbound') AND po.purchased_at IS NOT NULL) OR pr.status='purchased')
      ORDER BY po.purchased_at,ir.id`,ids);
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
  async function skuDetails(productId,shopId,ozonSku,tenantId){
    const scope=await resolveInventoryTenantScope(tenantId,query),id=Number(productId),shop=Number(shopId),sku=String(ozonSku||'');
    await assertInventoryRecord(scope,'product',id,query);
    await assertInventoryRecord(scope,'shop',shop,query);
    const stock=await loadProductFbpStocks(query,id,scope);
    const binding=stock.rows.find(row=>Number(row.shop_id)===shop&&String(row.ozon_sku)===sku);
    if(!binding)throw fail('此SKU未通过当前有效绑定或组成关联此库存，请刷新核对',404);
    const root=binding.root_product_id?await assertInventoryRecord(scope,'product',Number(binding.root_product_id),query):null;
    const recipes=await query('SELECT id,mode FROM sku_inventory_recipes WHERE shop_id=? AND ozon_sku=? AND active=1',[shop,sku]);
    if(recipes.length>1)throw fail('此SKU存在多条有效配方，请先在SKU绑定中核对',409);
    let source='direct',components=[];
    if(recipes.length){
      source='recipe';components=await query(`SELECT i.product_id,p.inventory_number,p.name,p.stock_unit,i.quantity FROM sku_inventory_recipe_items i LEFT JOIN products p ON p.id=i.product_id AND ${inventoryTenantSql(scope,'p')} WHERE i.recipe_id=?`,[recipes[0].id]);
    }else if(root){
      components=await query(`SELECT c.component_product_id AS product_id,p.inventory_number,p.name,p.stock_unit,c.quantity FROM product_components c LEFT JOIN products p ON p.id=c.component_product_id AND ${inventoryTenantSql(scope,'p')} WHERE c.product_id=? AND ${inventoryTenantSql(scope,'c')}`,[root.id]);
      if(components.length)source='bundle';else components=[{product_id:root.id,inventory_number:root.inventory_number,name:root.name,stock_unit:root.stock_unit,quantity:1}];
    }
    if(components.some(row=>!row.name))throw fail('SKU组成包含不可访问或缺失的库存资料，请管理员核对绑定',409);
    return {product_id:id,shop_id:shop,ozon_sku:sku,source,root:root?{id:root.id,inventory_number:root.inventory_number,name:root.name}:null,
      components:components.map(row=>({...row,quantity:Number(row.quantity),current:Number(row.product_id)===id,image_url:`/api/products/${Number(row.product_id)}/image?thumb=1`}))};
  }
  async function readRequestRows(id,scope){
    return query(`SELECT pr.id,pr.quantity,pr.status,pr.demand_type,pr.request_reason_code,pr.request_reason_note,pr.source_type,pr.source_order_id,pr.source_order_item_id,pr.created_at,
          CASE WHEN EXISTS(SELECT 1 FROM tenant_members tm WHERE tm.person_id=p.id AND tm.tenant_id=? AND tm.active=1) THEN p.name ELSE NULL END AS applicant_name
          FROM procurement_requests pr LEFT JOIN people p ON p.id=pr.created_by_person_id
          WHERE pr.product_id=? AND ${inventoryTenantSql(scope,'pr')} AND pr.status IN ('pending','submitted','suggested') ORDER BY pr.created_at DESC`,[scope.id,id]);
  }
  async function requests(productId,tenantId){
    const scope=await resolveInventoryTenantScope(tenantId,query),id=Number(productId);
    await assertInventoryRecord(scope,'product',id,query);
    return {product_id:id,requests:(await readRequestRows(id,scope)).map(row=>({...row,type:procurementDemandType(row)}))};
  }
  async function read(productId,tenantId,{fresh=false}={}){
    const scope=await resolveInventoryTenantScope(tenantId,query),id=Number(productId);
    await assertInventoryRecord(scope,'product',id,query);
    const key=`${scope.id}:${id}`,epoch=workflowRevision(),cached=workflowCache.get(key);
    if(!fresh&&cached&&cached.expires>Date.now())return cached.promise;
    const promise=(async()=>{
      const [local,fbp,requests]=await Promise.all([
        ledger({product_id:id,include_flow:'local'},scope.id),ledger({product_id:id,view:'fbp'},scope.id),
        readRequestRows(id,scope)
      ]);
      let prediction,forecastError='';
      try{prediction=await forecast(id,scope.id,{official:fbp.fbp_inventory,balance:{physical_stock:local.physical_estimate,open_order_demand_qty:local.open_order_demand,fbp_reserved_qty:local.fbp_reserved}});}
      catch(e){if([403,404].includes(e.statusCode))throw e;forecastError='FBP备货预测暂不可用，可查看现有申请或手动选择SKU备货';}
      const projected={...local,fbp_inventory:fbp.fbp_inventory,flow_summary:{...local.flow_summary,applications:fbp.applications,applications_pending:false}};
      const result=inventoryWorkflow(projected,{applications:fbp.applications,forecast:prediction,requests});
      return {...result,product_id:id,forecast_error:forecastError,settings:prediction?.settings,
        forecast:prediction?{skus:prediction.skus,stock_incomplete:prediction.stock_incomplete}:null,
        skus:(prediction?.skus||[]).map(r=>({shop_id:r.shop_id,shop_name:r.shop_name,ozon_sku:r.ozon_sku,mapping_id:r.mapping_id,offer_id:r.offer_id,per_set_quantity:r.per_set_quantity,category:r.category,suggested_qty:r.suggested_qty,available:r.available,status:r.status})),
        applications:fbp.applications,transfers:fbp.transfers,
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
        const pending=summary.applications.filter(a=>['pending_review','approved','ozon_created'].includes(a.status));
        const locked=pending.length?await q(`SELECT wo.id FROM fbp_replenishment_orders wo JOIN shops ws ON ws.id=wo.shop_id AND ${inventoryTenantSql(scope,'ws')} WHERE wo.id IN (${[...new Set(pending.map(a=>Number(a.order_id)))].map(()=>'?').join(',')}) AND wo.status IN ('pending_review','approved','ozon_created') FOR UPDATE`,[...new Set(pending.map(a=>Number(a.order_id)))]):[];
        if(!locked.length){
          const prediction=await createInventoryFlowService({query:q}).detail(id,scope.id,{official:stocks,balance:{physical_stock:0,open_order_demand_qty:0,fbp_reserved_qty:0}});
          const replenishment=fbpSupplyState(prediction,stocks);
          if(!replenishment.known||!(replenishment.replenish_quantity>0))throw fail('请先提交FBP备货申请，或核对FBP官方可用库存低于安全目标且尚未被在途、已确认备货覆盖的缺口；草稿不产生采购需求');
        }
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
  return{read,requests,skuDetails,localQuantities,batch,workspaceStates,workspaceSnapshot,workspaceSources,workspaceProducts,workspaceBatches,workspaceFeedback,submit,receipts,receive};
}

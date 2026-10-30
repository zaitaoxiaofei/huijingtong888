import {procurementDemandDetails} from '../../services/procurement-demand-details.js';
import {procurementArrivals} from '../../services/procurement-arrivals.js';
import {procurementDemandRequest} from '../../services/procurement-demand-request.js';
import { createFbpSupplyFeedback } from '../../services/fbp-supply-feedback.js';
import { inventorySupplyFeedback } from '../../services/inventory-supply-feedback.js';
import { inventoryWorkspacePage } from '../../shared/inventory-workspace.js';
import { createInventoryNodeRecords } from '../../services/inventory-node-records.js';
import { createInventoryWorkflowService } from '../../services/inventory-workflow.js';
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from '../../services/business-task-tenant.js';
import { createWarehouseStockTopup } from '../../services/warehouse-stock-topup.js';
import { hasPermission, isPlatformAdmin, isEnterpriseAdmin } from "../../shared/permissions.js";
import { tenantIdFromRequest } from "./sellerAnalytics.js";
import { currentPricingReferenceRate } from "../../services/pricing-reference-rate.js";
import { latestRfbsTariff, latestRfbsMarketplace, searchRfbsCategories, rfbsCategory } from "../../services/ozon-rfbs-tariff.js";
import { businessLogisticsRules, sharedPricingLogisticsRules } from "../../services/pricing-logistics-rules.js";
import { runCustomerMessageTenantOperation } from "../../services/customer-message-tenant-scope.js";
import { unclassifiedCancellationReasons, saveCancellationReasonClassification } from "../../services/order-cancellation-review.js";
async function queryCancellationReviewMysql(sql, params) { const { mysqlQuery } = await import("../../mysql-pool.js"); return mysqlQuery(sql, params); }
async function cancellationReviewMysqlTransaction(operation) { const { withMysqlTransaction } = await import("../../mysql-pool.js"); return withMysqlTransaction(operation); }

function platformLogisticsScope(req, body = null, url = null) {
  if (!isPlatformAdmin(req?._session)) {
    throw Object.assign(new Error("仅平台超级管理员可以管理共用物流规则"), { statusCode: 403 });
  }
  const selectors = ["tenant_id", "tenantId"];
  const searchParams = url?.searchParams || new URL(req?.url || "/", "http://localhost").searchParams;
  if (selectors.some(key => searchParams.has(key) || Object.hasOwn(req?.query || {}, key) || Object.hasOwn(body || {}, key))) {
    throw Object.assign(new Error("共用物流规则使用固定的平台配置范围，请移除企业选择参数（tenant_id / tenantId）"), { statusCode: 400 });
  }
  return "admin";
}

function platformLogisticsRule(row) {
  const { tenant_id, tenantId, ...rule } = row;
  return rule;
}

export function createOperationsRoutes({ services, readJson, readBusinessLogisticsRules = businessLogisticsRules,
  readUnclassifiedCancellationReasons = unclassifiedCancellationReasons, saveCancellationClassification = saveCancellationReasonClassification,
  queryCancellationReview = queryCancellationReviewMysql, cancellationReviewTransaction = cancellationReviewMysqlTransaction }) {
  const customer = handler => (req, ...args) => runCustomerMessageTenantOperation(req._session, () => handler(req, ...args));
  const nodeRecords=createInventoryNodeRecords({ledger:services.procurementLedger,confirmTransfer:services.confirmFbpTransferReceived});
  const workflow = createInventoryWorkflowService({ ledger: services.procurementLedger, receiveRecords: services.batchUpdateInboundRecords, previewReceipts: services.previewInboundReceiptImpact });
  return {
    "GET /api/tools/pricing/reference-rate": () => currentPricingReferenceRate(),
    "GET /api/tools/pricing/rfbs-categories": async (req, url) => searchRfbsCategories(await latestRfbsTariff(), url.searchParams.get("keyword"), url.searchParams.get("limit")),
    "GET /api/tools/pricing/rfbs-category": async (req, url) => rfbsCategory(await latestRfbsTariff(), url.searchParams.get("id")),
    "GET /api/tools/pricing/rfbs-marketplace": () => latestRfbsMarketplace(),
    "GET /api/tools/pricing/logistics-rules": () => sharedPricingLogisticsRules(),
    "GET /api/settings/packaging-fee-rule": () => services.packagingFeeRule(),
    "GET /api/settings/packaging-fee-rule/changes": (req, url) => services.packagingFeeRuleChanges(url?.searchParams?.get("limit") || 20),
    "GET /api/logistics-rules": async (req, url) => {
      if (isPlatformAdmin(req?._session)) return (await services.logisticsRules(platformLogisticsScope(req, null, url))).map(platformLogisticsRule);
      tenantIdFromRequest(req);
      return readBusinessLogisticsRules();
    },
    "GET /api/order-cancellation-rules": () => services.orderCancellationRules(),
    "GET /api/order-cancellation-rules/unclassified": (req) => readUnclassifiedCancellationReasons(queryCancellationReview, req.query || {}, req._session),
    "POST /api/order-cancellation-rules/classifications": async (req) => saveCancellationClassification(cancellationReviewTransaction, await readJson(req), req._session),
    "GET /api/inbound-records": (req, url) => services.inboundRecords(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/outbound-records": (req, url) => services.outboundRecords(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/fbp-transfer-records": (req, url) => services.fbpTransferRecords(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/inventory/manual-outbound-records": (req, url) => services.inventoryManualOutboundRecords(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/summary": (req) => services.procurementSummary({}, tenantIdFromRequest(req)),
    "GET /api/procurement/daily-report": (req, url) => services.procurementDailyReport(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/requests": (req, url) => services.procurementRequests(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/inventory-workflow/demand-details":(req,url)=>procurementDemandDetails.details(url.searchParams.get('product_id'),req._session),
    "POST /api/inventory-workflow/local-safety":async req=>procurementDemandDetails.safety(await readJson(req),req._session),
    "GET /api/inventory-workflow/purchase-arrivals":(req,url)=>procurementArrivals.list(Object.fromEntries(url.searchParams),req._session),
    "POST /api/inventory-workflow/purchase-arrivals":async req=>procurementArrivals.confirm(await readJson(req),req._session),
    "POST /api/inventory-workflow/demand-request":async req=>procurementDemandRequest(await readJson(req),req._session),
    "GET /api/inventory-workflow/alerts": async (req,url)=>{
      const session=await authorizeBusinessTaskSession(req._session);assertBusinessTaskPermission(session,'inventory.read');
      const params=Object.fromEntries(url.searchParams);
      const base=params.view==='workspace'?await workflow.workspaceProducts(params,session.tenant.id):await services.stockAlerts({...params,mode:'inventory-alerts',paged:'0',alertType:'all'},session.tenant.id);
      const raw=Array.isArray(base)?base:base.rows||[];
      const ids=[...new Set(raw.map(r=>Number(r.product_id)).filter(id=>id>0))];
      const cached=params.view==='workspace'?await workflow.workspaceSnapshot(session.tenant.id,{fresh:params.refresh==='1',productIds:ids}):null;
      const states=cached?.rows||[];
      if(params.view!=='workspace')for(let i=0;i<ids.length;i+=40)states.push(...await workflow.batch(ids.slice(i,i+40),session.tenant.id,{fresh:params.refresh==='1'}));
      const byId=new Map(states.map(state=>[state.product_id,state]));
      const all=(cached&&!cached.snapshot.available?[]:raw).map(row=>{const state=byId.get(Number(row.product_id));return{...row,workflow:state,physical_stock:state?.physical,available_stock:state?.free,open_order_demand_qty:state?.order_demand,suggested_purchase_qty:state?.purchase_quantity};});
      if(params.view==='workspace'){
        const result=inventoryWorkspacePage(all,params);
        const pageIds=result.rows.map(r=>Number(r.product_id));
        const [batches,feedbacks,sources]=await Promise.all([workflow.workspaceBatches(pageIds,session.tenant.id),workflow.workspaceFeedback(pageIds,session.tenant.id),workflow.workspaceSources(pageIds,session.tenant.id)]);
        const byProduct=new Map();for(const batch of batches){const id=Number(batch.product_id);if(!byProduct.has(id))byProduct.set(id,[]);byProduct.get(id).push(batch);}
        return{...result,...(!cached.snapshot.available?{total:null,meta:Object.fromEntries(Object.keys(result.meta).map(k=>[k,null]))}:{}),snapshot:cached.snapshot,rows:result.rows.map(row=>({...row,workflow:{...row.workflow,requests:sources.requests.filter(r=>Number(r.product_id)===Number(row.product_id)),applications:sources.applications.filter(r=>Number(r.product_id)===Number(row.product_id))},pending_batches:byProduct.get(Number(row.product_id))||[],feedbacks:feedbacks.filter(f=>Number(f.product_id)===Number(row.product_id)).slice(0,5)}))};
      }
      const status=params.alertType||'all',rows=all.filter(row=>status==='all'||row.workflow?.overall===status);
      const sortKey=['recent_7d_qty','recent_15d_qty','recent_30d_qty'].includes(params.sortBy)?params.sortBy:'recent_30d_qty';
      const rank={danger:0,warning:1,unknown:2,opportunity:3,success:4};rows.sort((a,b)=>(rank[a.workflow?.overall]??2)-(rank[b.workflow?.overall]??2)||Number(b[sortKey])-Number(a[sortKey]));
      const page=Math.max(1,Number(params.page)||1),pageSize=Math.min(100,Math.max(1,Number(params.pageSize)||20));
      return{rows:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,meta:Object.fromEntries(['danger','warning','unknown','opportunity','success'].map(status=>[status,all.filter(row=>row.workflow?.overall===status).length]))};
    },
    "GET /api/inventory-workflow": async (req, url) => {
      const session=await authorizeBusinessTaskSession(req._session);
      assertBusinessTaskPermission(session,'inventory.read');
      const ids=[...new Set(String(url.searchParams.get('product_ids') || url.searchParams.get('product_id') || '').split(',').map(Number))];
      if(!ids.length || ids.length>20 || ids.some(id=>!Number.isSafeInteger(id)||id<=0)) throw Object.assign(new Error('请选择1至20个库存商品'),{statusCode:400});
      if(url.searchParams.get('view')==='local')return {rows:await workflow.localQuantities(ids,session.tenant.id)};
      if(url.searchParams.get('view')==='sku'){if(ids.length!==1)throw Object.assign(new Error('请选择一个库存商品查看SKU组成'),{statusCode:400});return workflow.skuDetails(ids[0],url.searchParams.get('shop_id'),url.searchParams.get('ozon_sku'),session.tenant.id);}
      if(url.searchParams.get('view')==='requests')return {rows:await Promise.all(ids.map(id=>workflow.requests(id,session.tenant.id)))};
      if(url.searchParams.get('view')==='status')return {rows:await workflow.batch(ids,session.tenant.id,{fresh:url.searchParams.get('fresh')==='1'})};
      const rows=[];
      for(let i=0;i<ids.length;i+=2) rows.push(...await Promise.all(ids.slice(i,i+2).map(id=>workflow.read(id,session.tenant.id,{fresh:url.searchParams.get('fresh')==='1'}))));
      return { rows };
    },
    "GET /api/inventory-workflow/details": (req,url)=>nodeRecords.records(Object.fromEntries(url.searchParams),req._session),
    "POST /api/inventory-workflow/node-action": async req=>nodeRecords.mutate(await readJson(req),req._session),
    "GET /api/inventory-workflow/receipts": async (req,url)=>({rows:await workflow.receipts(url.searchParams.get('product_id'),req._session)}),
    "POST /api/inventory-workflow/receipts": async req=>workflow.receive(await readJson(req),req._session),
    "POST /api/inventory-workflow/fbp": async req => {
      const session=await authorizeBusinessTaskSession(req._session);
      assertBusinessTaskPermission(session,'inventory.write');
      const body=await readJson(req);
      const productId=Number(body.product_id);
      const state=await workflow.read(productId,session.tenant.id,{fresh:true});
      const selected=Array.isArray(body.rows)?body.rows:[];
      if(!selected.length || selected.length>100) throw Object.assign(new Error('请选择1至100个已绑定的SKU'),{statusCode:400});
      const seen=new Set();
      const rows=selected.map(row=>{
        const key=`${Number(row.shop_id)}:${String(row.ozon_sku)}`;
        const sku=state.skus.find(s=>s.shop_id===Number(row.shop_id)&&s.ozon_sku===String(row.ozon_sku));
        if(!sku?.mapping_id || seen.has(key) || !Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity)<1 || Number(row.quantity)>1000000) throw Object.assign(new Error('SKU绑定或件数无效，请先核对绑定；一个SKU只能提交一次'),{statusCode:400});
        seen.add(key); return {...sku,requested_qty:Number(row.quantity)};
      });
      const feedback=createFbpSupplyFeedback(session);
      const result=await services.createFbpReplenishmentOrders({rows,note:String(body.note||'').slice(0,500)},session.personId,session.tenant.id,{workflow:true,submit:body.submit===true,afterSubmit:connection=>feedback.afterSubmit(connection,rows)});
      return{...result,feedback:feedback.committed()};
    },
    "POST /api/inventory-workflow/feedback": async req=>{const body=await readJson(req);return inventorySupplyFeedback(body,req._session,{automatic:body.automatic===true});},
    "POST /api/inventory-workflow/requests": async req => workflow.submit(await readJson(req),req._session),
    "GET /api/procurement/ledger": (req, url) => services.procurementLedger(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/inventory/ledger": (req, url) => services.inventoryLedger(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/stock-cost-tasks": (req, url) => services.procurementStockCostTasks(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "POST /api/procurement/ledger/preview": async (req) => services.previewProcurementLedger(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/inventory/ledger/preview": async (req) => services.previewInventoryStocktake(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/inventory/ledger": async (req) => {
      if (!hasPermission(req._session, 'inventory.write')) throw Object.assign(new Error('更新库存需要库存管理权限（inventory.write），请联系管理员授权后重试'), { statusCode: 403 });
      return services.applyInventoryStocktake(await readJson(req), req._session?.personId, tenantIdFromRequest(req));
    },
    "POST /api/inventory/products/lead-times": async (req) => services.updateInventoryProductLeadTimes(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/procurement/ledger": async (req) => {
      const body = await readJson(req);
      if (['convert', 'substitute', 'damage', 'loss', 'stocktake', 'set_priority'].includes(body.action_type) && !hasPermission(req._session, 'inventory.write')) {
        throw Object.assign(new Error('库存替代、转换、盘点及现货优先分配需要库存管理权限（inventory.write），请联系管理员授权后重试'), { status: 403 });
      }
      return services.applyProcurementLedger(body, req._session?.personId, tenantIdFromRequest(req));
    },
    "GET /api/procurement/order-history": (req, url) => services.procurementProductOrderHistory(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/purchase-history": (req, url) => services.procurementProductPurchaseHistory(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/binding-suggestions": (req, url) => services.procurementBindingSuggestions(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/platform-orders": (req, url) => services.procurementPlatformOrders(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/reconciliation": (req, url) => services.procurementReconciliation(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/purchase-orders": (req, url) => services.purchaseOrders(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/purchase-group-recommendations": (req, url) => services.procurementPurchaseGroupRecommendations(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/cost-versions": (req, url) => services.purchaseCostVersions(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/procurement/cost-versions/backfill-preview": (req) => services.previewPurchaseCostBackfill(tenantIdFromRequest(req)),
    "GET /api/procurement/pending-inbound": (req) => services.pendingInboundItems({}, tenantIdFromRequest(req)),
    "GET /api/customer-messages": customer((req, url) => services.customerMessages(Object.fromEntries(url.searchParams.entries()))),
    "GET /api/customer-chats": customer((req, url) => services.customerChatThreads(Object.fromEntries(url.searchParams.entries()))),
    "GET /api/customer-chats/messages": customer((req, url) => services.customerChatThreadMessages(Object.fromEntries(url.searchParams.entries()))),
    "GET /api/customer-message-customer-orders": customer((req, url) => services.customerMessageCustomerOrders(Object.fromEntries(url.searchParams.entries()))),
    "GET /api/customer-message-settings": customer(() => services.customerMessageSettings()),
    "GET /api/user-preferences": (req, url) => services.userPreference(Object.fromEntries(url.searchParams.entries()), req._session?.personId),
    "GET /api/shops": async (req) => {
      const shops = await services.shops(tenantIdFromRequest(req));
      if (isPlatformAdmin(req._session) || isEnterpriseAdmin(req._session)) return shops;
      return shops.map(({ id, name, status, platform, currency_code, watermark_path, watermark_name,
        watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent }) => ({
        id, name, status, platform, currency_code,
        watermark_path: watermark_path ? `/api/tools/image-cropper/shop-watermark/${id}/file` : '',
        watermark_name, watermark_position, watermark_x_percent, watermark_y_percent, watermark_scale_percent, watermark_opacity_percent
      }));
    },
    "GET /api/people": (req) => services.people(tenantIdFromRequest(req)),
    "POST /api/people": async (req) => services.createPerson(await readJson(req)) || { ok: true },
    "POST /api/shops": async (req) => services.createShop(await readJson(req), tenantIdFromRequest(req)) || { ok: true },
    "POST /api/procurement/requests": async (req) => services.createProcurementRequest(await readJson(req), req._session?.personId, tenantIdFromRequest(req)) || { ok: true },
    "POST /api/procurement/stock-topups": async req => createWarehouseStockTopup(await readJson(req), req._session),
    "POST /api/procurement/warehouse-requests": async (req) => services.createWarehouseProcurementRequests(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/procurement/purchases": async (req) => services.recordProcurementPurchase(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/procurement/pdd-logistics/sync": async (req) => services.syncPddProcurementLogistics(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/procurement/pdd-logistics/sync-batch": async (req) => services.syncPddProcurementLogisticsBatch(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/procurement/platform-orders/import": async (req) => services.importProcurementPlatformOrders(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/procurement/payments/import": async (req) => services.importProcurementPayments(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/procurement/reconciliation/auto-match": async (req) => services.autoMatchProcurementPayments(tenantIdFromRequest(req)),
    "POST /api/procurement/reconciliation/apply-costs": async (req) => services.applyProcurementActualCosts(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/procurement/purchase-orders/confirm-from-requests-async": async (req) => services.startConfirmProcurementRequestsPurchased(await readJson(req), req._session?.personId, tenantIdFromRequest(req), req._session),
    "POST /api/procurement/purchase-orders/confirm-from-requests": async (req) => services.confirmProcurementRequestsPurchased(await readJson(req), req._session?.personId, tenantIdFromRequest(req), null, {session:req._session}),
    "POST /api/procurement/refresh-demand": (req) => services.refreshProcurementDemand(tenantIdFromRequest(req), { session: req._session, signal: req._abortSignal }),
    "POST /api/procurement/purchase-orders": async (req) => services.mergeProcurementRequests(await readJson(req), req._session?.personId, null, tenantIdFromRequest(req)),
    "POST /api/procurement/cost-versions/backfill": async (req) => services.initializePurchaseCostBackfill(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/inbound-records": async (req) => services.createInboundRecord(await readJson(req), tenantIdFromRequest(req)) || { ok: true },
    "POST /api/fbp-transfer-records": async (req) => services.createFbpTransferRecord(await readJson(req), req._session?.personId, tenantIdFromRequest(req)) || { ok: true },
    "POST /api/inbound-records/batch-update-async": async (req) => services.startBatchUpdateInboundRecords(await readJson(req), req._session?.personId, tenantIdFromRequest(req), req._session),
    "POST /api/inbound-records/shipped-receipts/preview": async (req) => services.previewShippedProcurementReceipts(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/inbound-records/shipped-receipts/confirm": async (req) => services.confirmShippedProcurementReceipts(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/inbound-records/receipt-impact-preview": async (req) => services.previewInboundReceiptImpact(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/inbound-records/batch-update": async (req) => services.batchUpdateInboundRecords(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/inventory/movements": async (req) => {
      const body = await readJson(req);
      if (!hasPermission(req._session, "inventory.write") && !(hasPermission(req._session, "packing") && String(body.source_type || body.sourceType || "").trim() === "manual_outbound")) {
        const error = new Error("打包角色仅可登记手动出库；调整其他库存流水需要库存管理权限");
        error.status = 403;
        throw error;
      }
      return services.createInventoryMovement(body, req._session?.personId, tenantIdFromRequest(req)) || { ok: true };
    },
    "GET /api/inventory/stock-debts": (req, url) => services.inventoryStockDebts(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "POST /api/inventory/stock-debts/adjust": async (req) => services.adjustInventoryStockDebt(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/customer-messages/preview": customer(async (req) => services.previewCustomerMessage(await readJson(req))),
    "POST /api/customer-message-settings/template/test": customer(async (req) => services.testCustomerMessageTemplate(await readJson(req))),
    "POST /api/customer-messages/record": customer(async (req) => services.recordCustomerMessage(await readJson(req))),
    "POST /api/customer-messages/send": customer(async (req) => services.sendCustomerMessage(await readJson(req))),
    "POST /api/customer-messages/manual-test-send": customer(async (req) => services.sendCustomerMessageManualTest(await readJson(req))),
    "POST /api/customer-messages/retry": customer(async (req) => services.retryCustomerMessageTask(await readJson(req))),
    "POST /api/customer-messages/translate-ru": customer(async (req) => services.translateCustomerMessageRu(await readJson(req))),
    "POST /api/customer-chats/sync": customer(async (req) => services.syncCustomerChats(await readJson(req))),
    "POST /api/customer-message-settings/shop/check-capability": customer(async (req) => services.checkCustomerMessageShopCapability(await readJson(req))),
    "POST /api/customer-message-settings/shop": customer(async (req) => services.updateCustomerMessageShopSetting(await readJson(req))),
    "POST /api/customer-message-settings/template": customer(async (req) => services.updateCustomerMessageTemplate(await readJson(req))),
    "POST /api/customer-message-settings/template/translate-zh": customer(async (req) => services.translateCustomerMessageTemplateZh(await readJson(req))),
    "POST /api/user-preferences": async (req) => services.updateUserPreference(await readJson(req), req._session?.personId),
    "POST /api/logistics-rules": async (req, url) => {
      platformLogisticsScope(req, null, url);
      const body = await readJson(req);
      return services.createLogisticsRule(body, platformLogisticsScope(req, body, url));
    },
    "POST /api/order-cancellation-rules": async (req) => services.createOrderCancellationRule(await readJson(req)),
    "POST /api/order-cancellation-rules/test": async (req) => services.testOrderCancellationRule(await readJson(req)),
    "POST /api/settings/packaging-fee-rule": async (req) => services.updatePackagingFeeRule(await readJson(req), req._session?.personId),
    "POST /api/stock-warehouse-rules": async (req) => services.createStockWarehouseRule(await readJson(req))
  };
}

export async function handleOperationsRestRoute({ req, res, url, parts, services, readJson, json, notFound }) {
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inventory" && parts[2] === "manual-outbound-records" && /^\d+$/.test(parts[3] || "")) {
    return json(res, await services.updateInventoryMovement(Number(parts[3]), await readJson(req), req._session?.personId, tenantIdFromRequest(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inventory" && parts[2] === "manual-outbound-records" && /^\d+$/.test(parts[3] || "")) {
    return json(res, await services.deleteInventoryMovement(Number(parts[3]), req._session?.personId, tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "reconciliation" && parts[3] && parts[4] === "confirm") {
    return json(res, await services.confirmProcurementPaymentMatch(Number(parts[3]), await readJson(req), req._session?.personId, tenantIdFromRequest(req)));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "reconciliation" && parts[3] && parts[4] === "payment-candidates") {
    return json(res, await services.procurementPaymentCandidates(Number(parts[3]), tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "reconciliation" && parts[3] && parts[4] === "payment-match") {
    return json(res, await services.setProcurementPaymentMatch(Number(parts[3]), await readJson(req), req._session?.personId, tenantIdFromRequest(req)));
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "platform-orders" && parts[3] && parts[4] === "candidates") {
    return json(res, await services.procurementPlatformOrderCandidates(Number(parts[3]), tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "platform-orders" && parts[3] && parts[4] === "link") {
    return json(res, await services.linkProcurementPlatformOrder(Number(parts[3]), await readJson(req), req._session?.personId, tenantIdFromRequest(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "customer-message-settings" && parts[2] === "template" && parts[3]) {
    return json(res, await runCustomerMessageTenantOperation(req._session, () => services.deleteCustomerMessageTemplate(decodeURIComponent(parts[3]))));
  }
  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-quality-rules") {
    return json(res, await services.saveOrderQualityRules(await readJson(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, await services.updateOrderCancellationRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "order-cancellation-rules" && parts[2]) {
    return json(res, await services.deleteOrderCancellationRule(Number(parts[2])));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    await services.updatePerson(Number(parts[2]), await readJson(req));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inventory" && parts[2] === "movements" && parts[3]) {
    return json(res, await services.updateInventoryMovement(Number(parts[3]), await readJson(req), req._session?.personId, tenantIdFromRequest(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inventory" && parts[2] === "movements" && parts[3]) {
    return json(res, await services.deleteInventoryMovement(Number(parts[3]), req._session?.personId, tenantIdFromRequest(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "people" && parts[2]) {
    if (url.searchParams.get("hard") === "1") await services.hardDeletePerson(Number(parts[2]));
    else await services.deletePerson(Number(parts[2]));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    await services.updateShop(Number(parts[2]), await readJson(req), tenantIdFromRequest(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "shops" && parts[2]) {
    await services.deleteShop(Number(parts[2]), tenantIdFromRequest(req));
    return json(res, { ok: true });
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    await services.updateProcurementRequest(Number(parts[3]), await readJson(req), tenantIdFromRequest(req));
    return json(res, { ok: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3] === "submit") {
    return json(res, await services.submitProcurementRequests(await readJson(req), tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3] === "direct-inbound") {
    return json(res, await services.directInboundProcurementRequests(await readJson(req), tenantIdFromRequest(req), req._session?.personId));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "requests" && parts[3]) {
    return json(res, await services.deleteProcurementRequest(Number(parts[3]), tenantIdFromRequest(req)));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    const detail = await services.purchaseOrderDetail(Number(parts[3]), tenantIdFromRequest(req));
    return detail ? json(res, detail) : notFound(res);
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "confirm-purchased") {
    return json(res, await services.confirmPurchaseOrder(Number(parts[3]), await readJson(req), req._session?.personId, null, tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "shipments" && parts[3] && parts[4] === "refresh") {
    return json(res, await services.refreshPurchaseOrderShipment(Number(parts[3]), tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "cost-versions" && parts[3] && parts[4] === "review") {
    return json(res, await services.reviewPurchaseCostVersion(Number(parts[3]), await readJson(req), req._session?.personId, tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3] && parts[4] === "cancel") {
    return json(res, await services.cancelPurchaseOrder(Number(parts[3]), tenantIdFromRequest(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    await services.updatePurchaseOrder(Number(parts[3]), await readJson(req), tenantIdFromRequest(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "procurement" && parts[2] === "purchase-orders" && parts[3]) {
    return json(res, await services.deletePurchaseOrder(Number(parts[3]), tenantIdFromRequest(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    await services.updateInboundRecord(Number(parts[2]), await readJson(req), req._session?.personId, tenantIdFromRequest(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "inbound-records" && parts[2]) {
    return json(res, await services.deleteInboundRecord(Number(parts[2]), tenantIdFromRequest(req)));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    const query = Object.fromEntries(url.searchParams.entries());
    delete query.tenant_id;
    delete query.tenantId;
    return json(res, await services.suppliers(query, tenantIdFromRequest(req)));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "suppliers" && !parts[2]) {
    return json(res, await services.createSupplier(await readJson(req), tenantIdFromRequest(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    await services.updateSupplier(Number(parts[2]), await readJson(req), tenantIdFromRequest(req));
    return json(res, { ok: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "suppliers" && parts[2]) {
    return json(res, await services.deleteSupplier(Number(parts[2]), tenantIdFromRequest(req)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "logistics-rules" && parts.length === 3 && /^\d+$/.test(parts[2] || "")) {
    platformLogisticsScope(req, null, url);
    const body = await readJson(req);
    return json(res, await services.updateLogisticsRule(Number(parts[2]), body, platformLogisticsScope(req, body, url)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "logistics-rules" && parts.length === 3 && /^\d+$/.test(parts[2] || "")) {
    return json(res, await services.deleteLogisticsRule(Number(parts[2]), platformLogisticsScope(req, null, url)));
  }

  if (req.method === "PUT" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, await services.updateStockWarehouseRule(Number(parts[2]), await readJson(req)));
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "stock-warehouse-rules" && parts[2]) {
    return json(res, await services.deleteStockWarehouseRule(Number(parts[2])));
  }

  return false;
}

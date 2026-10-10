const TENANT_SCOPED_SAFE_PATHS = new Set([
  "user-preferences",
  "ready",
  "system/info",
  "system/update-status"
]);

const TENANT_SELLER_ANALYTICS_ROUTES = new Set([
  "GET db/seller-analytics/summary",
  "GET db/seller-analytics/metrics",
  "GET db/seller-analytics/analysis",
  "GET db/seller-analytics/operation-todos",
  "GET db/seller-analytics/plugin-status",
  "GET db/seller-analytics/auth-binding",
  "GET db/seller-analytics/browser-profile",
  "GET db/seller-analytics/plugin-status/validate",
  "GET db/seller-analytics/snapshots",
  "GET db/seller-analytics/collect-runs",
  "POST db/seller-analytics/plugin-prepare",
  "POST db/seller-analytics/collect-runs",
  "POST db/seller-analytics/direct-collect/start",
  "POST db/seller-analytics/browser-profile/prepare",
  "POST db/seller-analytics/browser-profile/confirm",
  "POST db/seller-analytics/operation-todos/refresh",
  "POST db/seller-analytics/snapshots/batch-delete"
]);

function isTenantSellerAnalyticsRoute(path, method) {
  if (TENANT_SELLER_ANALYTICS_ROUTES.has(`${method} ${path}`)
    || (method === "HEAD" && TENANT_SELLER_ANALYTICS_ROUTES.has(`GET ${path}`))) return true;
  if (method === "POST" && /^db\/seller-analytics\/collect-runs\/[^/]+\/retry$/.test(path)) return true;
  if (method === "DELETE" && /^db\/seller-analytics\/(?:collect-runs|snapshots)\/[^/]+$/.test(path)) return true;
  return false;
}

/**
 * Business APIs are migrated incrementally. Until a route is tenant-aware,
 * non-default tenants must not access the legacy shared business dataset.
 */
export function tenantIsolationDecision(session, parts = [], method = "GET") {
  const tenant = session?.tenant;
  if (tenant?.slug === "default") return { allowed: true };
  if (!tenant?.id || !tenant?.slug) {
    return {
      allowed: false,
      error: "当前账号没有有效的企业上下文，请重新登录或联系管理员",
      code: "TENANT_CONTEXT_REQUIRED"
    };
  }

  const path = parts.slice(1).join("/");
  if (TENANT_SCOPED_SAFE_PATHS.has(path)) return { allowed: true };
  const verb = String(method || "GET").toUpperCase();
  if (isTenantSellerAnalyticsRoute(path, verb)) return { allowed: true };
  const tenantOzonAttributeRead = parts[1] === "listing" && parts.length === 3
    && ["ozon-category-attributes", "ozon-attribute-values"].includes(parts[2]) && verb === "GET";
  const tenantOzonAttributeSync = parts[1] === "listing" && parts.length === 4
    && ["ozon-category-attributes", "ozon-attribute-values"].includes(parts[2])
    && parts[3] === "sync" && verb === "POST";
  if (tenantOzonAttributeRead || tenantOzonAttributeSync) return { allowed: true };
  const tenantListingTemplateCollection = parts[1] === "listing" && parts[2] === "templates"
    && parts.length === 3 && ["GET", "POST"].includes(verb);
  const tenantListingTemplateRecord = parts[1] === "listing" && parts[2] === "templates"
    && parts.length === 4 && /^\d+$/.test(String(parts[3] || "")) && ["GET", "PUT"].includes(verb);
  if (tenantListingTemplateCollection || tenantListingTemplateRecord) return { allowed: true };
  const tenantListingDraftCollection = parts[1] === "listing" && parts[2] === "drafts"
    && parts.length === 3 && ["GET", "POST"].includes(verb);
  const tenantListingDraftRecord = parts[1] === "listing" && parts[2] === "drafts"
    && parts.length === 4 && /^\d+$/.test(String(parts[3] || "")) && ["GET", "PUT", "DELETE"].includes(verb);
  const tenantListingDraftDevelopmentMeta = parts[1] === "listing" && parts[2] === "drafts"
    && parts.length === 5 && /^\d+$/.test(String(parts[3] || "")) && parts[4] === "development-meta" && verb === "PUT";
  const tenantListingDraftShopCopies = parts[1] === "listing" && parts[2] === "drafts"
    && parts.length === 5 && /^\d+$/.test(String(parts[3] || "")) && parts[4] === "shop-copies" && ["GET", "POST"].includes(verb);
  if (tenantListingDraftCollection || tenantListingDraftRecord || tenantListingDraftDevelopmentMeta || tenantListingDraftShopCopies) return { allowed: true };
  if (parts[1] === "products" && parts.length === 2 && verb === "GET") return { allowed: true };
  if (parts[1] === "products" && parts.length === 2 && verb === "POST") return { allowed: true };
  if (parts[1] === "products" && parts.length === 3 && parts[2] === "selection" && verb === "GET") return { allowed: true };
  if (parts[1] === "products" && /^\d+$/.test(String(parts[2] || "")) && parts.length === 3 && verb === "PUT") return { allowed: true };
  if (parts[1] === "products" && /^\d+$/.test(String(parts[2] || "")) && parts.length === 3 && verb === "PUT") return { allowed: true };
  if (parts[1] === "products" && /^\d+$/.test(String(parts[2] || "")) && parts.length === 3 && verb === "GET") return { allowed: true };
  if (parts[1] === "products" && /^\d+$/.test(String(parts[2] || "")) && parts.length === 4 && parts[3] === "components" && verb === "PUT") return { allowed: true };
  if (parts[1] === "products" && parts[2] === "hidden" && parts.length === 3 && verb === "GET") return { allowed: true };
  const tenantProductImageRead = parts[1] === "products" && /^\d+$/.test(String(parts[2] || "")) && verb === "GET"
    && ((parts.length === 4 && parts[3] === "image")
      || (parts.length === 5 && parts[3] === "detail-images" && /^\d+$/.test(String(parts[4] || ""))));
  if (tenantProductImageRead) return { allowed: true };
  const tenantProductRestore = parts[1] === "products" && /^\d+$/.test(String(parts[2] || ""))
    && parts.length === 4 && parts[3] === "restore" && verb === "POST";
  if (tenantProductRestore) return { allowed: true };
  const tenantSupplierCollection = parts[1] === "suppliers" && parts.length === 2 && ["GET", "POST"].includes(verb);
  const tenantSupplierRecord = parts[1] === "suppliers" && parts.length === 3
    && /^\d+$/.test(String(parts[2] || "")) && ["PUT", "DELETE"].includes(verb);
  if (tenantSupplierCollection || tenantSupplierRecord) return { allowed: true };
  const tenantOrderDetailRead = parts[1] === "orders" && parts.length === 3
    && /^\d+$/.test(String(parts[2] || "")) && verb === "GET";
  if (tenantOrderDetailRead) return { allowed: true };
  const tenantOrderHistoryRead = parts[1] === "orders" && /^\d+$/.test(String(parts[2] || ""))
    && parts.length === 4 && parts[3] === "status-history" && verb === "GET";
  if (tenantOrderHistoryRead) return { allowed: true };
  const tenantOrderMarkWrite = parts[1] === "orders" && /^\d+$/.test(String(parts[2] || ""))
    && parts.length === 4 && parts[3] === "mark" && verb === "PUT";
  if (tenantOrderMarkWrite) return { allowed: true };
  const tenantOrderProcurementPreview = parts[1] === "orders" && /^\d+$/.test(String(parts[2] || ""))
    && parts.length === 4 && parts[3] === "procurement-preview" && verb === "GET";
  if (tenantOrderProcurementPreview) return { allowed: true };
  const tenantManualOutboundCollection = parts[1] === "inventory" && parts[2] === "manual-outbound-records"
    && parts.length === 3 && verb === "GET";
  const tenantManualOutboundRecord = parts[1] === "inventory" && parts[2] === "manual-outbound-records"
    && parts.length === 4 && /^\d+$/.test(String(parts[3] || "")) && ["PUT", "DELETE"].includes(verb);
  if (tenantManualOutboundCollection || tenantManualOutboundRecord) return { allowed: true };
  // The paged order list still uses global procurement coverage and several
  // unscoped enrichment queries. Keep it closed until that full read path is
  // tenant-aware; the numeric detail route above has its own scoped handler.
  if (parts[1] === "orders" && parts.length === 2 && verb === "GET") {
    return {
      allowed: false,
      error: "企业订单列表隔离改造尚未完成，请联系管理员",
      code: "TENANT_ISOLATION_PENDING"
    };
  }
  const tenantLogisticsRuleCollection = parts[1] === "logistics-rules" && parts.length === 2 && ["GET", "POST"].includes(verb);
  const tenantLogisticsRuleRecord = parts[1] === "logistics-rules" && parts.length === 3
    && /^\d+$/.test(String(parts[2] || "")) && ["PUT", "DELETE"].includes(verb);
  if (tenantLogisticsRuleCollection || tenantLogisticsRuleRecord) return { allowed: true };
  if (parts[1] === "online-products" && parts.length === 2 && verb === "GET") return { allowed: true };
  if (parts[1] === "fbp-replenishment-orders" && parts.length === 2 && verb === "GET") return { allowed: true };
  const tenantFbpDraftMutation = parts[1] === "fbp-replenishment-orders" && verb === "POST" && (
    (parts.length === 3 && ["delete", "items"].includes(parts[2]))
    || (parts.length === 3 && parts[2] === "status")
    || (parts.length === 4 && parts[2] === "items" && ["delete", "adjustments"].includes(parts[3]))
    || (parts.length === 5 && parts[2] === "items" && parts[3] === "adjustments" && parts[4] === "reason")
  );
  if (tenantFbpDraftMutation) return { allowed: true };
  const tenantFbpAdjustmentRead = parts[1] === "fbp-replenishment-orders" && parts.length === 4 && parts[2] === "items" && parts[3] === "adjustments" && verb === "GET";
  if (tenantFbpAdjustmentRead) return { allowed: true };
  const tenantFbpBatchLink = parts[1] === "fbp-replenishment-orders" && parts.length === 3 && parts[2] === "link" && verb === "POST";
  const tenantFbpBatchUnlink = parts[1] === "fbp-replenishment-orders" && parts.length === 3 && parts[2] === "unlink" && verb === "POST";
  const tenantFbpBatchPreview = parts[1] === "fbp-replenishment-batches" && parts.length === 3 && parts[2] === "fill-preview" && verb === "GET";
  if (tenantFbpBatchLink || tenantFbpBatchUnlink || tenantFbpBatchPreview) return { allowed: true };
  const tenantFbpBarcodePrint = parts[1] === "fbp-replenishment-orders" && parts.length === 4 && parts[2] === "items" && parts[3] === "barcode-printed" && verb === "POST";
  if (tenantFbpBarcodePrint) return { allowed: true };
  const tenantProcurementRequestCollection = parts[1] === "procurement" && parts[2] === "requests" && parts.length === 3 && ["GET", "POST"].includes(verb);
  const tenantProcurementRequestRecord = parts[1] === "procurement" && parts[2] === "requests" && parts.length === 4 && /^\d+$/.test(String(parts[3] || "")) && ["PUT", "DELETE"].includes(verb);
  if (tenantProcurementRequestCollection || tenantProcurementRequestRecord) return { allowed: true };
  const tenantCollectorBoxCollection = parts[1] === "listing" && parts[2] === "collector-box" && parts.length === 3 && ["GET", "DELETE"].includes(verb);
  const tenantCollectorBoxDetail = parts[1] === "listing" && parts[2] === "collector-box" && parts.length === 4 && verb === "GET";
  if (tenantCollectorBoxCollection || tenantCollectorBoxDetail) return { allowed: true };
  const tenantVariantWorkbenchCollection = parts[1] === "listing" && parts[2] === "variant-workbench-drafts" && parts.length === 3 && ["GET", "POST"].includes(verb);
  const tenantVariantWorkbenchDelete = parts[1] === "listing" && parts[2] === "variant-workbench-drafts" && parts.length === 4 && verb === "DELETE";
  if (tenantVariantWorkbenchCollection || tenantVariantWorkbenchDelete) return { allowed: true };
  const tenantSellerMediaJobs = parts[1] === "listing" && parts[2] === "media" && parts[3] === "ozon-upload-jobs" && parts.length === 4 && ["GET", "POST"].includes(verb);
  if (tenantSellerMediaJobs) return { allowed: true };
  const tenantFinanceRead = parts[1] === "finance-center" && parts.length === 3
    && ["companies", "report", "expenses", "vouchers", "platform-items", "export"].includes(parts[2]) && verb === "GET";
  const tenantFinanceWrite = parts[1] === "finance-center" && parts.length === 3
    && ["companies", "shop-assignments", "expenses", "vouchers", "close"].includes(parts[2]) && verb === "POST";
  const tenantFinanceExpenseDelete = parts[1] === "finance-center" && parts[2] === "expenses"
    && parts.length === 4 && /^\d+$/.test(String(parts[3] || "")) && verb === "DELETE";
  if (tenantFinanceRead || tenantFinanceWrite || tenantFinanceExpenseDelete) return { allowed: true };
  const tenantInventoryMovementCreate = parts[1] === "inventory" && parts[2] === "movements"
    && parts.length === 3 && verb === "POST";
  if (tenantInventoryMovementCreate) return { allowed: true };
  const tenantListingMediaAssetList = parts[1] === "listing" && parts[2] === "media" && parts[3] === "assets" && parts.length === 4 && verb === "GET";
  const tenantListingMediaUpload = parts[1] === "listing" && parts[2] === "media" && parts[3] === "upload" && parts.length === 4 && verb === "POST";
  if (tenantListingMediaAssetList || tenantListingMediaUpload) return { allowed: true };
  const tenantListingInventoryBindings = parts[1] === "listing" && parts[2] === "inventory-bindings" && parts.length === 3 && verb === "GET";
  const tenantListingInventoryBindingRetry = parts[1] === "listing" && parts[2] === "inventory-bindings" && parts.length === 4 && parts[3] === "retry" && verb === "POST";
  const tenantListingInventoryBindingWrite = parts[1] === "listing" && parts[2] === "inventory-bindings" && parts.length === 4 && parts[3] === "bind" && verb === "POST";
  if (tenantListingInventoryBindings || tenantListingInventoryBindingRetry || tenantListingInventoryBindingWrite) return { allowed: true };
  const tenantAiVariantAssetCollection = parts[1] === "listing" && parts[2] === "ai-variant-assets" && parts.length === 3 && ["GET", "POST"].includes(verb);
  const tenantAiVariantAssetBatchDelete = parts[1] === "listing" && parts[2] === "ai-variant-assets" && parts[3] === "batch-delete" && parts.length === 4 && verb === "POST";
  if (tenantAiVariantAssetCollection || tenantAiVariantAssetBatchDelete) return { allowed: true };
  const tenantListingPublishRecordRead = parts[1] === "listing" && parts[2] === "publish-records"
    && (parts.length === 3 || (parts.length === 4 && /^\d+$/.test(String(parts[3] || ""))))
    && verb === "GET";
  const tenantListingPublishRecordDelete = parts[1] === "listing" && parts[2] === "publish-records"
    && parts.length === 4 && /^\d+$/.test(String(parts[3] || "")) && verb === "DELETE";
  const tenantListingPublishRecordBatchDelete = parts[1] === "listing" && parts[2] === "publish-records"
    && parts.length === 4 && parts[3] === "batch-delete" && verb === "POST";
  const tenantListingPublishRecordDraftSave = parts[1] === "listing" && parts[2] === "publish-records"
    && parts.length === 5 && /^\d+$/.test(String(parts[3] || "")) && parts[4] === "draft" && verb === "POST";
  if (tenantListingPublishRecordRead || tenantListingPublishRecordDelete || tenantListingPublishRecordBatchDelete || tenantListingPublishRecordDraftSave) return { allowed: true };
  const tenantListingDraftProjects = parts[1] === "listing" && parts[2] === "draft-projects" && parts.length === 3 && verb === "GET";
  if (tenantListingDraftProjects) return { allowed: true };
  const tenantListingPublishTaskRead = parts[1] === "listing" && parts[2] === "publish-tasks"
    && (parts.length === 3 || (parts.length === 4 && /^\d+$/.test(String(parts[3] || ""))))
    && verb === "GET";
  if (tenantListingPublishTaskRead) return { allowed: true };
  if (parts[1] === "sku-order-tracking" && parts.length === 2 && ["GET", "POST"].includes(verb)) return { allowed: true };
  const tenantOnlineProductRead = parts[1] === "online-products" && parts.length === 3 && ["limits", "warehouses"].includes(parts[2]) && verb === "GET";
  const tenantOnlineProductStockWrite = parts[1] === "online-products" && parts.length === 3 && parts[2] === "batch-stock" && verb === "POST";
  const tenantOnlineProductAction = parts[1] === "online-products" && parts.length === 3 && parts[2] === "action" && verb === "POST";
  if (tenantOnlineProductRead || tenantOnlineProductStockWrite || tenantOnlineProductAction) return { allowed: true };
  const shopCollection = parts[1] === "shops" && parts.length === 2 && ["GET", "POST"].includes(verb);
  const shopRecord = parts[1] === "shops" && parts.length === 3 && /^\d+$/.test(String(parts[2] || "")) && ["PUT", "DELETE"].includes(verb);
  if (shopCollection || shopRecord) return { allowed: true };
  if (parts[1] === "tenants" && parts[2] === "members" && parts.length === 3 && verb === "GET") return { allowed: true };
  return {
    allowed: false,
    error: "该企业的数据隔离尚未完成，此功能暂不可用；默认企业数据不会开放给新企业",
    code: "TENANT_ISOLATION_PENDING"
  };
}

export function isPrivateImageRead(req, parts = []) {
  if (!req || !["GET", "HEAD"].includes(String(req.method || "").toUpperCase())) return false;
  if (parts[1] === "products" && parts[2] && ["image", "detail-images"].includes(parts[3])) return true;
  if (parts[1] === "ai" && parts[2] === "file") return true;
  return parts[1] === "asset-variant-engine"
    && ["files", "tail-template-files"].includes(parts[2]);
}

export function readCookie(req, name) {
  const prefix = `${String(name || "")}=`;
  const cookie = String(req?.headers?.cookie || "")
    .split(";")
    .map(item => item.trim())
    .find(item => item.startsWith(prefix));
  if (!cookie) return "";
  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return cookie.slice(prefix.length);
  }
}

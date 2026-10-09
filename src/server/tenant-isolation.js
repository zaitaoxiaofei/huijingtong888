const TENANT_SCOPED_SAFE_PATHS = new Set([
  "user-preferences",
  "ready",
  "system/info",
  "system/update-status"
]);

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
  if (path.startsWith("db/seller-analytics/") && ["GET", "HEAD", "POST", "DELETE"].includes(String(method || "GET").toUpperCase())) {
    return { allowed: true };
  }
  const verb = String(method || "GET").toUpperCase();
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

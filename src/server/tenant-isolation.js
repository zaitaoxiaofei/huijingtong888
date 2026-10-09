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
  if (parts[1] === "sku-order-tracking" && parts.length === 2 && ["GET", "POST"].includes(verb)) return { allowed: true };
  const tenantOnlineProductRead = parts[1] === "online-products" && parts.length === 3 && ["limits", "warehouses"].includes(parts[2]) && verb === "GET";
  const tenantOnlineProductStockWrite = parts[1] === "online-products" && parts.length === 3 && parts[2] === "batch-stock" && verb === "POST";
  if (tenantOnlineProductRead || tenantOnlineProductStockWrite) return { allowed: true };
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

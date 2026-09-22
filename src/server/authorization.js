import { getRoles, hasPermission } from "../shared/permissions.js";

function deny(reason = "当前角色没有此操作权限，请联系管理员在人员设置中分配对应角色") {
  return { allowed: false, status: 403, error: reason };
}

export function authorizeApiRequest(req, parts = []) {
  const session = req._session;
  if (!session) return deny("未登录");
  if (parts[0] !== "api") return { allowed: true };
  if (hasPermission(session, "admin")) return { allowed: true };
  if (!getRoles(session).length) return deny();
  const method = String(req.method || "GET").toUpperCase();
  const read = ["GET", "HEAD"].includes(method);
  const resource = parts[1];
  const path = parts.slice(1).join("/");
  const require = (...permissions) => permissions.some(permission => hasPermission(session, permission)) ? { allowed: true } : deny();

  if (["auth", "user-preferences", "ready", "image-proxy"].includes(resource)) return { allowed: true };
  if (read && ["dashboard", "people", "shops", "exchange-rate", "exchange-rates", "logistics-rules", "stock-warehouse-rules", "order-cancellation-rules", "order-quality-rules"].includes(resource)) return { allowed: true };
  if (read && ["system/info", "system/update-status", "db/seller-analytics/plugin-status"].includes(path)) return { allowed: true };
  if (read && path === "settings/packaging-fee-rule") return require("inventory.read");
  if (["finance-center", "payroll", "profits", "monthly-billing-details", "monthly-billing-orders", "ozon-finance", "profit-reconciliation", "profit-snapshots", "pending-settlement-costs", "settings", "people", "shops", "exchange-rate", "exchange-rates", "logistics-rules", "stock-warehouse-rules", "order-cancellation-rules"].includes(resource)) return deny("仅管理员可以访问财务、人员授权或修改基础配置");
  if (["ai-provider/chat", "ai-provider/stream"].includes(path)) return require("operations", "technical");
  if (["ai-provider", "scheduled-jobs", "scheduled-job-runs", "scheduled-job-run-events", "system-monitoring", "system", "docs"].includes(resource)) return require("technical");
  if (resource === "onboarding") return read ? { allowed: true } : require("onboarding.edit");
  if (resource === "inventory-product-naming") return read ? require("inventory.read") : method === "POST" ? require("inventory.write") : require("inventory.review");
  // Applicant ownership and approval action checks are enforced inside the request service.
  if (resource === "inventory-product-requests") return require("inventory.write", "inventory.review");
  if (resource === "orders") {
    if (read) return require("orders.read");
    if (["ship", "package-label", "package-label-printed", "package-label-print-failed", "repair-outbound"].includes(parts[2])) return require("packing");
    if (parts[3] === "procurement-requests") return require("procurement");
    return require("orders.manage");
  }
  if (resource === "procurement" && method === "POST" && parts[2] === "warehouse-requests") return require("procurement.request.submit");
  if (resource === "print" || resource === "outbound-records") return require("packing");
  if (["procurement", "inbound-records"].includes(resource)) return require("procurement");
  if (resource === "suppliers") return read ? require("inventory.read") : require("procurement");
  if (resource === "inventory" && parts[2] === "movements") return require("packing", "inventory.write");
  if (["products", "mappings", "sku-inventory-recipes", "inventory", "stock-alerts"].includes(resource)) return require(read ? "inventory.read" : "inventory.write");
  if (resource.startsWith("fbp-")) return read ? require("inventory.read") : require("procurement");
  if (resource === "online-products") return read ? require("orders.read", "operations")
    : ["bind", "create-product"].includes(parts[2]) ? require("inventory.write") : require("operations");
  if (resource === "erp") return read ? require("orders.read", "inventory.read") : deny();
  if (["profit-ranking", "profit-aftersales", "order-profit-detail-snapshots", "pricing"].includes(resource)) return require("analytics", "inventory.write");
  if (["advertising", "order-car-heatmap", "sku-order-tracking", "db"].includes(resource)) return require("analytics");
  if (resource === "team") return require("team");
  if (resource === "exception-workbench") return read ? require("orders.read") : require("orders.manage", "procurement");
  if (path === "ai-variant-lab/vehicle-catalog" && read) return require("inventory.read", "operations");
  if (path === "listing/media/upload") return { allowed: true };
  if (["ai-prompt-templates", "ai-strategies", "ai-strategy-bundles", "ai-strategy-category-nodes", "ai-strategy-layer-rules"].includes(resource)) return require("technical", "operations");
  if (["listing", "selection", "ai", "ai-generation", "ai-material-optimization", "ai-variant-draft-save", "ai-variant-lab", "asset-variant-engine", "material-assets", "material-packages", "tools", "ozon", "customer-chats", "customer-message-customer-orders", "customer-message-settings", "customer-messages", "reviews", "review-reply-templates"].includes(resource)) return require("operations");
  if (resource === "sync") {
    if (read) return require("orders.read", "technical");
    if (["ozon-stocks", "ozon-fbo-supplies"].includes(parts[2])) return require("procurement", "operations", "technical");
    if (String(parts[2] || "").includes("finance")) return deny("仅管理员可以同步财务数据");
    return require("orders.manage", "technical");
  }
  if (resource === "order-quality-rules") return require("orders.manage");
  return deny();
}

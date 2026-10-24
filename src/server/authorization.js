import { getRoles, hasPermission, isEnterpriseAdmin, isPlatformAdmin } from "../shared/permissions.js";
import { isEnterpriseMessageRoute } from "./enterprise-message-paths.js";
import { isOglDispatchRoute } from "./ogl-dispatch-paths.js";
import { isTenantPilotRoute } from "./tenant-pilot-routes.js";
import { isAiCreditReadRoute } from "./ai-credit-paths.js";

const PLATFORM_MANAGEMENT_RESOURCES = new Set([
  "platform", "exchange-rate", "exchange-rates", "logistics-rules", "stock-warehouse-rules",
  "order-cancellation-rules", "settings", "scheduled-jobs", "scheduled-job-runs", "scheduled-job-run-events",
  "system-monitoring", "system", "docs", "ai-provider", "ai-prompt-templates", "ai-strategies",
  "ai-strategy-bundles", "ai-strategy-category-nodes", "ai-strategy-layer-rules"
]);

function deny(reason = "当前角色没有此操作权限，请联系管理员在人员设置中分配对应角色") {
  return { allowed: false, status: 403, error: reason };
}

export function authorizeApiRequest(req, parts = []) {
  const session = req._session;
  if (!session) return deny("未登录");
  if (parts[0] !== "api") return { allowed: true };
  if (isEnterpriseMessageRoute(parts, String(req.method || "GET").toUpperCase())) return session.tenant?.id ? { allowed: true } : deny("请先选择有效企业后使用私信");
  if (isPlatformAdmin(session)) return { allowed: true };
  if (!getRoles(session).length && !isEnterpriseAdmin(session)) return deny();
  const method = String(req.method || "GET").toUpperCase();
  const read = ["GET", "HEAD"].includes(method);
  const resource = parts[1];
  if (resource === "ai-credits") return session.tenant?.id && isAiCreditReadRoute(parts, method) ? { allowed: true } : deny();
  const path = parts.slice(1).join("/");
  const require = (...permissions) => permissions.some(permission => hasPermission(session, permission)) ? { allowed: true } : deny();

  if (resource === "ogl-dispatch") {
    if (!session.tenant?.id || !session.tenant?.slug || !isOglDispatchRoute(parts, method)) return deny("请在有效企业中使用已开放的 OGL 发运操作");
    if (parts[2] === "settings") return isEnterpriseAdmin(session) ? { allowed: true } : deny("仅本企业负责人或管理员可以设置默认发运店铺");
    return read || parts[2] === "preview" ? require("orders.read", "packing") : require("packing", "orders.manage");
  }

  if (read && ["system/info", "system/update-status"].includes(path)) return { allowed: true };
  if (method === "GET" && path === "system/events" && session.tenant?.id && session.tenant?.slug) return { allowed: true };
  if (method === "GET" && ['settings/packaging-fee-rule', 'exchange-rate/current', 'exchange-rates', 'stock-warehouse-rules', 'order-cancellation-rules'].includes(path)) return require('inventory.read');
  if (method === "GET" && resource === "logistics-rules" && parts.length === 2 && session.tenant?.id && session.tenant?.slug) return { allowed: true };
  const businessAiConsumption = ["ai-provider/chat", "ai-provider/stream"].includes(path);
  if (PLATFORM_MANAGEMENT_RESOURCES.has(resource) && !businessAiConsumption) return deny("仅平台超级管理员可以管理共用规则、自动任务、系统监控、AI 配置及提示词库");
  if (resource === "enterprise") {
    const collection = parts.length === 3 && parts[2] === "people" && ["GET", "POST"].includes(method);
    const record = parts.length === 4 && parts[2] === "people" && /^\d+$/.test(String(parts[3] || "")) && method === "PUT";
    return (collection || record) && isEnterpriseAdmin(session) ? { allowed: true } : deny("仅本企业负责人或企业管理员可以管理企业人员");
  }
  if (resource === "people") return read ? { allowed: true } : deny("全局账号维护仅限平台超级管理员；企业人员请在企业店铺中管理");
  if (resource === "asset-variant-engine") {
    const configWrite = method === "POST" && parts.length === 3 && ["rules", "tail-templates"].includes(parts[2]);
    if (configWrite) return isEnterpriseAdmin(session) ? { allowed: true } : deny("仅本企业负责人或企业管理员可以修改店铺矩阵配置");
    const configRead = method === "GET" && ((parts.length === 3 && ["bootstrap", "tail-templates"].includes(parts[2]))
      || (parts.length === 4 && parts[2] === "tail-template-files" && /^\d+$/.test(String(parts[3] || ""))));
    if (configRead) return isEnterpriseAdmin(session) ? { allowed: true } : require("operations");
    if (session.tenant?.id && session.tenant?.slug && isTenantPilotRoute(path, method)) return require('operations');
    return deny("该矩阵操作尚未完成企业隔离验收或请求路径无效");
  }

  if (method === "GET" && [
    "tools/pricing/reference-rate",
    "tools/pricing/rfbs-marketplace",
    "tools/pricing/logistics-rules"
  ].includes(path)) return { allowed: true };

  if (["auth", "user-preferences", "system-notifications", "ready", "image-proxy"].includes(resource)) return { allowed: true };
  if (resource === "tenants") {
    if (parts[2] === "plugin-token" && ["owner", "admin"].includes(session.tenant?.role)) return { allowed: true };
    if (parts[2] === "members" && method === "GET" && (
      (session.tenant?.id && session.tenant?.slug !== "default")
      || (session.tenant?.slug === "default" && ["owner", "admin"].includes(session.tenant?.role))
    )) return { allowed: true };
    return deny("仅平台超级管理员可以管理平台企业授权");
  }
  // Ordinary staff need the scoped dictionary; its route projects safe fields.
  // Full authorization details and all writes remain enterprise administration.
  if (resource === "shops" && parts.length === 2 && method === "GET") return { allowed: true };
  if (resource === "shops" && ["owner", "admin"].includes(session.tenant?.role)) {
    const collection = parts.length === 2 && ["GET", "POST"].includes(method);
    const record = parts.length === 3 && /^\d+$/.test(String(parts[2] || "")) && ["PUT", "DELETE"].includes(method);
    if (collection || record) return { allowed: true };
  }
  if (resource === "finance-center" && isEnterpriseAdmin(session)) {
    const route = parts.slice(2);
    const companyRead = route.length === 1 && route[0] === "companies" && read;
    const reportRead = route.length === 1 && ["report", "expenses", "vouchers", "platform-items"].includes(route[0]) && read;
    const exportRead = route.length === 1 && route[0] === "export" && read;
    const collectionWrite = route.length === 1 && ["companies", "shop-assignments", "expenses", "vouchers", "voucher-attachments", "close"].includes(route[0]) && method === "POST";
    const expenseDelete = route.length === 2 && route[0] === "expenses" && /^\d+$/.test(String(route[1] || "")) && method === "DELETE";
    if (companyRead || reportRead || exportRead || collectionWrite || expenseDelete) return { allowed: true };
  }
  if (resource === "shops" && session.tenant?.slug !== "default") return deny("仅企业负责人或企业管理员可以管理店铺与店铺密钥");
  if (resource === "people" && session.tenant?.slug !== "default") return deny("企业人员管理尚未完成隔离，请使用企业与授权中的成员管理");
  if (resource === "online-products") {
    const collectionRead = parts.length === 2 && read;
    const scopedLookup = parts.length === 3 && ["limits", "warehouses"].includes(parts[2]) && read;
    const editDraft = parts.length === 4 && /^\d+$/.test(String(parts[2] || "")) && parts[3] === "edit-draft" && read;
    const inventoryWrite = parts.length === 3 && ["bind", "create-product"].includes(parts[2]) && method === "POST";
    const operationWrite = parts.length === 3 && ["batch-stock", "action"].includes(parts[2]) && method === "POST";
    if (collectionRead || scopedLookup) return require("orders.read", "operations");
    if (editDraft) return require("orders.read", "operations", "inventory.write");
    if (inventoryWrite) return require("inventory.write");
    if (operationWrite) return require("operations");
    return deny("该在线商品操作尚未完成企业隔离或验收");
  }
  if (path === "listing/drafts/from-inventory-product" && method === "POST") return require("inventory.write");
  if (path === "ai-variant-lab/vehicle-catalog") {
    if (read) return require("inventory.read", "operations", "team");
    if (method === "POST") return require("inventory.write", "operations");
    return deny();
  }
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
  if (resource === "inventory" && parts[2] === "manual-outbound-records") return read ? require("inventory.read") : require("packing", "inventory.write");
  if (resource === "inventory" && parts[2] === "movements") return require("packing", "inventory.write");
  if (path === "products/barcode-label" && method === "POST") return require("inventory.read");
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
    if (parts[2] === "online-products") {
      const start = parts.length === 3 && method === "POST";
      const status = parts.length === 4 && parts[3] === "status" && method === "GET";
      return start || status ? require("operations") : deny("该商品同步操作尚未开放");
    }
    if (read) return require("orders.read", "technical");
    if (["ozon-stocks", "ozon-fbo-supplies"].includes(parts[2])) return require("procurement", "operations", "technical");
    if (String(parts[2] || "").includes("finance")) return deny("仅管理员可以同步财务数据");
    return require("orders.manage", "technical");
  }
  if (resource === "order-quality-rules") return require("orders.manage");
  return deny();
}

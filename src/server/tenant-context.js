import { hasPermission } from "../shared/permissions.js";

export function tenantIdFromRequest(req) {
  const tenant = req?._session?.tenant;
  if (!tenant?.id || !tenant?.slug) {
    const error = new Error("当前登录会话没有有效企业上下文");
    error.statusCode = 403;
    throw error;
  }
  return tenant.slug === "default" ? "admin" : String(tenant.id);
}

export function pluginTokenTenantIdFromRequest(req, requestedTenantId) {
  const session = req?._session;
  if (hasPermission(session, "admin")) {
    const targetId = Number(requestedTenantId || session.tenant?.id || 0);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      const error = new Error("请选择有效企业后管理插件令牌");
      error.statusCode = 400;
      throw error;
    }
    return targetId;
  }
  tenantIdFromRequest(req);
  const currentTenantId = Number(session.tenant.id);
  if (requestedTenantId !== undefined && requestedTenantId !== null && requestedTenantId !== "" && Number(requestedTenantId) !== currentTenantId) {
    const error = new Error("插件令牌只能在当前企业管理，请先切换到目标企业后重试");
    error.statusCode = 403;
    throw error;
  }
  return currentTenantId;
}

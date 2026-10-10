export function tenantIdFromRequest(req) {
  const tenant = req?._session?.tenant;
  if (!tenant?.id || !tenant?.slug) {
    const error = new Error("当前登录会话没有有效企业上下文");
    error.statusCode = 403;
    throw error;
  }
  return tenant.slug === "default" ? "admin" : String(tenant.id);
}

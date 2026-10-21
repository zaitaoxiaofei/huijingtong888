function denied(message) {
  return Object.assign(new Error(message), { statusCode: 403 });
}

export function assetVariantTenantScope(session, { write = false } = {}) {
  const tenant = session?.tenant;
  const id = Number(tenant?.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !String(tenant?.slug || "").trim()) {
    throw denied("当前会话缺少有效企业上下文，请重新登录后管理店铺矩阵配置");
  }
  const isDefault = tenant.slug === "default";
  const administrator = session.platform_role === "super_admin" || ["owner", "admin"].includes(tenant.role);
  // Default-enterprise business consumers read these settings during publishing.
  // Configuration mutations must explicitly opt into the write check below.
  if ((write || !isDefault) && !administrator) {
    throw denied("仅企业负责人或企业管理员可以管理店铺矩阵配置");
  }
  return { id, slug: tenant.slug, isDefault };
}

export function assetVariantTenantPredicate(scope, alias) {
  return `(${alias}.tenant_id = ?${scope.isDefault ? ` OR ${alias}.tenant_id IS NULL` : ""})`;
}

export function assetVariantExecutionScope(session) {
  const scope = assetVariantTenantScope(session);
  if (!scope.isDefault) throw denied("企业素材生成与发布隔离尚未完成，当前仅开放店铺矩阵配置");
  return scope;
}

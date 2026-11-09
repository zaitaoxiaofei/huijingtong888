const DAY_MS = 86400000;
export const TENANT_DATA_RETENTION_DAYS = 30;
export function tenantDate(value) {
  if (!value) return null;
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const time = Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(raw) && !/(?:Z|[+-]\d\d:?\d\d)$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
  return Number.isFinite(time) ? time : null;
}
export function tenantLifecycle(tenant = {}, now = Date.now()) {
  const expires = tenantDate(tenant.subscription_expires_at);
  const starts = tenantDate(tenant.subscription_started_at);
  const cleanup = expires === null || tenant.slug === 'default' ? null : expires + TENANT_DATA_RETENTION_DAYS * DAY_MS;
  return {
    subscription_started_at: starts === null ? null : new Date(starts).toISOString(),
    remaining_days: expires === null ? null : Math.max(0, Math.ceil((expires - now) / DAY_MS)),
    expired_days: expires === null || expires > now ? 0 : Math.floor((now - expires) / DAY_MS),
    data_retention_days: TENANT_DATA_RETENTION_DAYS,
    data_delete_after: cleanup === null ? null : new Date(cleanup).toISOString(),
    retention_due: cleanup !== null && cleanup <= now,
    can_permanently_delete: tenant.slug !== 'default' && (tenant.status === 'archived' || tenant.subscription_status === 'suspended' || expires !== null && expires <= now)
  };
}

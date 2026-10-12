export function normalizeTenantQuotaLimit(value, defaultValue = null, label = "额度") {
  if (value === undefined) return defaultValue;
  if (value === null || value === "") return null;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000000) {
    const error = new Error(`${label}必须是 0 到 1000000 之间的整数；留空表示不限`);
    error.statusCode = 400;
    throw error;
  }
  return limit;
}

export function assertTenantQuotaAvailable({ label, current, limit }) {
  if (limit === null || limit === undefined || Number(current) < Number(limit)) return;
  const error = new Error(`企业${label}额度已达上限（${Number(current)}/${Number(limit)}），请移除未使用的${label}或联系平台管理员调整额度。`);
  error.statusCode = 409;
  throw error;
}

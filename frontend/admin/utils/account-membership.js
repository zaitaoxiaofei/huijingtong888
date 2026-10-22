const DAY_MS = 24 * 60 * 60 * 1000;

export function membershipDisplay(tenant, now = Date.now()) {
  const empty = { remainingDays: null, expiresAt: null, active: false };
  if (!tenant?.id && !tenant?.tenant_id) return { ...empty, label: "未加入企业", kind: "no-tenant" };
  const status = String(tenant.subscription_status || (tenant.tenant_id ? tenant.status : "") || "").toLowerCase();
  const rawExpiry = tenant.subscription_expires_at ?? tenant.expires_at;
  const expiryText = rawExpiry instanceof Date && Number.isFinite(rawExpiry.getTime()) ? rawExpiry.toISOString() : rawExpiry ? String(rawExpiry).trim() : "";
  const expiresAt = expiryText && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(expiryText)
    ? `${expiryText.replace(" ", "T")}Z` : expiryText || null;
  const expiryMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const remainingDays = Number.isFinite(expiryMs) ? Math.max(0, Math.ceil((expiryMs - now) / DAY_MS)) : null;
  const state = { ...empty, expiresAt: Number.isFinite(expiryMs) ? expiresAt : null, remainingDays };
  if (["suspended", "disabled", "archived"].includes(status) || ["suspended", "archived"].includes(tenant.status)) {
    return { ...state, label: "会员已停用", kind: "suspended" };
  }
  if (status === "expired" || (Number.isFinite(expiryMs) && expiryMs <= now)) {
    return { ...state, label: "会员已到期", kind: "expired" };
  }
  if (["pending", "inactive", "unactivated", "none"].includes(status) || tenant.access_allowed === false) {
    return { ...state, label: "待激活会员", kind: "unactivated" };
  }
  if (!["active", "trial"].includes(status) && tenant.access_allowed !== true) {
    return { ...state, label: "会员状态待确认", kind: "unavailable" };
  }
  if (rawExpiry && !Number.isFinite(expiryMs)) {
    return { ...state, label: "会员状态待确认", kind: "unavailable" };
  }
  const prefix = status === "trial" ? "试用" : "会员";
  return { ...state, active: true, kind: expiresAt ? "active" : "permanent", label: remainingDays === null ? `${prefix}已开通` : `${prefix}剩余 ${remainingDays} 天` };
}

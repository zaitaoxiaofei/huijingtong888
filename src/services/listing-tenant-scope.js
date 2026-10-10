export function listingTenantLookup(tenantKey = "admin") {
  const normalized = String(tenantKey || "admin").trim() || "admin";
  if (normalized === "admin") return { column: "slug", value: "default", key: "admin" };
  const id = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("发布记录的企业上下文无效，无法访问企业数据");
  }
  return { column: "id", value: id, key: String(id) };
}

export function isTenantScopedPluginRoute(method, parts = []) {
  const verb = String(method || "GET").toUpperCase();
  const route = parts.slice(2);
  if (route[0] === "plugin" && route[1] === "status" && verb === "GET") return true;
  if (route[0] === "collected-products") {
    return (route[1] === "sync" && verb === "POST")
      || (route[1] === "lookup" && verb === "GET")
      || (route[1] === "lookup-batch" && verb === "POST");
  }
  if (route[0] === "collected-product-details") {
    return (route.length === 1 && verb === "POST") || (route.length === 2 && verb === "GET");
  }
  if (route[0] === "server-publish" && route[1] === "media-upload-jobs") {
    return (route.length === 3 && route[2] === "claim" && verb === "POST")
      || (route.length === 4 && Boolean(route[2]) && route[2] !== "claim" && Boolean(route[3]) && verb === "POST");
  }
  if (route[0] === "collector-seller-pool") {
    return (route[1] === "status" && verb === "GET") || (route[1] === "collect" && verb === "POST");
  }
  if (route[0] === "seller-analytics") {
    return ["snapshots", "plugin-status", "plugin-prepare", "auth-bindings", "collect-runs"].includes(route[1])
      && ["GET", "POST"].includes(verb);
  }
  return false;
}

export function tenantPluginApiError(principal, method, parts = []) {
  if (principal?.tenantKey === "admin") return null;
  if (!principal?.tenantId || !principal?.tenantSlug) {
    return { status: 403, code: "TENANT_PLUGIN_AUTH_REQUIRED", error: "插件未绑定有效企业，请在企业管理中生成企业专属令牌" };
  }
  if (!isTenantScopedPluginRoute(method, parts)) {
    return { status: 403, code: "TENANT_PLUGIN_SCOPE_PENDING", error: "该插件功能尚未完成企业数据隔离，暂不可用于此企业" };
  }
  return null;
}

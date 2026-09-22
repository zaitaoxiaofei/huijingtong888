// Shared by server authorization and the admin UI. Multiple roles grant the union of permissions.
export const ROLE_DEFINITIONS = [
  { value: "admin", label: "管理员", description: "全部权限，包括财务、人员授权和系统配置" },
  { value: "manager", label: "经理", description: "业务管理、建品审批、标准名称维护" },
  { value: "packing", label: "打包", description: "订单查看、面单打印、打包发货和出库" },
  { value: "procurement", label: "采购", description: "采购、供应商、收货入库和库存建品" },
  { value: "operations", label: "运营", description: "采集选品、上架、客户消息和库存建品" },
  { value: "technical", label: "技术人员", description: "系统监控、自动任务和 AI 配置" },
  { value: "operator", label: "通用业务（兼容旧账号）", description: "保留原通用业务权限，不含审批、财务和系统管理；细分岗位不必同时勾选" }
];
const validRoles = new Set(ROLE_DEFINITIONS.map(role => role.value));
const business = ["orders.read", "orders.manage", "packing", "procurement", "procurement.request.submit", "inventory.read", "inventory.write", "operations", "analytics", "team"];
const rolePermissions = {
  admin: ["*"], manager: [...business, "inventory.review", "onboarding.edit"], operator: business,
  packing: ["orders.read", "packing", "procurement.request.submit", "inventory.read", "team"],
  procurement: ["orders.read", "procurement", "inventory.read", "inventory.write", "team"],
  operations: ["orders.read", "orders.manage", "operations", "analytics", "inventory.read", "inventory.write", "team"],
  technical: ["technical", "team"]
};

export function getRoles(subject) {
  let value = subject;
  if (subject && typeof subject === "object" && !Array.isArray(subject)) value = subject.roles ?? subject.roles_json ?? subject.role;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return [...new Set((Array.isArray(value) ? value : [value]).map(role => String(role || "").trim().toLowerCase()).filter(role => validRoles.has(role)))];
}

export function validateRoles(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("请至少选择一个人员角色（roles），在人员编辑窗口中勾选所需岗位");
  const normalized = value.map(role => String(role || "").trim().toLowerCase());
  if (normalized.some(role => !validRoles.has(role))) throw new Error("包含不支持的人员角色（roles），请重新选择角色");
  return [...new Set(normalized)];
}

export function primaryRole(subject) {
  const roles = getRoles(subject);
  return ["admin", "manager", "operator"].find(role => roles.includes(role)) || roles[0] || "";
}

export function hasPermission(subject, permission) {
  return getRoles(subject).some(role => rolePermissions[role].includes("*") || rolePermissions[role].includes(permission));
}

export function roleLabels(subject) {
  return getRoles(subject).map(role => ROLE_DEFINITIONS.find(item => item.value === role).label).join("、");
}

export function pagePermission(path = "") {
  if (["/dashboard", "/onboarding", "/login"].includes(path)) return "common";
  if (path === "/settings/system-monitoring" || path === "/settings/scheduled-jobs" || path === "/settings/ai" || path === "/settings/prompts") return "technical";
  if (path.startsWith("/settings") || path.startsWith("/asset-variant-center") || path.startsWith("/finance") || path.startsWith("/profit") || path === "/exceptions/profit") return "admin";
  if (path.startsWith("/team")) return "team";
  if (path === "/orders" || path.startsWith("/mobile")) return "orders.read";
  if (path === "/outbound") return "packing";
  if (path === "/inventory/suppliers" || path.startsWith("/procurement") || path.startsWith("/purchase")) return "procurement";
  if (path.startsWith("/inventory")) return "inventory.read";
  if (path.startsWith("/exceptions")) return "orders.read";
  if (["/seller-analytics", "/order-car-heatmap", "/order-tracking"].includes(path) || path.startsWith("/advertising")) return "analytics";
  return "operations";
}

export function canAccessPage(subject, path) {
  const permission = pagePermission(path);
  return permission === "common" ? getRoles(subject).length > 0 : hasPermission(subject, permission);
}

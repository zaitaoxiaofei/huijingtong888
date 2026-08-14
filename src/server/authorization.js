const ROLE_LEVELS = {
  operator: 1,
  manager: 2,
  admin: 3
};

function roleLevel(role) {
  return ROLE_LEVELS[String(role || "").trim().toLowerCase()] || 0;
}

function hasRole(session, allowedRoles = []) {
  const allowed = allowedRoles.map((role) => String(role || "").toLowerCase());
  return allowed.includes(String(session?.role || "").toLowerCase());
}

function hasMinimumRole(session, minimumRole) {
  return roleLevel(session?.role) >= roleLevel(minimumRole);
}

function methodIsMutation(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "").toUpperCase());
}

function deny(reason = "权限不足") {
  return { allowed: false, status: 403, error: reason };
}

export function authorizeApiRequest(req, parts = []) {
  const method = String(req.method || "").toUpperCase();
  const session = req._session;
  if (!session) return deny("未登录");
  if (parts[0] !== "api") return { allowed: true };

  if (parts[1] === "people" && methodIsMutation(method)) {
    return hasRole(session, ["admin"]) ? { allowed: true } : deny("仅管理员可以管理人员账号");
  }

  if (parts[1] === "onboarding" && methodIsMutation(method)) {
    return hasMinimumRole(session, "manager") ? { allowed: true } : deny("仅管理员或经理可以编辑入职知识库");
  }

  if (["shops", "ai-provider", "scheduled-jobs"].includes(parts[1]) && methodIsMutation(method)) {
    return hasRole(session, ["admin"]) ? { allowed: true } : deny("仅管理员可以修改系统配置");
  }

  if (parts[1] === "inventory-product-naming" && methodIsMutation(method)) {
    if (method === "POST") return { allowed: true };
    const isNamedMaintainer = String(session?.name || "").trim() === "核动力牛马";
    return isNamedMaintainer ? { allowed: true } : deny("仅核动力牛马可以审核、修改或停用核心品名");
  }

  if (parts[1] === "exchange-rate" && methodIsMutation(method)) {
    return hasMinimumRole(session, "manager") ? { allowed: true } : deny("仅管理员或经理可以维护汇率");
  }

  if (parts[1] === "finance-center" && methodIsMutation(method)) {
    return hasMinimumRole(session, "manager") ? { allowed: true } : deny("仅管理员或经理可以维护财务数据");
  }

  if (parts[1] === "payroll" && methodIsMutation(method)) {
    return hasMinimumRole(session, "manager") ? { allowed: true } : deny("仅管理员或经理可以维护工资数据");
  }

  const managerMutationResources = new Set([
    "logistics-rules",
    "order-cancellation-rules",
    "stock-warehouse-rules"
  ]);
  if (managerMutationResources.has(parts[1]) && methodIsMutation(method)) {
    return hasMinimumRole(session, "manager") ? { allowed: true } : deny("仅管理员或经理可以修改基础规则");
  }

  return { allowed: true };
}

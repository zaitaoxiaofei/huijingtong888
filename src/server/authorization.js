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

  if (["shops", "ai-provider", "scheduled-jobs"].includes(parts[1]) && methodIsMutation(method)) {
    return hasRole(session, ["admin"]) ? { allowed: true } : deny("仅管理员可以修改系统配置");
  }

  if (parts[1] === "exchange-rate" && methodIsMutation(method)) {
    return hasMinimumRole(session, "manager") ? { allowed: true } : deny("仅管理员或经理可以维护汇率");
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

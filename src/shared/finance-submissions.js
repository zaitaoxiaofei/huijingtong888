export const REIMBURSEMENT_TYPES = ["办公用品", "差旅交通", "业务采购", "软件服务", "物流", "房租", "其他"];

export function canReviewFinance(session) {
  return Boolean(session?.tenant?.id) && (session.platform_role === "super_admin" || ["owner", "admin"].includes(session.tenant.role));
}

// Keep authorization and tenant-isolation gates on the same exact route list.
export function financeSubmissionRoute(parts, method) {
  if (parts[1] !== "finance-submissions" || parts.length !== 3) return null;
  if (method === "GET" && ["payroll-ledger", "payroll-export"].includes(parts[2])) return "reviewer";
  if (method === "POST" && parts[2] === "payroll-paid") return "reviewer";
  if (method === "GET" && ["companies", "template", "list", "detail", "export"].includes(parts[2])) return "member";
  if (method === "POST" && ["preview", "submit"].includes(parts[2])) return "member";
  if (method === "POST" && parts[2] === "review") return "reviewer";
  return null;
}

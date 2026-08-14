import {
  closeFinancePeriod,
  deleteFinanceExpense,
  financeCompanies,
  financeExpenses,
  financeMonthlyReport,
  financeMonthlyExport,
  financePlatformItems,
  financeVouchers,
  saveFinanceCompany,
  saveFinanceExpense,
  saveFinanceVoucher,
  saveShopCompanyAssignment
} from "../../services/finance-center.js";

export function createFinanceCenterRoutes({ readJson, services }) {
  return {
    "GET /api/finance-center/companies": () => financeCompanies(),
    "POST /api/finance-center/companies": async (req) => saveFinanceCompany(await readJson(req)),
    "POST /api/finance-center/shop-assignments": async (req) => saveShopCompanyAssignment(await readJson(req)),
    "GET /api/finance-center/report": (req, url) => financeMonthlyReport(Object.fromEntries(url.searchParams.entries())),
    "GET /api/finance-center/expenses": (req, url) => financeExpenses(Object.fromEntries(url.searchParams.entries())),
    "POST /api/finance-center/expenses": async (req) => saveFinanceExpense(await readJson(req), req._session?.personId),
    "GET /api/finance-center/vouchers": (req, url) => financeVouchers(Object.fromEntries(url.searchParams.entries())),
    "GET /api/finance-center/platform-items": (req, url) => financePlatformItems(Object.fromEntries(url.searchParams.entries())),
    "POST /api/finance-center/voucher-attachments": (req) => services.uploadTeamAttachment(req),
    "POST /api/finance-center/vouchers": async (req) => saveFinanceVoucher(await readJson(req), req._session?.personId),
    "POST /api/finance-center/close": async (req) => closeFinancePeriod(await readJson(req), req._session?.personId)
  };
}

export async function handleFinanceCenterRestRoute({ req, res, url, parts, json, writeHead }) {
  if (parts[0] !== "api" || parts[1] !== "finance-center") return false;
  if (req.method === "DELETE" && parts[2] === "expenses" && parts[3]) return json(res, await deleteFinanceExpense(parts[3]));
  if (req.method === "GET" && parts[2] === "export") {
    const file = await financeMonthlyExport(Object.fromEntries(url.searchParams.entries()));
    writeHead(res, 200, { "Content-Type": "application/vnd.ms-excel; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`, "Content-Length": file.buffer.length, "Cache-Control": "no-store" });
    return res.end(file.buffer);
  }
  return false;
}

import {financeAiCostPolicy} from '../../services/finance-ai-cost-policy.js';
import { financeDocumentArchiveContext } from '../../services/finance-document-archive-context.js';
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
import { tenantIdFromRequest } from "../tenant-context.js";
import { readOzonPostingFinanceMysql } from '../../services/ozon-finance-postings-read.js';
import { companyFinanceDocuments } from '../../services/company-finance-documents.js';

export function createFinanceCenterRoutes({ readJson, services }) {
  return {
    "GET /api/finance-center/document-archive-context": (req,url) => financeDocumentArchiveContext(Object.fromEntries(url.searchParams),req._session),
    "GET /api/finance-center/ai-cost-policy": req=>financeAiCostPolicy.get(req._session),
    "POST /api/finance-center/ai-cost-policy": async req=>financeAiCostPolicy.save(await readJson(req,{limitBytes:64*1024}),req._session),
    "POST /api/finance-center/order-sales-source": async req => companyFinanceDocuments.orderSalesSource(await readJson(req,{limitBytes:64*1024}),req._session),
    "GET /api/finance-center/document-adjustments": (req,url) => companyFinanceDocuments.adjustments(Object.fromEntries(url.searchParams),req._session),
    "GET /api/finance-center/document-reconciliation": (req,url) => companyFinanceDocuments.reconcile(Object.fromEntries(url.searchParams),req._session),
    "POST /api/finance-center/document-calibration": async req => {
      const body=await readJson(req,{limitBytes:64*1024});
      if(!['preview','confirm'].includes(body.action))throw Object.assign(new Error('请选择校准预览或确认'),{statusCode:400});
      return companyFinanceDocuments[body.action==='preview'?'calibrationPreview':'calibrationConfirm'](body,req._session);
    },
    "GET /api/finance-center/document-report": (req,url) => companyFinanceDocuments.report(Object.fromEntries(url.searchParams),req._session),
    "POST /api/finance-center/document-import": async req => {
      const body=await readJson(req,{limitBytes:64*1024});
      if(!['lookup','preview','confirm','review','confirmPayouts'].includes(body.action))throw Object.assign(new Error('请选择上传解析、确认归档或凭证审核操作'),{statusCode:400});
      return companyFinanceDocuments[body.action](body,req._session);
    },
    "POST /api/finance-center/ozon-posting-accruals": async req => readOzonPostingFinanceMysql(await readJson(req, { limitBytes: 64 * 1024 }), req._session, { signal: req._abortSignal }),
    "GET /api/finance-center/companies": (req) => financeCompanies(tenantIdFromRequest(req)),
    "GET /api/finance-center/inventory-capital-details": (req, url) => services.financeInventoryCapitalDetails(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/finance-center/inventory-capital": (req, url) => services.financeInventoryCapital(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "POST /api/finance-center/companies": async (req) => saveFinanceCompany(await readJson(req), tenantIdFromRequest(req)),
    "POST /api/finance-center/shop-assignments": async (req) => saveShopCompanyAssignment(await readJson(req), tenantIdFromRequest(req)),
    "GET /api/finance-center/report": (req, url) => financeMonthlyReport(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/finance-center/expenses": (req, url) => financeExpenses(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "POST /api/finance-center/expenses": async (req) => saveFinanceExpense(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "GET /api/finance-center/vouchers": (req, url) => financeVouchers(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "GET /api/finance-center/platform-items": (req, url) => financePlatformItems(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req)),
    "POST /api/finance-center/voucher-attachments": (req) => services.uploadTeamAttachment(req, { purpose: "finance" }),
    "POST /api/finance-center/vouchers": async (req) => saveFinanceVoucher(await readJson(req), req._session?.personId, tenantIdFromRequest(req)),
    "POST /api/finance-center/close": async (req) => closeFinancePeriod(await readJson(req), req._session?.personId, tenantIdFromRequest(req))
  };
}

export async function handleFinanceCenterRestRoute({ req, res, url, parts, json, writeHead }) {
  if (parts[0] !== "api" || parts[1] !== "finance-center") return false;
  if(req.method==='GET'&&parts.length===3&&parts[2]==='document-export'){
    const file=await companyFinanceDocuments.export(Object.fromEntries(url.searchParams),req._session);
    writeHead(res,200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'Content-Length':file.buffer.length,'Cache-Control':'no-store'});return res.end(file.buffer);
  }
  if (req.method === "DELETE" && parts[2] === "expenses" && parts[3]) return json(res, await deleteFinanceExpense(parts[3], tenantIdFromRequest(req)));
  if (req.method === "GET" && parts[2] === "export") {
    const file = await financeMonthlyExport(Object.fromEntries(url.searchParams.entries()), tenantIdFromRequest(req));
    writeHead(res, 200, { "Content-Type": "application/vnd.ms-excel; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`, "Content-Length": file.buffer.length, "Cache-Control": "no-store" });
    return res.end(file.buffer);
  }
  return false;
}

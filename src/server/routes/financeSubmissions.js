import { financeSubmissions, submissionActor } from "../../services/finance-submissions.js";
import { reimbursementTemplate, payrollTemplate, submissionExport } from "../../services/finance-workbooks.js";

export function createFinanceSubmissionRoutes({ readJson }) {
  return {
    "GET /api/finance-submissions/companies": req => financeSubmissions.companies(req._session),
    "GET /api/finance-submissions/list": (req, url) => financeSubmissions.list(Object.fromEntries(url.searchParams), req._session),
    "GET /api/finance-submissions/detail": (req, url) => financeSubmissions.detail(url.searchParams.get("id"), req._session),
    "POST /api/finance-submissions/preview": async req => financeSubmissions.preview(await readJson(req, { limitBytes: 12 * 1024 * 1024 }), req._session),
    "POST /api/finance-submissions/submit": async req => financeSubmissions.submit(await readJson(req, { limitBytes: 12 * 1024 * 1024 }), req._session),
    "POST /api/finance-submissions/review": async req => financeSubmissions.review(await readJson(req), req._session)
  };
}

export async function handleFinanceSubmissionDownload({ req, res, url, parts, writeHead }) {
  if (req.method !== "GET" || parts.length !== 3 || parts[1] !== "finance-submissions" || !["template", "export"].includes(parts[2])) return false;
  submissionActor(req._session);
  let buffer, name;
  if (parts[2] === "template") {
    const payroll = url.searchParams.get("kind") === "payroll";
    if (payroll) submissionActor(req._session, true);
    const options = { companies: await financeSubmissions.companies(req._session), name: await financeSubmissions.identity(req._session) };
    buffer = payroll ? await payrollTemplate(options) : await reimbursementTemplate(options);
    name = payroll ? "企业工资模板.xlsx" : "企业报销模板.xlsx";
  } else {
    // Export a single reviewed selection with its pictures, bounded to one import batch.
    const batch = await financeSubmissions.detail(url.searchParams.get("id"), req._session);
    buffer = await submissionExport([batch]);
    name = `${batch.kind === "payroll" ? "工资" : "报销"}明细-${batch.id}.xlsx`;
  }
  writeHead(res, 200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "Content-Length": buffer.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(buffer);
  return true;
}

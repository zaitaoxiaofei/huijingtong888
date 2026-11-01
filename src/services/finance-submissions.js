import { createHash } from "node:crypto";
import { mysqlQuery, mysqlExecute, withMysqlTransaction } from "../mysql-pool.js";
import { ensureFinanceCenterSchema } from "./finance-center.js";
import { canReviewFinance } from "../shared/finance-submissions.js";
import { parsePayroll, parseReimbursements, money, WORKBOOK_LIMIT } from "./finance-workbooks.js";

export { FINANCE_SUBMISSIONS_SCHEMA } from "./finance-submissions-schema.js";
import { FINANCE_SUBMISSIONS_SCHEMA } from "./finance-submissions-schema.js";

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

export function submissionActor(session, reviewer = false) {
  const tenantId = Number(session?.tenant?.id), personId = Number(session?.personId);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !Number.isSafeInteger(personId) || personId <= 0 || !session.tenant.slug) fail("请先登录并选择有效企业", 403);
  if (reviewer && !canReviewFinance(session)) fail("仅本企业负责人或管理员可以审批或导入工资", 403);
  return { tenantId, personId, reviewer: canReviewFinance(session), legacy: session.tenant.slug === "default" };
}

export function createFinanceSubmissions({ query = mysqlQuery, execute = mysqlExecute, transaction = withMysqlTransaction, ensureFinance = ensureFinanceCenterSchema } = {}) {
  let ready;
  async function ensure() {
    if (!ready) ready = (async () => { await ensureFinance(); for (const sql of FINANCE_SUBMISSIONS_SCHEMA) await execute(sql); })().catch(error => { ready = null; throw error; });
    return ready;
  }
  function kindOf(value) {
    if (!["reimbursement", "payroll"].includes(value)) fail("请选择报销或工资导入");
    return value;
  }
  async function companies(session) {
    const actor = submissionActor(session);
    await ensure();
    // Employees receive only company IDs and names, never bank/tax details.
    return query(`SELECT id, name FROM finance_companies WHERE status='active' AND (tenant_id=?${actor.legacy ? " OR tenant_id IS NULL OR tenant_id=0" : ""}) ORDER BY id`, [actor.tenantId]);
  }
  async function identity(session) {
    const actor = submissionActor(session);
    const [person] = await query("SELECT name FROM people WHERE id=? AND active=1 LIMIT 1", [actor.personId]);
    if (!person?.name) fail("当前人员姓名缺失，请联系管理员完善人员档案", 403);
    return String(person.name);
  }
  async function parse(body, session) {
    const kind = kindOf(body.kind);
    submissionActor(session, kind === "payroll");
    if (typeof body.base64 !== "string" || body.base64.length > Math.ceil(WORKBOOK_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64)) fail("请上传不超过8MB的 .xlsx 表格");
    if (!/\.xlsx$/i.test(String(body.file_name || ""))) fail("只支持 .xlsx，请下载模板后填写");
    const buffer = Buffer.from(body.base64, "base64");
    const options = { companies: await companies(session), name: await identity(session) };
    const rows = kind === "payroll" ? await parsePayroll(buffer, options) : await parseReimbursements(buffer, options);
    if (Buffer.byteLength(JSON.stringify(rows)) > 12 * 1024 * 1024) fail("截图内容过大，请压缩截图或拆分表格");
    // Semantic fingerprint also prevents a resaved/recompressed copy from duplicating a claim.
    const fingerprint = rows.map(({ source_row, sheet, ...row }) => row);
    const hash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
    return { kind, rows, hash, name: options.name, total: money(rows.reduce((sum, row) => sum + row.amount, 0)) };
  }
  async function list(filters, session) {
    const actor = submissionActor(session);
    const kind = kindOf(filters.kind || "reimbursement");
    if (kind === "payroll") submissionActor(session, true);
    await ensure();
    const where = ["tenant_id=?", "kind=?"], params = [actor.tenantId, kind];
    if (!actor.reviewer) { where.push("applicant_id=?"); params.push(actor.personId); }
    if (filters.status) {
      if (!["pending", "approved", "rejected"].includes(filters.status)) fail("审批状态无效");
      where.push("status=?"); params.push(filters.status);
    }
    return query(`SELECT id, applicant_id, applicant_name, kind, status, file_name, total_amount, item_count, review_note, created_at, reviewed_at FROM finance_submissions WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 200`, params);
  }
  async function detail(id, session) {
    const actor = submissionActor(session);
    if (!/^\d+$/.test(String(id))) fail("申请编号无效");
    await ensure();
    const [batch] = await query(`SELECT * FROM finance_submissions WHERE id=? AND tenant_id=?${actor.reviewer ? "" : " AND applicant_id=?"} LIMIT 1`, [Number(id), actor.tenantId, ...(actor.reviewer ? [] : [actor.personId])]);
    if (!batch || (batch.kind === "payroll" && !actor.reviewer)) fail("申请不存在或无权访问", 404);
    const rows = await query("SELECT id, detail_json FROM finance_submission_items WHERE submission_id=? AND tenant_id=? ORDER BY id", [batch.id, actor.tenantId]);
    return { ...batch, items: rows.map(row => ({ ...JSON.parse(row.detail_json), id: row.id })) };
  }
  async function submit(body, session) {
    const actor = submissionActor(session);
    const parsed = await parse(body, session);
    try {
      return await transaction(async connection => {
        const run = async (sql, params = []) => (await connection.execute(sql, params))[0];
        const result = await run(`INSERT INTO finance_submissions (tenant_id, applicant_id, applicant_name, kind, source_hash, file_name, total_amount, item_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [actor.tenantId, actor.personId, parsed.name, parsed.kind, parsed.hash, String(body.file_name).slice(0, 255), parsed.total, parsed.rows.length]);
        const id = Number(result.insertId);
        if (parsed.kind === "payroll") {
          const periods = new Map(parsed.rows.map(row => [`${row.company_id}/${row.month}`, row]));
          for (const row of periods.values()) {
            await run("INSERT INTO finance_imported_payroll_periods (tenant_id, company_id, month_key, submission_id) VALUES (?, ?, ?, ?)", [actor.tenantId, row.company_id, row.month, id]);
          }
        }
        for (const row of parsed.rows) await run("INSERT INTO finance_submission_items (tenant_id, submission_id, company_id, expense_date, amount, detail_json) VALUES (?, ?, ?, ?, ?, ?)", [actor.tenantId, id, row.company_id, row.expense_date, row.amount, JSON.stringify(row)]);
        return { ok: true, id, status: "pending" };
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") fail(parsed.kind === "payroll" ? "该公司月份已有工资导入记录，请先核对原申请，避免重复计入工资" : "这份报销内容已经提交，请在报销记录中查看审批进度", 409);
      throw error;
    }
  }
  async function review(body, session) {
    const actor = submissionActor(session, true);
    if (!/^\d+$/.test(String(body.id)) || !["approved", "rejected"].includes(body.status)) fail("申请编号或审批结果无效");
    const note = String(body.note || "").trim().slice(0, 500);
    if (body.status === "rejected" && !note) fail("请填写退回原因");
    await ensure();
    return transaction(async connection => {
      const run = async (sql, params = []) => (await connection.execute(sql, params))[0];
      const [batch] = await run("SELECT * FROM finance_submissions WHERE id=? AND tenant_id=? FOR UPDATE", [Number(body.id), actor.tenantId]);
      if (!batch) fail("申请不存在或不属于当前企业", 404);
      if (batch.status !== "pending") fail("该申请已经审批，请刷新记录", 409);
      if (body.status === "approved") {
        const items = await run("SELECT * FROM finance_submission_items WHERE submission_id=? AND tenant_id=? ORDER BY company_id, expense_date, id", [batch.id, actor.tenantId]);
        for (const item of items) {
          const row = JSON.parse(item.detail_json);
          const [company] = await run(`SELECT id FROM finance_companies WHERE id=? AND status='active' AND (tenant_id=?${actor.legacy ? " OR tenant_id IS NULL OR tenant_id=0" : ""}) LIMIT 1`, [item.company_id, actor.tenantId]);
          if (!company) fail("申请的归属公司已停用或不属于当前企业，请退回申请后重新提交");
          const month = row.expense_date.slice(0, 7);
          await run("INSERT IGNORE INTO finance_periods (tenant_id, company_id, month_key) VALUES (?, ?, ?)", [actor.legacy ? null : actor.tenantId, item.company_id, month]);
          const [period] = await run("SELECT status FROM finance_periods WHERE company_id=? AND month_key=? FOR UPDATE", [item.company_id, month]);
          if (period?.status === "closed") fail(`${row.company_name} ${month}已关账，不能计入该期费用`);
          if (batch.kind === "payroll") {
            const [existing] = await run("SELECT id FROM finance_expenses WHERE company_id=? AND category='salary' AND source_type IN ('payroll', 'payroll_period') AND expense_date>=? AND expense_date<=LAST_DAY(?) LIMIT 1", [item.company_id, `${month}-01`, `${month}-01`]);
            if (existing) fail(`${row.company_name} ${month}已有旧工资模块入账记录，请先核对，避免重复计入成本`);
          }
          await run(`INSERT INTO finance_expenses (tenant_id, company_id, expense_date, category, description, currency_code, original_amount, exchange_rate, amount_cny, advanced_by, is_advance_payment, voucher_status, source_type, source_id, created_by)
            VALUES (?, ?, ?, ?, ?, 'CNY', ?, 1, ?, ?, ?, ?, 'finance_submission', ?, ?)`,
          [actor.legacy ? null : actor.tenantId, item.company_id, row.expense_date, batch.kind === "payroll" ? "salary" : row.category, row.description, row.amount, row.amount, batch.kind === "reimbursement" ? batch.applicant_name : null, batch.kind === "reimbursement" ? 1 : 0, batch.kind === "reimbursement" ? "matched" : "missing", item.id, batch.applicant_id]);
        }
      } else if (batch.kind === "payroll") {
        await run("DELETE FROM finance_imported_payroll_periods WHERE tenant_id=? AND submission_id=?", [actor.tenantId, batch.id]);
      }
      await run("UPDATE finance_submissions SET status=?, review_note=?, reviewed_by=?, reviewed_at=UTC_TIMESTAMP() WHERE id=? AND tenant_id=?", [body.status, note, actor.personId, batch.id, actor.tenantId]);
      return { ok: true, status: body.status };
    });
  }
  return { companies, identity, list, detail, submit, review, preview: async (body, session) => {
    const { rows, total } = await parse(body, session);
    return { items: rows, total_amount: total, item_count: rows.length };
  } };
}

export const financeSubmissions = createFinanceSubmissions();

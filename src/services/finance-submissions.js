import { createHash, randomUUID } from "node:crypto";
import { mysqlQuery, mysqlExecute, withMysqlTransaction } from "../mysql-pool.js";
import { ensureFinanceCenterSchema } from "./finance-center.js";
import { normalizePayrollEntry } from "../shared/payroll-entry.js";
import { canReviewFinance } from "../shared/finance-submissions.js";
import { parsePayroll, parseReimbursements, money, WORKBOOK_LIMIT } from "./finance-workbooks.js";

export { FINANCE_SUBMISSIONS_SCHEMA } from "./finance-submissions-schema.js";
import { FINANCE_SUBMISSIONS_SCHEMA } from "./finance-submissions-schema.js";

const payrollRevision = text => createHash("sha256").update(text).digest("hex");
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
      if (error.code === "ER_DUP_ENTRY") fail(parsed.kind === "payroll" ? "该公司月份已有工资记录，请在工资明细中新增或编辑，避免重复计入工资" : "这份报销内容已经提交，请在报销记录中查看审批进度", 409);
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
        const paid = await run(`SELECT p.id FROM finance_submission_items i JOIN finance_payroll_payment_updates p
          ON p.id=(SELECT MAX(last.id) FROM finance_payroll_payment_updates last WHERE last.tenant_id=i.tenant_id AND last.item_id=i.id)
          WHERE i.tenant_id=? AND i.submission_id=? AND p.paid_amount>0 LIMIT 1`, [actor.tenantId, batch.id]);
        if (paid.length) fail("这份工资表已有发放记录，请先核对已发金额，不能直接退回重导", 409);
        await run("DELETE FROM finance_imported_payroll_periods WHERE tenant_id=? AND submission_id=?", [actor.tenantId, batch.id]);
      }
      await run("UPDATE finance_submissions SET status=?, review_note=?, reviewed_by=?, reviewed_at=UTC_TIMESTAMP() WHERE id=? AND tenant_id=?", [body.status, note, actor.personId, batch.id, actor.tenantId]);
      return { ok: true, status: body.status };
    });
  }
  async function payrollLedger(filters, session) {
    const actor = submissionActor(session, true);
    const year = String(filters.year || new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()).slice(0, 4));
    if (!/^20\d{2}$/.test(year)) fail("工资年份无效");
    const companyList = await companies(session);
    const selected = filters.company_id && filters.company_id !== "all" ? Number(filters.company_id) : null;
    if (selected != null && !companyList.some(company => Number(company.id) === selected)) fail("公司不存在或不属于当前企业", 404);
    if (!companyList.length) return { year, companies: [], rows: [] };
    const companyIds = selected ? [selected] : companyList.map(company => Number(company.id));
    const records = await query(`SELECT i.id, i.detail_json, s.status AS approval_status, p.paid_amount, p.created_at AS paid_updated_at
      FROM finance_submission_items i
      JOIN finance_submissions s ON s.id=i.submission_id AND s.tenant_id=i.tenant_id AND s.kind='payroll'
      JOIN finance_imported_payroll_periods period ON period.tenant_id=i.tenant_id AND period.submission_id=i.submission_id
        AND period.company_id=i.company_id AND period.month_key=DATE_FORMAT(i.expense_date,'%Y-%m')
      LEFT JOIN finance_payroll_payment_updates p ON p.id=(SELECT MAX(last.id) FROM finance_payroll_payment_updates last WHERE last.tenant_id=i.tenant_id AND last.item_id=i.id)
      WHERE i.tenant_id=? AND i.company_id IN (${companyIds.map(() => "?").join(",")}) AND i.expense_date>=? AND i.expense_date<?
        AND s.status IN ('pending','approved') ORDER BY i.expense_date, i.company_id, i.id`, [actor.tenantId, ...companyIds, `${year}-01-01`, `${Number(year) + 1}-01-01`]);
    return { year, companies: companyList, rows: records.map(record => {
      const row = JSON.parse(record.detail_json), paid = money(record.paid_amount || 0);
      return { ...row, id: record.id, revision: payrollRevision(record.detail_json), approval_status: record.approval_status, paid_amount: paid,
        remaining_amount: money(row.net - paid), paid_updated_at: record.paid_updated_at };
    }) };
  }
  async function recordPayrollPaid(body, session) {
    const actor = submissionActor(session, true);
    const itemId = Number(body.item_id), amount = Number(body.paid_amount), expected = Number(body.expected_paid_amount);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) fail("工资明细编号无效");
    if (body.paid_amount == null || body.paid_amount === "" || !Number.isFinite(amount) || amount < 0 || amount > 100000000) fail("已发金额应为有效的非负金额");
    if (body.expected_paid_amount == null || !Number.isFinite(expected)) fail("请刷新工资明细后再登记发放金额");
    await ensure();
    return transaction(async connection => {
      const run = async (sql, params = []) => (await connection.execute(sql, params))[0];
      const [item] = await run("SELECT id, submission_id, detail_json FROM finance_submission_items WHERE id=? AND tenant_id=?", [itemId, actor.tenantId]);
      if (!item) fail("工资明细不存在、不属于当前企业或已退回", 404);
      // Match review's lock order so payment and rejection serialize on the parent.
      const [batch] = await run("SELECT id FROM finance_submissions WHERE id=? AND tenant_id=? AND kind='payroll' AND status IN ('pending','approved') FOR UPDATE", [item.submission_id, actor.tenantId]);
      if (!batch) fail("工资明细不存在、不属于当前企业或已退回", 404);
      const [last] = await run("SELECT paid_amount FROM finance_payroll_payment_updates WHERE tenant_id=? AND item_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE", [actor.tenantId, itemId]);
      const current = money(last?.paid_amount || 0), next = money(amount);
      if (next === current) return { ok: true, paid_amount: current };
      if (body.expected_revision) {
        const [fresh] = await run("SELECT detail_json FROM finance_submission_items WHERE id=? AND tenant_id=? FOR UPDATE",[itemId,actor.tenantId]);
        if (body.expected_revision !== payrollRevision(fresh.detail_json)) fail("工资明细已被修改，请刷新后核对",409);
      }
      if (money(expected) !== current) fail("已发金额已被其他管理员修改，请刷新后核对", 409);
      await run("INSERT INTO finance_payroll_payment_updates (tenant_id, item_id, paid_amount, recorded_by) VALUES (?, ?, ?, ?)", [actor.tenantId, itemId, next, actor.personId]);
      return { ok: true, paid_amount: next };
    });
  }
  async function recordPayrollPaidBatch(body, session) {
    const actor = submissionActor(session, true);
    const entries = body.items;
    if (!Array.isArray(entries) || !entries.length || entries.length > 500) fail("请选择1至500条待登记工资明细");
    const ids = entries.map(row => Number(row.item_id));
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) fail("工资明细编号无效或重复");
    if (entries.some(row => row.expected_paid_amount == null || !Number.isFinite(Number(row.expected_paid_amount)) || !/^[a-f0-9]{64}$/.test(String(row.expected_revision || "")))) fail("请刷新工资明细后再批量登记");
    const owned = new Set((await companies(session)).map(row => Number(row.id)));
    return transaction(async connection => {
      const run = async (sql, params = []) => (await connection.execute(sql, params))[0];
      const items = await run(`SELECT * FROM finance_submission_items WHERE tenant_id=? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, [actor.tenantId, ...ids]);
      if (items.length !== ids.length || items.some(item => !owned.has(Number(item.company_id)))) fail("部分工资明细不存在或不属于当前企业", 404);
      const companyIds = [...new Set(items.map(item=>Number(item.company_id)))].sort((a,b)=>a-b);
      const freshCompanies = await run(`SELECT id FROM finance_companies WHERE status='active' AND (tenant_id=?${actor.legacy ? " OR tenant_id IS NULL OR tenant_id=0" : ""}) AND id IN (${companyIds.map(()=>"?").join(",")}) ORDER BY id LOCK IN SHARE MODE`,[actor.tenantId,...companyIds]);
      if(freshCompanies.length!==companyIds.length) fail("部分公司已停用或不属于当前企业，请刷新",404);
      const parents = [...new Set(items.map(item => Number(item.submission_id)))].sort((a,b)=>a-b);
      const batches = await run(`SELECT id FROM finance_submissions WHERE tenant_id=? AND kind='payroll' AND status IN ('pending','approved') AND id IN (${parents.map(()=>"?").join(",")}) ORDER BY id FOR UPDATE`, [actor.tenantId, ...parents]);
      if (batches.length !== parents.length) fail("工资表已退回或状态已变化，请刷新", 409);
      let changed = 0;
      for (const item of items) {
        const row = entries.find(row => Number(row.item_id) === Number(item.id));
        // Parent locks serialize approval, edits and both single/batch payment writers.
        const [fresh] = await run("SELECT detail_json FROM finance_submission_items WHERE id=? AND tenant_id=? FOR UPDATE", [item.id, actor.tenantId]);
        if (payrollRevision(fresh.detail_json) !== row.expected_revision) fail("工资明细已被修改，请刷新后重新选择", 409);
        const [last] = await run("SELECT paid_amount FROM finance_payroll_payment_updates WHERE tenant_id=? AND item_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE", [actor.tenantId, item.id]);
        const current = money(last?.paid_amount || 0), net = Number(JSON.parse(fresh.detail_json).net);
        if (!Number.isFinite(net) || net < 0) fail("工资实发金额无效，请先编辑核对明细", 409);
        if (current >= money(net)) continue;
        if (money(row.expected_paid_amount) !== current) fail("已发金额已被其他管理员修改，未保存本次批量登记，请刷新", 409);
        await run("INSERT INTO finance_payroll_payment_updates (tenant_id,item_id,paid_amount,recorded_by) VALUES (?,?,?,?)", [actor.tenantId,item.id,money(net),actor.personId]);
        changed++;
      }
      return { ok: true, changed, skipped: items.length - changed };
    });
  }
  async function savePayrollItem(body, session) {
    const actor = submissionActor(session, true);
    const itemId = body.item_id == null ? null : Number(body.item_id), companyId = Number(body.company_id);
    if (itemId != null && (!Number.isSafeInteger(itemId) || itemId <= 0)) fail("工资明细编号无效");
    const owned = await companies(session), company = owned.find(row => Number(row.id) === companyId);
    if (!company) fail("公司不存在或不属于当前企业", 404);
    const normalized = normalizePayrollEntry(body);
    if (itemId && !/^[a-f0-9]{64}$/.test(String(body.expected_revision || ""))) fail("请刷新工资明细后再编辑");
    return transaction(async connection => {
      const run = async (sql, params = []) => (await connection.execute(sql, params))[0];
      // Serialize first-time company/month creation before reserving its submission.
      const [freshCompany] = await run(`SELECT id,name FROM finance_companies WHERE id=? AND status='active' AND (tenant_id=?${actor.legacy ? " OR tenant_id IS NULL OR tenant_id=0" : ""}) FOR UPDATE`,[companyId,actor.tenantId]);
      if(!freshCompany) fail("公司已停用或不属于当前企业",404);
      let item, batch;
      if (itemId) {
        [item] = await run("SELECT * FROM finance_submission_items WHERE id=? AND tenant_id=?", [itemId,actor.tenantId]);
        if (!item) fail("工资明细不存在或不属于当前企业",404);
        const old = JSON.parse(item.detail_json);
        if (Number(item.company_id) !== companyId || old.month !== normalized.month) fail("已有记录的公司和月份不能直接变更，可使用复制新增");
        [batch] = await run("SELECT * FROM finance_submissions WHERE id=? AND tenant_id=? AND kind='payroll' AND status IN ('pending','approved') FOR UPDATE",[item.submission_id,actor.tenantId]);
        if (!batch) fail("工资表已退回，请刷新后再操作",409);
        [item] = await run("SELECT * FROM finance_submission_items WHERE id=? AND tenant_id=? FOR UPDATE",[itemId,actor.tenantId]);
        if (payrollRevision(item.detail_json) !== body.expected_revision) fail("工资明细已被其他管理员修改，请刷新后再保存",409);
      } else {
        const [period] = await run("SELECT submission_id FROM finance_imported_payroll_periods WHERE tenant_id=? AND company_id=? AND month_key=?",[actor.tenantId,companyId,normalized.month]);
        if (period) [batch] = await run("SELECT * FROM finance_submissions WHERE id=? AND tenant_id=? AND kind='payroll' AND status IN ('pending','approved') FOR UPDATE",[period.submission_id,actor.tenantId]);
        if (period && !batch) fail("该月份工资状态异常，请先核对原申请",409);
      }
      await run("INSERT IGNORE INTO finance_periods (tenant_id,company_id,month_key) VALUES (?,?,?)",[actor.legacy?null:actor.tenantId,companyId,normalized.month]);
      const [closed] = await run("SELECT status FROM finance_periods WHERE company_id=? AND month_key=? FOR UPDATE",[companyId,normalized.month]);
      if (closed?.status === 'closed') fail(`${company.name} ${normalized.month}已关账，不能新增或修改工资` ,409);
      if (!batch) {
        const result = await run("INSERT INTO finance_submissions (tenant_id,applicant_id,applicant_name,kind,source_hash,file_name,total_amount,item_count) VALUES (?,?,?,'payroll',?,'手工工资明细',0,0)",[actor.tenantId,actor.personId,String(session.name || session.username || '管理员').slice(0,128),payrollRevision(randomUUID())]);
        batch={id:Number(result.insertId),status:'pending'};
        await run("INSERT INTO finance_imported_payroll_periods (tenant_id,company_id,month_key,submission_id) VALUES (?,?,?,?)",[actor.tenantId,companyId,normalized.month,batch.id]);
      }
      const siblings = await run("SELECT id,detail_json FROM finance_submission_items WHERE tenant_id=? AND submission_id=? AND company_id=? AND expense_date>=? AND expense_date<=LAST_DAY(?) ORDER BY id",[actor.tenantId,batch.id,companyId,normalized.month+'-01',normalized.month+'-01']);
      const duplicate=siblings.find(row=>Number(row.id)!==itemId && String(JSON.parse(row.detail_json).person_name||'').trim()===normalized.person_name);
      if (duplicate) {
        const original=JSON.parse(duplicate.detail_json);
        if (!itemId && JSON.stringify(normalizePayrollEntry(original))===JSON.stringify(normalized)) return {ok:true,id:Number(duplicate.id),status:batch.status,unchanged:true};
        fail("该公司月份已有同名员工工资，请编辑原明细，避免重复计入",409);
      }
      const next={...(item?JSON.parse(item.detail_json):{images:[]}),...normalized,company_id:companyId,company_name:freshCompany.name,entry_source:item?'manual_edit':'manual'};
      const json=JSON.stringify(next);
      let id=itemId;
      if (item) await run("UPDATE finance_submission_items SET amount=?,detail_json=? WHERE id=? AND tenant_id=?",[next.amount,json,id,actor.tenantId]);
      else { const result=await run("INSERT INTO finance_submission_items (tenant_id,submission_id,company_id,expense_date,amount,detail_json) VALUES (?,?,?,?,?,?)",[actor.tenantId,batch.id,companyId,next.expense_date,next.amount,json]);id=Number(result.insertId); }
      if (batch.status==='approved') {
        const scope=actor.legacy?'(tenant_id IS NULL OR tenant_id=0 OR tenant_id=?)':'tenant_id=?';
        if(item){
          const expenses=await run(`SELECT id FROM finance_expenses WHERE source_type='finance_submission' AND source_id=? AND company_id=? AND ${scope} FOR UPDATE`,[id,companyId,actor.tenantId]);
          if(expenses.length!==1) fail("已审批工资对应的费用记录缺失或重复，请先核对账单",409);
          await run(`UPDATE finance_expenses SET description=?,original_amount=?,amount_cny=? WHERE id=? AND ${scope}`,[next.description,next.amount,next.amount,expenses[0].id,actor.tenantId]);
        } else {
          const old=await run("SELECT id FROM finance_expenses WHERE company_id=? AND category='salary' AND source_type IN ('payroll','payroll_period') AND expense_date>=? AND expense_date<=LAST_DAY(?) LIMIT 1",[companyId,next.month+'-01',next.month+'-01']);
          if(old.length) fail("该月已有旧工资模块入账记录，请先核对，避免重复计入成本",409);
          await run("INSERT INTO finance_expenses (tenant_id,company_id,expense_date,category,description,currency_code,original_amount,exchange_rate,amount_cny,voucher_status,source_type,source_id,created_by) VALUES (?,?,?,'salary',?,'CNY',?,1,?,'missing','finance_submission',?,?)",[actor.legacy?null:actor.tenantId,companyId,next.expense_date,next.description,next.amount,next.amount,id,actor.personId]);
        }
      }
      await run("INSERT INTO finance_payroll_item_revisions (tenant_id,item_id,operation,before_json,after_json,recorded_by) VALUES (?,?,?,?,?,?)",[actor.tenantId,id,item?'edit':'create',item?.detail_json||null,json,actor.personId]);
      await run("UPDATE finance_submissions SET total_amount=(SELECT COALESCE(SUM(amount),0) FROM finance_submission_items WHERE submission_id=? AND tenant_id=?),item_count=(SELECT COUNT(*) FROM finance_submission_items WHERE submission_id=? AND tenant_id=?) WHERE id=? AND tenant_id=?",[batch.id,actor.tenantId,batch.id,actor.tenantId,batch.id,actor.tenantId]);
      return {ok:true,id,status:batch.status,revision:payrollRevision(json)};
    }).catch(error => { if(error.code==='ER_DUP_ENTRY') fail("该公司月份刚新增了工资记录，请刷新后在原明细中继续添加",409);throw error; });
  }
  return { companies, identity, list, detail, submit, review, payrollLedger, recordPayrollPaid, recordPayrollPaidBatch, savePayrollItem, preview: async (body, session) => {
    const { rows, total } = await parse(body, session);
    return { items: rows, total_amount: total, item_count: rows.length };
  } };
}

export const financeSubmissions = createFinanceSubmissions();

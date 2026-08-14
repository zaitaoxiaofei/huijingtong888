import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { ensureFinanceCenterSchema } from "./finance-center.js";

let schemaReady = false;
const CONTRIBUTION_KEYS = ["pension", "medical", "supplementary_medical", "unemployment", "injury", "maternity", "housing_fund"];

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function requiredId(value, label) {
  const id = Number(value || 0);
  if (!id) badRequest(`${label}不能为空`);
  return id;
}

function monthKey(value) {
  const key = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(key)) badRequest("工资月份不能为空，格式应为 YYYY-MM");
  return key;
}

function jsonObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try { return JSON.parse(String(value || "")) || fallback; } catch { return fallback; }
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function rate(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0 || number > 1) badRequest("缴费比例必须在 0 到 1 之间");
  return number;
}

export async function ensurePayrollSchema() {
  if (schemaReady) return;
  await ensureFinanceCenterSchema();
  const statements = [
    `CREATE TABLE IF NOT EXISTS payroll_contribution_schemes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      city_code VARCHAR(32) NOT NULL,
      city_name VARCHAR(64) NOT NULL,
      social_base_min DECIMAL(18,4) NOT NULL DEFAULT 0,
      housing_base_min DECIMAL(18,4) NOT NULL DEFAULT 0,
      employer_rates_json JSON NOT NULL,
      employee_rates_json JSON NOT NULL,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      source_note VARCHAR(500) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_payroll_scheme_city_period (city_code, effective_from),
      KEY idx_payroll_scheme_effective (city_code, effective_from, effective_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS payroll_policies (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      version_no INT NOT NULL DEFAULT 1,
      components_json JSON NOT NULL,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_payroll_policy_name_version (name, version_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS payroll_profiles (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      person_id BIGINT UNSIGNED NOT NULL,
      company_id BIGINT UNSIGNED NOT NULL,
      department VARCHAR(128) NULL,
      employment_city_code VARCHAR(32) NOT NULL,
      contribution_scheme_id BIGINT UNSIGNED NOT NULL,
      policy_id BIGINT UNSIGNED NOT NULL,
      base_salary DECIMAL(18,4) NOT NULL DEFAULT 0,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_payroll_profile_person_period (person_id, effective_from),
      KEY idx_payroll_profile_company (company_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS payroll_periods (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      company_id BIGINT UNSIGNED NOT NULL,
      month_key CHAR(7) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      calculated_by BIGINT UNSIGNED NULL,
      calculated_at DATETIME NULL,
      approved_by BIGINT UNSIGNED NULL,
      approved_at DATETIME NULL,
      locked_by BIGINT UNSIGNED NULL,
      locked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_payroll_period_company_month (company_id, month_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS payroll_statements (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      period_id BIGINT UNSIGNED NOT NULL,
      person_id BIGINT UNSIGNED NOT NULL,
      profile_id BIGINT UNSIGNED NOT NULL,
      policy_id BIGINT UNSIGNED NOT NULL,
      contribution_scheme_id BIGINT UNSIGNED NOT NULL,
      base_salary DECIMAL(18,4) NOT NULL DEFAULT 0,
      fixed_earnings DECIMAL(18,4) NOT NULL DEFAULT 0,
      variable_earnings DECIMAL(18,4) NOT NULL DEFAULT 0,
      gross_salary DECIMAL(18,4) NOT NULL DEFAULT 0,
      employee_contribution DECIMAL(18,4) NOT NULL DEFAULT 0,
      employer_contribution DECIMAL(18,4) NOT NULL DEFAULT 0,
      income_tax DECIMAL(18,4) NOT NULL DEFAULT 0,
      other_deductions DECIMAL(18,4) NOT NULL DEFAULT 0,
      net_salary DECIMAL(18,4) NOT NULL DEFAULT 0,
      employer_total_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
      calculation_json JSON NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_payroll_statement_period_person (period_id, person_id),
      KEY idx_payroll_statement_person (person_id, period_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
  ];
  for (const sql of statements) await mysqlExecute(sql);
  schemaReady = true;
}

export async function payrollSetup() {
  await ensurePayrollSchema();
  const [people, companies, schemes, policies, profiles] = await Promise.all([
    mysqlQuery("SELECT id, name, username, role, active FROM people WHERE active != 0 ORDER BY id"),
    mysqlQuery("SELECT id, name, status FROM finance_companies WHERE status != 'deleted' ORDER BY id"),
    mysqlQuery("SELECT * FROM payroll_contribution_schemes WHERE status != 'deleted' ORDER BY effective_from DESC, id DESC"),
    mysqlQuery("SELECT * FROM payroll_policies WHERE status != 'deleted' ORDER BY effective_from DESC, id DESC"),
    mysqlQuery(`SELECT pr.*, pe.name AS person_name, fc.name AS company_name, ps.name AS scheme_name, pp.name AS policy_name
      FROM payroll_profiles pr JOIN people pe ON pe.id=pr.person_id JOIN finance_companies fc ON fc.id=pr.company_id
      JOIN payroll_contribution_schemes ps ON ps.id=pr.contribution_scheme_id JOIN payroll_policies pp ON pp.id=pr.policy_id
      WHERE pr.status != 'deleted' ORDER BY pe.name, pr.effective_from DESC`)
  ]);
  return {
    people,
    companies,
    schemes: schemes.map((row) => ({ ...row, employer_rates: jsonObject(row.employer_rates_json), employee_rates: jsonObject(row.employee_rates_json) })),
    policies: policies.map((row) => ({ ...row, components: jsonObject(row.components_json) })),
    profiles
  };
}

export async function saveContributionScheme(body = {}) {
  await ensurePayrollSchema();
  const cityCode = String(body.city_code || "").trim().toLowerCase();
  const cityName = String(body.city_name || "").trim();
  const name = String(body.name || "").trim();
  const effectiveFrom = String(body.effective_from || "").slice(0, 10);
  if (!name || !cityCode || !cityName || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) badRequest("方案名称、参保城市和生效日期不能为空");
  const socialBase = Number(body.social_base_min || 0);
  const housingBase = Number(body.housing_base_min || 0);
  if (!(socialBase > 0) || !(housingBase > 0)) badRequest("请填写有效的社保和公积金最低缴费基数");
  const employerRates = Object.fromEntries(CONTRIBUTION_KEYS.map((key) => [key, rate(body.employer_rates?.[key])]));
  const employeeRates = Object.fromEntries(CONTRIBUTION_KEYS.map((key) => [key, rate(body.employee_rates?.[key])]));
  const values = [name, cityCode, cityName, socialBase, housingBase, JSON.stringify(employerRates), JSON.stringify(employeeRates), effectiveFrom, body.effective_to || null, body.source_note || null];
  if (body.id) {
    await mysqlExecute(`UPDATE payroll_contribution_schemes SET name=?, city_code=?, city_name=?, social_base_min=?, housing_base_min=?, employer_rates_json=?, employee_rates_json=?, effective_from=?, effective_to=?, source_note=? WHERE id=?`, [...values, Number(body.id)]);
    return { ok: true, id: Number(body.id) };
  }
  const result = await mysqlExecute(`INSERT INTO payroll_contribution_schemes (name, city_code, city_name, social_base_min, housing_base_min, employer_rates_json, employee_rates_json, effective_from, effective_to, source_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values);
  return { ok: true, id: Number(result.insertId) };
}

export async function savePayrollPolicy(body = {}) {
  await ensurePayrollSchema();
  const name = String(body.name || "").trim();
  const effectiveFrom = String(body.effective_from || "").slice(0, 10);
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) badRequest("策略名称和生效日期不能为空");
  const components = jsonObject(body.components);
  const values = [name, Number(body.version_no || 1), JSON.stringify(components), effectiveFrom, body.effective_to || null];
  if (body.id) {
    await mysqlExecute("UPDATE payroll_policies SET name=?, version_no=?, components_json=?, effective_from=?, effective_to=? WHERE id=?", [...values, Number(body.id)]);
    return { ok: true, id: Number(body.id) };
  }
  const result = await mysqlExecute("INSERT INTO payroll_policies (name, version_no, components_json, effective_from, effective_to) VALUES (?, ?, ?, ?, ?)", values);
  return { ok: true, id: Number(result.insertId) };
}

export async function savePayrollProfile(body = {}) {
  await ensurePayrollSchema();
  const values = [
    requiredId(body.person_id, "员工"), requiredId(body.company_id, "用工公司"), body.department || null,
    String(body.employment_city_code || "").trim().toLowerCase(), requiredId(body.contribution_scheme_id, "五险一金方案"),
    requiredId(body.policy_id, "工资策略"), Number(body.base_salary || 0), String(body.effective_from || "").slice(0, 10), body.effective_to || null
  ];
  if (!values[3] || !/^\d{4}-\d{2}-\d{2}$/.test(values[7])) badRequest("参保城市和生效日期不能为空");
  if (values[6] < 0) badRequest("底薪不能为负数");
  if (body.id) {
    await mysqlExecute(`UPDATE payroll_profiles SET person_id=?, company_id=?, department=?, employment_city_code=?, contribution_scheme_id=?, policy_id=?, base_salary=?, effective_from=?, effective_to=? WHERE id=?`, [...values, Number(body.id)]);
    return { ok: true, id: Number(body.id) };
  }
  const result = await mysqlExecute(`INSERT INTO payroll_profiles (person_id, company_id, department, employment_city_code, contribution_scheme_id, policy_id, base_salary, effective_from, effective_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, values);
  return { ok: true, id: Number(result.insertId) };
}

function calculateContributions(scheme) {
  const employerRates = jsonObject(scheme.employer_rates_json);
  const employeeRates = jsonObject(scheme.employee_rates_json);
  const employer = {};
  const employee = {};
  for (const key of CONTRIBUTION_KEYS) {
    const base = key === "housing_fund" ? Number(scheme.housing_base_min || 0) : Number(scheme.social_base_min || 0);
    employer[key] = money(base * Number(employerRates[key] || 0));
    employee[key] = money(base * Number(employeeRates[key] || 0));
  }
  return {
    employer,
    employee,
    employerTotal: money(Object.values(employer).reduce((sum, value) => sum + value, 0)),
    employeeTotal: money(Object.values(employee).reduce((sum, value) => sum + value, 0))
  };
}

function calculateStatement(row, override = {}) {
  const components = jsonObject(row.components_json);
  const baseSalary = money(override.base_salary ?? row.base_salary);
  const fixedEarnings = money(["position_allowance", "fixed_allowance", "attendance_bonus"].reduce((sum, key) => sum + Number(override[key] ?? components[key] ?? 0), 0));
  const revenueCommission = money(Number(override.revenue || 0) * Number(components.revenue_commission_rate || 0));
  const distributableProfit = Math.max(0, Number(override.distributable_profit || 0) - Number(components.profit_threshold || 0));
  const profitCommission = money(distributableProfit * Number(components.profit_commission_rate || 0));
  const variableEarnings = money(revenueCommission + profitCommission + ["performance_bonus", "quarterly_bonus", "annual_bonus", "other_earnings"].reduce((sum, key) => sum + Number(override[key] ?? components[key] ?? 0), 0));
  const grossSalary = money(baseSalary + fixedEarnings + variableEarnings);
  const contributions = calculateContributions(row);
  const incomeTax = money(Number(override.income_tax || 0));
  const otherDeductions = money(Number(override.other_deductions || 0));
  const netSalary = money(grossSalary - contributions.employeeTotal - incomeTax - otherDeductions);
  return {
    baseSalary, fixedEarnings, variableEarnings, grossSalary, incomeTax, otherDeductions, netSalary,
    employerTotalCost: money(grossSalary + contributions.employerTotal), contributions,
    evidence: { revenue: Number(override.revenue || 0), revenueCommission, distributableProfit: Number(override.distributable_profit || 0), profitCommission, components }
  };
}

export async function calculatePayrollPeriod(body = {}, personId = null) {
  await ensurePayrollSchema();
  const companyId = requiredId(body.company_id, "公司");
  const month = monthKey(body.month);
  const from = `${month}-01`;
  const overrides = new Map((Array.isArray(body.employee_inputs) ? body.employee_inputs : []).map((item) => [Number(item.person_id), item]));
  const profiles = await mysqlQuery(`SELECT pr.*, pe.name AS person_name, pp.components_json, ps.name AS scheme_name,
      ps.city_code AS scheme_city_code, ps.social_base_min, ps.housing_base_min, ps.employer_rates_json, ps.employee_rates_json
    FROM payroll_profiles pr JOIN people pe ON pe.id=pr.person_id AND pe.active != 0
    JOIN payroll_policies pp ON pp.id=pr.policy_id AND pp.status='active' AND pp.effective_from<=? AND (pp.effective_to IS NULL OR pp.effective_to>=?)
    JOIN payroll_contribution_schemes ps ON ps.id=pr.contribution_scheme_id AND ps.status='active' AND ps.effective_from<=? AND (ps.effective_to IS NULL OR ps.effective_to>=?)
    WHERE pr.company_id=? AND pr.status='active' AND pr.effective_from<=? AND (pr.effective_to IS NULL OR pr.effective_to>=?)
    ORDER BY pe.name`, [from, from, from, from, companyId, from, from]);
  if (!profiles.length) badRequest("当前公司和月份没有有效员工薪酬档案，请先在员工档案中配置工资策略及城市五险一金方案");
  for (const profile of profiles) {
    if (String(profile.employment_city_code) !== String(profile.scheme_city_code)) badRequest(`${profile.person_name}的参保城市与五险一金方案城市不一致，请先修复员工薪酬档案`);
    if (!(Number(profile.social_base_min) > 0) || !(Number(profile.housing_base_min) > 0)) badRequest(`${profile.person_name}使用的五险一金方案缺少最低缴费基数`);
  }
  return withMysqlTransaction(async (connection) => {
    const [existing] = await connection.query("SELECT id, status FROM payroll_periods WHERE company_id=? AND month_key=? LIMIT 1", [companyId, month]);
    if (existing[0]?.status === "locked") badRequest("本月工资已锁定，不能重新计算；请先走调整或解锁流程");
    await connection.execute(`INSERT INTO payroll_periods (company_id, month_key, status, calculated_by, calculated_at) VALUES (?, ?, 'calculated', ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE status='calculated', calculated_by=VALUES(calculated_by), calculated_at=CURRENT_TIMESTAMP`, [companyId, month, personId || null]);
    const [periodRows] = await connection.query("SELECT id FROM payroll_periods WHERE company_id=? AND month_key=? LIMIT 1", [companyId, month]);
    const periodId = Number(periodRows[0].id);
    for (const profile of profiles) {
      const result = calculateStatement(profile, overrides.get(Number(profile.person_id)) || {});
      await connection.execute(`INSERT INTO payroll_statements (period_id, person_id, profile_id, policy_id, contribution_scheme_id, base_salary, fixed_earnings, variable_earnings, gross_salary, employee_contribution, employer_contribution, income_tax, other_deductions, net_salary, employer_total_cost, calculation_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'calculated')
        ON DUPLICATE KEY UPDATE profile_id=VALUES(profile_id), policy_id=VALUES(policy_id), contribution_scheme_id=VALUES(contribution_scheme_id), base_salary=VALUES(base_salary), fixed_earnings=VALUES(fixed_earnings), variable_earnings=VALUES(variable_earnings), gross_salary=VALUES(gross_salary), employee_contribution=VALUES(employee_contribution), employer_contribution=VALUES(employer_contribution), income_tax=VALUES(income_tax), other_deductions=VALUES(other_deductions), net_salary=VALUES(net_salary), employer_total_cost=VALUES(employer_total_cost), calculation_json=VALUES(calculation_json), status='calculated'`,
      [periodId, profile.person_id, profile.id, profile.policy_id, profile.contribution_scheme_id, result.baseSalary, result.fixedEarnings, result.variableEarnings, result.grossSalary, result.contributions.employeeTotal, result.contributions.employerTotal, result.incomeTax, result.otherDeductions, result.netSalary, result.employerTotalCost, JSON.stringify(result)]);
    }
    return { ok: true, period_id: periodId, employee_count: profiles.length };
  });
}

export async function payrollPeriod(query = {}) {
  await ensurePayrollSchema();
  const companyId = requiredId(query.company_id, "公司");
  const month = monthKey(query.month);
  const periods = await mysqlQuery("SELECT * FROM payroll_periods WHERE company_id=? AND month_key=? LIMIT 1", [companyId, month]);
  if (!periods[0]) return { period: null, rows: [], summary: { gross_salary: 0, net_salary: 0, employer_total_cost: 0 } };
  const rows = await mysqlQuery(`SELECT st.*, pe.name AS person_name, pr.department, fc.name AS company_name, ps.name AS scheme_name, ps.city_name, pp.name AS policy_name
    FROM payroll_statements st JOIN people pe ON pe.id=st.person_id JOIN payroll_profiles pr ON pr.id=st.profile_id
    JOIN finance_companies fc ON fc.id=pr.company_id JOIN payroll_contribution_schemes ps ON ps.id=st.contribution_scheme_id
    JOIN payroll_policies pp ON pp.id=st.policy_id WHERE st.period_id=? ORDER BY pe.name`, [periods[0].id]);
  const summary = rows.reduce((acc, row) => {
    acc.gross_salary = money(acc.gross_salary + Number(row.gross_salary || 0));
    acc.net_salary = money(acc.net_salary + Number(row.net_salary || 0));
    acc.employee_contribution = money(acc.employee_contribution + Number(row.employee_contribution || 0));
    acc.employer_contribution = money(acc.employer_contribution + Number(row.employer_contribution || 0));
    acc.employer_total_cost = money(acc.employer_total_cost + Number(row.employer_total_cost || 0));
    return acc;
  }, { gross_salary: 0, net_salary: 0, employee_contribution: 0, employer_contribution: 0, employer_total_cost: 0 });
  return { period: periods[0], rows: rows.map((row) => ({ ...row, calculation: jsonObject(row.calculation_json) })), summary };
}

export async function updatePayrollPeriodStatus(body = {}, personId = null) {
  await ensurePayrollSchema();
  const id = requiredId(body.period_id, "工资批次");
  const action = String(body.action || "");
  const rows = await mysqlQuery("SELECT * FROM payroll_periods WHERE id=? LIMIT 1", [id]);
  if (!rows[0]) badRequest("工资批次不存在");
  if (action === "approve" && rows[0].status === "calculated") {
    await mysqlExecute("UPDATE payroll_periods SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP WHERE id=?", [personId || null, id]);
    await mysqlExecute("UPDATE payroll_statements SET status='approved' WHERE period_id=?", [id]);
  } else if (action === "lock" && rows[0].status === "approved") {
    const totals = await mysqlQuery("SELECT COALESCE(SUM(employer_total_cost),0) AS total FROM payroll_statements WHERE period_id=?", [id]);
    const amount = money(totals[0]?.total);
    await mysqlExecute("UPDATE payroll_periods SET status='locked', locked_by=?, locked_at=CURRENT_TIMESTAMP WHERE id=?", [personId || null, id]);
    await mysqlExecute("UPDATE payroll_statements SET status='locked' WHERE period_id=?", [id]);
    await mysqlExecute(`INSERT INTO finance_expenses (company_id, shop_id, expense_date, category, counterparty, description, currency_code, original_amount, exchange_rate, amount_cny, voucher_status, source_type, source_id, created_by)
      VALUES (?, NULL, LAST_DAY(CONCAT(?, '-01')), 'salary', NULL, ?, 'CNY', ?, 1, ?, 'missing', 'payroll_period', ?, ?)
      ON DUPLICATE KEY UPDATE expense_date=VALUES(expense_date), description=VALUES(description), original_amount=VALUES(original_amount), amount_cny=VALUES(amount_cny), updated_at=CURRENT_TIMESTAMP`,
    [rows[0].company_id, rows[0].month_key, `${rows[0].month_key} 员工工资及公司承担五险一金`, amount, amount, id, personId || null]);
  } else {
    badRequest("工资批次状态不允许执行该操作：试算完成后才能审核，审核后才能锁定");
  }
  return { ok: true };
}

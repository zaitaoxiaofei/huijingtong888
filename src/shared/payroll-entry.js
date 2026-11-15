export const PAYROLL_EMPLOYER_FIELDS = [["pension", "养老"], ["medical", "医疗"], ["supplementary_medical", "附加医疗"], ["unemployment", "失业"], ["injury", "工伤"], ["housing_fund", "公积金"]];
export const PAYROLL_EMPLOYEE_FIELDS = [["pension", "养老"], ["medical", "医疗"], ["unemployment", "失业"], ["housing_fund", "公积金"]];
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const cents = value => Math.round(Number(value) * 100);
export function normalizePayrollEntry(body = {}) {
  const month = String(body.month || "");
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) fail("请选择有效的工资月份");
  const person = String(body.person_name || "").trim(), department = String(body.department || "").trim();
  if (!person || person.length > 128) fail("请填写员工姓名（最多128字）");
  if (department.length > 128) fail("部门名称最多128字");
  const amount = (value, label) => {
    if (!["number","string"].includes(typeof value) || value == null || String(value).trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100000000) fail(`${label}应为有效的非负金额`);
    return cents(value) / 100;
  };
  const parts = (value, fields, label, total) => {
    if (value == null) return { items: null, amount: amount(total ?? 0, label + "合计") };
    if (typeof value !== "object" || Array.isArray(value)) fail(`${label}分项格式无效`);
    const items = Object.fromEntries(fields.map(([key, name]) => [key, amount(value[key], label + name)]));
    return { items, amount: Object.values(items).reduce((sum, value) => sum + cents(value), 0) / 100 };
  };
  const employer = parts(body.employer_items, PAYROLL_EMPLOYER_FIELDS, "单位缴费", body.employer);
  const employee = parts(body.employee_items, PAYROLL_EMPLOYEE_FIELDS, "个人缴费", body.employee);
  const base = amount(body.base, "基本工资"), tax = amount(body.tax ?? 0, "个税");
  const net = (cents(base) - cents(employee.amount) - cents(tax)) / 100;
  if (net < 0) fail("个人缴费与个税合计不能超过基本工资，请核对工资明细");
  return { month, person_name: person, department, category: "salary", base, employer: employer.amount, employee: employee.amount, tax, net,
    employer_items: employer.items, employee_items: employee.items, confirmation: String(body.confirmation || "").trim().slice(0, 500),
    expense_date: new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5,7)), 0)).toISOString().slice(0,10),
    description: `${month}工资 · ${person}`, amount: (cents(base) + cents(employer.amount)) / 100 };
}

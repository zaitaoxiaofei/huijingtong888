import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/payroll.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/server/routes/payroll.js", import.meta.url), "utf8");
const authorization = fs.readFileSync(new URL("../src/server/authorization.js", import.meta.url), "utf8");
const frontend = fs.readFileSync(new URL("../frontend/admin/views/finance/PayrollView.vue", import.meta.url), "utf8");
const router = fs.readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const navigation = fs.readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");

test("payroll schema keeps policies, city contribution versions and immutable period statements separate", () => {
  for (const table of ["payroll_contribution_schemes", "payroll_policies", "payroll_profiles", "payroll_periods", "payroll_statements"]) {
    assert.match(service, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(service, /social_base_min/);
  assert.match(service, /housing_base_min/);
  assert.match(service, /effective_from/);
});

test("payroll calculation separates employee deductions from employer total cost", () => {
  assert.match(service, /netSalary = money\(grossSalary - contributions\.employeeTotal - incomeTax - otherDeductions\)/);
  assert.match(service, /employerTotalCost: money\(grossSalary \+ contributions\.employerTotal\)/);
  assert.match(service, /Math\.max\(0, Number\(override\.distributable_profit/);
});

test("locked payroll creates one idempotent salary expense", () => {
  assert.match(service, /source_type.*payroll_period/s);
  assert.match(service, /ON DUPLICATE KEY UPDATE expense_date=VALUES\(expense_date\)/);
  assert.match(service, /status === "approved"/);
});

test("payroll routes and UI are wired into finance navigation with manager mutation protection", () => {
  assert.match(routes, /GET \/api\/payroll\/setup/);
  assert.match(routes, /POST \/api\/payroll\/calculate/);
  assert.match(authorization, /parts\[1\] === "payroll"/);
  assert.match(router, /path: "finance\/payroll"/);
  assert.match(navigation, /route: "\/finance\/payroll"/);
  assert.match(frontend, /城市最低缴费方案/);
  assert.match(frontend, /工资试算/);
});

test("payroll forms close safely and provide usable Shanghai and store-operation presets", () => {
  assert.match(frontend, /function closeSavedDialog\(url\)/);
  assert.doesNotMatch(frontend, /dialog\.value = false/);
  assert.match(frontend, /SHANGHAI_CONTRIBUTION_PRESET/);
  assert.match(frontend, /social_base_min: 7460/);
  assert.match(frontend, /housing_base_min: 2690/);
  assert.match(frontend, /一键填写上海方案/);
  assert.match(frontend, /快速创建店铺运营策略/);
});

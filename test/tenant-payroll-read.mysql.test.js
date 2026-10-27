import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import mysql from "mysql2/promise";

test("payroll owner reads follow A/B/default company and employee ownership in real isolated MySQL", { skip: !process.env.TENANT_TEST_MYSQL_SOCKET && "Requires isolated named-pipe MySQL" }, async t => {
  const name = `ozon_payroll_read_test_${randomBytes(8).toString("hex")}`;
  assert.match(name, /^ozon_payroll_read_test_[a-f0-9]{16}$/);
  const connection = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: "root", dateStrings: true });
  let created = false;
  try {
    assert.equal(Number((await connection.query("SELECT @@skip_networking AS isolated"))[0][0].isolated), 1);
    await connection.query(`CREATE DATABASE \`${name}\``);
    created = true;
    await connection.changeUser({ database: name });
    const query = async (sql, params = []) => (await connection.execute(sql, Array.from(params)))[0];
    await query("CREATE TABLE tenants(id BIGINT PRIMARY KEY,slug VARCHAR(80),status VARCHAR(32))");
    await query("CREATE TABLE tenant_members(tenant_id BIGINT,person_id BIGINT,active TINYINT DEFAULT 1,PRIMARY KEY(tenant_id,person_id))");
    await query("CREATE TABLE people(id BIGINT PRIMARY KEY,name VARCHAR(255),username VARCHAR(255),role VARCHAR(32),active TINYINT DEFAULT 1)");
    await query("CREATE TABLE finance_companies(id BIGINT PRIMARY KEY,tenant_id BIGINT NULL,name VARCHAR(255),status VARCHAR(32) DEFAULT 'active')");
    const source = readFileSync("src/services/payroll.js", "utf8").replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
    const service = vm.createContext({ mysqlQuery: query, mysqlExecute: query, ensureFinanceCenterSchema: async () => {}, withMysqlTransaction: async work => work(connection) });
    vm.runInContext(source, service);
    await service.ensurePayrollSchema();
    await query("INSERT INTO tenants VALUES(1,'default','active'),(2,'a','active'),(3,'b','active')");
    await query("INSERT INTO people(id,name,username,role) VALUES(10,'Default employee','d','packing'),(20,'A employee','a','operations'),(30,'B private employee','b','procurement')");
    await query("INSERT INTO tenant_members VALUES(1,10,0),(2,20,1),(3,30,1)");
    await query("INSERT INTO finance_companies(id,tenant_id,name) VALUES(10,NULL,'Default legacy'),(11,1,'Default explicit'),(12,0,'Default zero'),(20,2,'A company'),(30,3,'B private company')");
    for (const id of [10, 20, 30]) {
      await query("INSERT INTO payroll_contribution_schemes(id,name,city_code,city_name,employer_rates_json,employee_rates_json,effective_from) VALUES(?,?,'shanghai','上海','{}','{}',?)", [id, `${id} contribution`, `2026-01-${id}`]);
      await query("INSERT INTO payroll_policies(id,name,components_json,effective_from) VALUES(?,?,'{}','2026-01-01')", [id, `${id} policy`]);
      await query("INSERT INTO payroll_profiles(id,person_id,company_id,department,employment_city_code,contribution_scheme_id,policy_id,base_salary,effective_from) VALUES(?,?,?,?,'shanghai',?,?,?,'2026-01-01')", [id, id, id, `${id} department`, id, id, id * 100]);
      await query("INSERT INTO payroll_periods(id,company_id,month_key,status) VALUES(?,?,'2026-10','locked')", [id, id]);
      await query("INSERT INTO payroll_statements(id,period_id,person_id,profile_id,policy_id,contribution_scheme_id,gross_salary,net_salary,employer_total_cost,calculation_json) VALUES(?,?,?,?,?,?,?,?,?,'{}')", [id, id, id, id, id, id, id * 100, id * 90, id * 110]);
    }
    await query("INSERT INTO payroll_profiles(id,person_id,company_id,department,employment_city_code,contribution_scheme_id,policy_id,effective_from) VALUES(21,30,20,'foreign employee poison','shanghai',30,30,'2026-02-01')");
    await query("INSERT INTO payroll_statements(id,period_id,person_id,profile_id,policy_id,contribution_scheme_id,gross_salary,net_salary,employer_total_cost,calculation_json) VALUES(21,20,30,30,30,30,99999,99999,99999,'{}'),(22,20,10,20,20,20,88888,88888,88888,'{}')");
    const foreignBefore = JSON.stringify(await query("SELECT * FROM payroll_statements WHERE person_id=30 ORDER BY id"));
    await t.test("setup exposes own companies and only own profile-linked employee, scheme and policy records", async () => {
      for (const [scope, expected] of [["admin", [10, 11, 12]], ["1", [10, 11, 12]], ["2", [20]], ["3", [30]]]) {
        const setup = await service.payrollSetup(scope);
        assert.deepEqual(Array.from(setup.companies, row => row.id), expected);
        const person = scope === "admin" || scope === "1" ? 10 : Number(scope) * 10;
        assert.deepEqual(Array.from(setup.people, row => row.id), [person]);
        assert.deepEqual(Array.from(setup.profiles, row => row.id), [person]);
        assert.deepEqual(Array.from(setup.schemes, row => row.id), [person]);
        assert.deepEqual(Array.from(setup.policies, row => row.id), [person]);
      }
    });
    await t.test("period totals exclude poisoned foreign profile and person references", async () => {
      const result = await service.payrollPeriod({ company_id: 20, month: "2026-10", tenant_id: 3 }, "2");
      assert.deepEqual(Array.from(result.rows, row => row.id), [20]);
      assert.equal(result.summary.gross_salary, 2000);
      assert.equal(result.summary.net_salary, 1800);
      assert.equal(JSON.stringify(result).includes("B private"), false);
      const historical = await service.payrollPeriod({ company_id: 10, month: "2026-10" }, "admin");
      assert.deepEqual(Array.from(historical.rows, row => row.id), [10], "disabled memberships still retain their own historical company payroll");
      assert.equal((await service.payrollPeriod({ company_id: 11, month: "2026-10" }, "admin")).period, null);
    });
    await t.test("foreign company IDs, missing context and inactive enterprises fail closed", async () => {
      for (const [scope, company] of [["2", 30], ["3", 20], ["admin", 20], ["2", 10]]) await assert.rejects(service.payrollPeriod({ company_id: company, month: "2026-10" }, scope), { statusCode: 404 });
      for (const scope of ["", "unknown", "0", "999"]) await assert.rejects(service.payrollSetup(scope), { statusCode: 403 });
      await query("UPDATE tenants SET status='disabled' WHERE id=2");
      await assert.rejects(service.payrollSetup("2"), { statusCode: 403 });
      await query("UPDATE tenants SET status='active' WHERE id=2");
      assert.equal(JSON.stringify(await query("SELECT * FROM payroll_statements WHERE person_id=30 ORDER BY id")), foreignBefore);
    });
    await t.test("the explicit platform maintenance read retains the prior global surface", async () => {
      const all = await service.payrollSetup(null);
      assert.equal(all.companies.length, 5);
      assert.equal(all.profiles.length, 4);
    });
  } finally {
    if (created) {
      assert.match(name, /^ozon_payroll_read_test_[a-f0-9]{16}$/);
      await connection.query(`DROP DATABASE \`${name}\``);
    }
    await connection.end();
  }
});

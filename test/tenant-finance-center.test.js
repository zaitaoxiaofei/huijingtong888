import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { canAccessPage } from "../src/shared/permissions.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("finance company and shop assignment storage adds nullable tenant ownership with query indexes", () => {
  const service = read("../src/services/finance-center.js");
  const schema = read("../scripts/init-mysql-schema.mjs");
  const migration = read("../scripts/migrate-tenant-finance-center.mjs");
  assert.match(service, /finance_companies \([\s\S]*?tenant_id BIGINT UNSIGNED NULL/);
  assert.match(service, /finance_shop_company_assignments \([\s\S]*?tenant_id BIGINT UNSIGNED NULL/);
  assert.match(service, /idx_finance_company_tenant_status \(tenant_id, status, id\)/);
  assert.match(service, /idx_finance_assignment_tenant_shop_period \(tenant_id, shop_id, effective_from, effective_to\)/);
  assert.match(service, /idx_finance_expense_tenant_company_date \(tenant_id, company_id, expense_date, id\)/);
  assert.match(service, /idx_finance_voucher_tenant_company_date \(tenant_id, company_id, issue_date, id\)/);
  assert.match(service, /idx_finance_period_tenant_company_month \(tenant_id, company_id, month_key\)/);
  assert.match(service, /uk_finance_company_tenant_name \(tenant_id, name\)/);
  assert.match(service, /WHERE tenant_id IS NULL AND name = \?/);
  assert.match(schema, /finance_companies \([\s\S]*?tenant_id BIGINT UNSIGNED NULL/);
  assert.match(migration, /GET_LOCK\('tenant_finance_center_v1'/);
  assert.match(migration, /\["finance_expenses"/);
  assert.match(migration, /\["finance_vouchers"/);
  assert.match(migration, /\["finance_periods"/);
  assert.match(migration, /legacy_rows_reassigned: false/);
  assert.match(migration, /changes_database: false/);
  assert.ok(migration.indexOf("ADD UNIQUE KEY uk_finance_company_tenant_name") < migration.indexOf("DROP INDEX uk_finance_company_name"));
});

test("finance company lists and writes derive scope from the authenticated request", () => {
  const service = read("../src/services/finance-center.js");
  const route = read("../src/server/routes/financeCenter.js");
  assert.match(route, /financeCompanies\(tenantIdFromRequest\(req\)\)/);
  assert.match(route, /saveFinanceCompany\(await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(route, /saveShopCompanyAssignment\(await readJson\(req\), tenantIdFromRequest\(req\)\)/);
  assert.match(route, /financeMonthlyReport\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(route, /financeExpenses\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(route, /saveFinanceExpense\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(route, /saveFinanceVoucher\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(service, /SELECT \* FROM finance_companies WHERE status != 'deleted' \$\{companyFilter\}/);
  assert.match(service, /s\.tenant_id = \?/);
  assert.match(service, /c\.tenant_id = \?/);
  assert.match(service, /a\.tenant_id = \?/);
  assert.match(service, /SELECT id FROM shops WHERE id = \? AND tenant_id = \?/);
  assert.match(service, /SELECT id FROM finance_companies WHERE id = \? AND tenant_id = \?/);
  assert.match(service, /公司档案不存在或不属于当前企业/);
  assert.match(service, /finance_expenses WHERE id=\? AND company_id=\? AND tenant_id=\?/);
  assert.match(service, /finance_vouchers WHERE id=\? AND company_id=\? AND tenant_id=\?/);
  assert.match(service, /企业凭证附件隔离尚未完成/);
  assert.match(service, /a\.tenant_id = \?/);
  assert.match(service, /finance_tenant_shop\.tenant_id = \?/);
});

test("tenant finance routes open only the scoped accounting workflow; shared attachments stay closed", () => {
  const tenant = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["GET", ["api", "finance-center", "companies"]],
    ["POST", ["api", "finance-center", "companies"]],
    ["POST", ["api", "finance-center", "shop-assignments"]],
    ["GET", ["api", "finance-center", "report"]],
    ["GET", ["api", "finance-center", "expenses"]],
    ["GET", ["api", "finance-center", "vouchers"]],
    ["GET", ["api", "finance-center", "platform-items"]],
    ["GET", ["api", "finance-center", "export"]],
    ["POST", ["api", "finance-center", "expenses"]],
    ["POST", ["api", "finance-center", "vouchers"]],
    ["POST", ["api", "finance-center", "close"]],
    ["DELETE", ["api", "finance-center", "expenses", "12"]]
  ]) {
    assert.equal(tenantIsolationDecision(tenant, parts, method).allowed, true, `${method} ${parts.join("/")}`);
    assert.equal(authorizeApiRequest({ method, _session: { roles: ["operator"], tenant: { ...tenant.tenant, role: "owner" } } }, parts).allowed, true);
  }
  assert.equal(tenantIsolationDecision(tenant, ["api", "finance-center", "voucher-attachments"], "POST").allowed, false);
  assert.equal(authorizeApiRequest({ method: "GET", _session: { roles: ["operator"], tenant: { ...tenant.tenant, role: "operator" } } }, ["api", "finance-center", "report"]).allowed, false);
  assert.equal(tenantIsolationDecision(tenant, ["api", "finance-center", "expenses", "all"], "DELETE").allowed, false);
  assert.equal(canAccessPage({ roles: ["operator"], tenant: { ...tenant.tenant, role: "owner" } }, "/finance-center"), true);
  assert.equal(canAccessPage({ roles: ["operator"], tenant: { ...tenant.tenant, role: "operator" } }, "/finance-center"), false);
  assert.equal(canAccessPage({ roles: ["operator"], tenant: { id: 42, slug: "company-a", role: "owner" } }, "/finance/payroll"), false);
});

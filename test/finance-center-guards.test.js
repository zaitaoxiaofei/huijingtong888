import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const service = fs.readFileSync(new URL("../src/services/finance-center.js", import.meta.url), "utf8");
const route = fs.readFileSync(new URL("../src/server/routes/financeCenter.js", import.meta.url), "utf8");
const view = fs.readFileSync(new URL("../frontend/admin/views/finance/FinanceCenterView.vue", import.meta.url), "utf8");
const navigation = fs.readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");

test("finance center keeps company ownership effective-dated", () => {
  assert.match(service, /finance_shop_company_assignments/);
  assert.match(service, /effective_from/);
  assert.match(service, /effective_to/);
  assert.match(service, /上海汇境通国际贸易有限公司/);
  assert.match(service, /合肥鑫瀚电子科技有限公司/);
  assert.match(service, /RUVIBE MART Z/);
  assert.match(service, /VELOAUTO/);
});

test("finance center exposes report, expense, voucher and closing routes", () => {
  assert.match(route, /\/api\/finance-center\/report/);
  assert.match(route, /\/api\/finance-center\/expenses/);
  assert.match(route, /\/api\/finance-center\/vouchers/);
  assert.match(route, /\/api\/finance-center\/close/);
  assert.match(route, /\/api\/finance-center\/voucher-attachments/);
  assert.match(route, /parts\[2\] === "export"/);
});

test("finance center UI includes operating workflow and tax caution", () => {
  assert.match(navigation, /财务中心/);
  assert.match(view, /月度报账/);
  assert.match(view, /凭证中心/);
  assert.match(view, /公司与店铺/);
  assert.match(view, /最终税务处理应由财务人员审核确认/);
  assert.match(view, /上传凭证/);
  assert.match(view, /导出报账包/);
  assert.match(view, /关联 Ozon 平台流水/);
  assert.match(view, /收入对账/);
  assert.match(view, /数据可信度/);
  assert.match(view, /结算净流入/);
});

test("finance overview exposes traceable settlement and completeness metrics", () => {
  assert.match(service, /net_settlement_cashflow/);
  assert.match(service, /revenue_variance/);
  assert.match(service, /missing_cost_items/);
  assert.match(service, /cost_coverage/);
});

test("finance export contains four accounting worksheets", () => {
  assert.match(service, /excelSheet\("月度汇总"/);
  assert.match(service, /excelSheet\("人工费用"/);
  assert.match(service, /excelSheet\("凭证目录"/);
  assert.match(service, /excelSheet\("缺口清单"/);
});

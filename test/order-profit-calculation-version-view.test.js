import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { calculationSnapshotRows, profitVersionSummary, versionReferenceText } from "../frontend/orders/utils/profit-calculation-versions.js";
import { shanghaiDateTimeText } from "../frontend/admin/utils/shanghai-date.js";

const page = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const table = readFileSync(new URL("../frontend/orders/components/OrdersTable.vue", import.meta.url), "utf8");
const versions = readFileSync(new URL("../frontend/orders/components/ProfitCalculationVersions.vue", import.meta.url), "utf8");
const composable = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8");

test("version labels distinguish a legacy baseline, fixed model and mixed versions", () => {
  assert.equal(profitVersionSummary({}).label, "未记录");
  assert.equal(profitVersionSummary({}).legacy, false);
  assert.match(profitVersionSummary({}).tooltip, /尚无版本记录/);
  assert.equal(profitVersionSummary({ profit_formula_versions: "V1" }).legacy, false);
  assert.equal(profitVersionSummary({ profit_formula_versions: "V1", profit_calculation_legacy: 1 }).label, "V1");
  assert.match(profitVersionSummary({ profit_formula_versions: "V1", profit_calculation_legacy: true }).tooltip, /历史基线/);
  assert.equal(profitVersionSummary({ profit_formula_versions: "V1,V2,V1", profit_calculation_legacy: 0 }).label, "多版本");
  assert.doesNotMatch(profitVersionSummary({ profit_formula_versions: "V2", profit_calculation_legacy: "0" }).tooltip, /历史基线/);
  assert.match(profitVersionSummary({ profit_formula_versions: "V2", profit_calculation_legacy: false }).tooltip, /沿用原版本/);
});

test("version evidence keeps numeric zero and formats saved UTC timestamps in Beijing time", () => {
  const rows = calculationSnapshotRows({
    input_completeness: "legacy_unknown",
    item: { quantity: 1, estimated_profit: 0, actual_profit: 0 },
    rate: { effective_from: "2026-10-21T16:00:00Z" }
  }, shanghaiDateTimeText);
  assert.equal(rows.find((row) => row.label === "预估利润").value, "0");
  assert.equal(rows.find((row) => row.label === "真实利润").value, "0");
  assert.match(rows.find((row) => row.label === "生效时间").value, /2026\/10\/22 00:00:00/);
  assert.equal(versionReferenceText({ id: 70, name: "OGL Extra Small", version_no: 1 }), "OGL Extra Small · 1 · #70");
  assert.equal(versionReferenceText(null), "未记录");
  assert.equal(versionReferenceText({ logistics_rule_id: 70 }), "#70");
  assert.deepEqual(calculationSnapshotRows({ product: { logistics_rule_per_gram_cny: 0.0242, logistics_rule_per_ticket_cny: 2.8 } }), [
    { label: "计费每克费", value: "0.0242" }, { label: "计费每票费", value: "2.8" }
  ]);
  assert.deepEqual(calculationSnapshotRows({ input_completeness: "legacy_unknown" }), []);
});

test("list summary keeps zero actual profit and respects an explicit not-ready flag", () => {
  const source = page.match(/function buildProfitSummary\(row\) \{[\s\S]*?\n\}/)?.[0];
  const summary = runInNewContext(`${source}; buildProfitSummary`, {
    splitCsv: (value) => String(value || "").split(",").filter(Boolean), profitVersionSummary
  });
  const row = { estimated_profit: 12, actual_profit: 0, settlement_states: "accrued", profit_statuses: "accrued", profit_formula_versions: "V1" };
  assert.equal(summary(row).actual, 0);
  assert.equal(summary(row).hasActual, true);
  assert.equal(summary({ ...row, actual_profit_ready: 0 }).hasActual, false);
  assert.equal(summary({ ...row, actual_profit_ready: 1 }).effective, 0);
  assert.match(table, /<span v-else>待结算<\/span>/);
});

test("the original profit detail remains above an optional lazy version appendix", () => {
  const appendix = page.indexOf("<summary>计算依据与版本记录</summary>");
  assert.ok(appendix > page.indexOf(':data="detailProfit.rows"'));
  assert.match(page, /defineAsyncComponent\(\(\) => import\("\.\/components\/ProfitCalculationVersions\.vue"\)\)/);
  assert.match(page, /v-if="profitVersionsExpanded"/);
  assert.match(page, /profitVersionsExpanded = ref\(false\)/);
  assert.match(page, /:payload="detailDialog\.data\?\.profit_calculation_versions/);
  for (const label of ["预估金额", "真实金额", "差异", "说明"]) assert.ok(page.includes(`label="${label}"`));
  assert.match(page, /@click="handleRecalculate\(detailDialog\.orderId\)"/);
  assert.match(page, /detailOrder\.loss_formula_text/);
  assert.match(versions, /v-if="expandedRevisions\[/);
  assert.match(versions, /历史输入未完整留存/);
  assert.doesNotMatch(versions, /apiClient|fetch\(|recalculate|可重演/);
  assert.match(versions, /shanghaiDateTimeText/);
});

function optionsLoader(apiClient) {
  const vm = { filters: { shopId: "1", dateFrom: "2026-10-01", dateTo: "2026-10-21", logisticsCarrier: "ogl" }, logisticsServiceClassOptions: [] };
  const source = composable.match(/  async function loadLogisticsOptions\([\s\S]*?\n  \}\n\n  function selectedIdsInCurrentRowOrder/)?.[0].replace(/\n\n  function selectedIdsInCurrentRowOrder$/, "");
  const load = new Function("apiClient", "vm", "patch", "buildOrdersParams", `
    const logisticsOptionsCache = new Map();
    const logisticsOptionsPromise = { value: null }, logisticsOptionsAbort = { value: null }, logisticsOptionsRequestKey = { value: '' };
    const LOGISTICS_OPTIONS_CACHE_TTL_MS = 600000, ORDERS_LIST_CACHE_MAX_ENTRIES = 30;
    const DEFAULT_LOGISTICS_SERVICE_CLASS_OPTIONS = [{ value: 'all', label: '全部渠道' }];
    ${source}; return loadLogisticsOptions;
  `)(apiClient, vm, (payload) => Object.assign(vm, payload), (filters, extra) => new URLSearchParams({ ...filters, ...extra }));
  return { vm, load };
}

test("service class options cache is isolated by shop, dates and carrier", async () => {
  const calls = [];
  const { vm, load } = optionsLoader({ get: async (url) => {
    calls.push(url);
    return { logisticsServiceClassOptions: [{ value: "all", label: url }] };
  } });
  await load();
  await load();
  assert.equal(calls.length, 1);
  vm.filters.logisticsCarrier = "guoo";
  await load();
  vm.filters.shopId = "2";
  await load();
  vm.filters.dateTo = "2026-10-20";
  await load();
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => url.includes("logisticsServiceClass=all")));
  assert.match(composable, /logisticsServiceClass: String\(filters\.logisticsServiceClass \|\| "all"\)/);
});

test("late option responses cannot replace the newly selected carrier context", async () => {
  const pending = [];
  const { vm, load } = optionsLoader({ get: (url, options) => new Promise((resolve) => pending.push({ resolve, url, options })) });
  const first = load();
  vm.filters.logisticsCarrier = "guoo";
  const second = load();
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve({ logisticsServiceClassOptions: [{ value: "small", label: "Small" }] });
  await second;
  pending[0].resolve({ logisticsServiceClassOptions: [{ value: "big", label: "Big" }] });
  await first;
  assert.equal(vm.logisticsServiceClassOptions[0].value, "small");
});

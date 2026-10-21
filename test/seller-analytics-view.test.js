import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { isSellerAnalyticsStoreMismatch, isSellerAnalyticsValidationReady, waitForSellerAnalyticsPreparation } from "../frontend/admin/utils/seller-analytics-recognition.js";

const viewSource = () => fs.readFileSync("frontend/admin/views/analytics/SellerAnalyticsView.vue", "utf8");
const routerSource = () => fs.readFileSync("frontend/admin/router/index.js", "utf8");
const shellSource = () => fs.readFileSync("scripts/generate-admin-shell.mjs", "utf8");

async function checkCollectionReadiness(storeCheck, validation) {
  const source = viewSource();
  const ready = source.slice(source.indexOf("async function ensureCollectReady()"), source.indexOf("async function bindCurrentShopAuth()"));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const alerts = [];
  const prepareFlow = {};
  let prepared = 0;
  let elapsed = 0;
  const context = {
    requireAnalyticsPluginInstance: async () => true,
    selectedStoreId: { value: "4202503" },
    checkCurrentShopViaPlugin: async () => storeCheck,
    loadPluginValidation: async () => validation,
    isSellerAnalyticsValidationReady,
    isSellerAnalyticsStoreMismatch,
    prepareFlow,
    ElMessageBox: { alert: async (message, title) => { alerts.push({ message, title }); } },
    ElMessage: { info() {}, warning() {} },
    prepareSellerAnalyticsPlugin: async () => { prepared++; return { id: "new-request" }; },
    state: { filters: { shopId: "erp-shop" } },
    selectedShop: { value: { name: "Shop" } },
    pluginInstanceId: { value: "browser-instance" },
    wakeAnalyticsPlugin() {},
    waitForSellerAnalyticsPreparation: (options) => waitForSellerAnalyticsPreparation({ ...options, now: () => elapsed, timeoutMs: 6000 }),
    wait: async (ms) => { elapsed += ms; },
    loadPluginStatus: async () => {},
    loadAuthBindingStatus: async () => {},
    localPluginSetupHint: { value: "" }
  };
  const accepted = await new AsyncFunction(...Object.keys(context), `${ready}\nreturn ensureCollectReady();`)(...Object.values(context));
  return { accepted, prepared, alerts, prepareFlow };
}

function preparedValidation(overrides = {}) {
  return {
    ok: true,
    plugin_online: true,
    current_company_id: "4202503",
    code: "ready",
    prepare_request: { id: "new-request", status: "ready", current_company_id: "4202503" },
    ...overrides
  };
}

test("older plugins without live store checks use the existing prepare handshake", async () => {
  for (const storeCheck of [null, { ok: false, code: "check_failed", error: "REALTIME_TIMEOUT" }]) {
    const result = await checkCollectionReadiness(storeCheck, preparedValidation());
    assert.equal(result.accepted, true);
    assert.equal(result.prepared, 1);
    assert.deepEqual(result.alerts, []);
  }
});

test("legacy readiness still blocks offline, unclaimed, and mismatched store results", async () => {
  const validations = [
    preparedValidation({ plugin_online: false }),
    preparedValidation({ prepare_request: { id: "new-request", status: "pending" } }),
    preparedValidation({ ok: false, code: "company_mismatch", current_company_id: "3570178", prepare_request: { id: "new-request", status: "mismatch", current_company_id: "3570178" } })
  ];
  for (const validation of validations) {
    const result = await checkCollectionReadiness(null, validation);
    assert.equal(result.accepted, false);
    assert.equal(result.prepared, 1);
    assert.equal(result.alerts.length, 1);
    assert.doesNotMatch(result.alerts[0].message, /最新版|需要更新/);
  }
});

test("missing identity asks for recognition without claiming the user chose a wrong store", async () => {
  const result = await checkCollectionReadiness(null, preparedValidation({
    ok: false,
    code: "store_identity_unverified",
    current_company_id: "",
    prepare_request: { id: "new-request", status: "failed", error: "STORE_IDENTITY_UNVERIFIED" }
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.prepareFlow.tone, "warning");
  assert.equal(result.alerts[0].title, "暂时不能启动采集");
  assert.match(result.alerts[0].message, /身份信息还未读取完整/);
  assert.doesNotMatch(result.alerts[0].message, /切换|未对齐/);
});

test("a confirmed live store conflict blocks before queueing a prepare request", async () => {
  const result = await checkCollectionReadiness({ ok: false, code: "store_mismatch", cookieCompanyId: "3570178" }, preparedValidation());
  assert.equal(result.accepted, false);
  assert.equal(result.prepared, 0);
  assert.equal(result.alerts[0].title, "店铺未对齐");
});

async function checkPluginConnection({ download = false, metadataUnavailable = false } = {}) {
  const source = viewSource();
  const requireInstance = source.slice(source.indexOf("async function requireAnalyticsPluginInstance()"), source.indexOf("async function recognizeCurrentShop()"));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const prompts = [];
  const downloads = [];
  const context = {
    pluginInstanceId: { value: "" },
    requestPluginInstance() {},
    wait: async () => {},
    apiClient: { get: async () => {
      if (metadataUnavailable) throw new Error("NETWORK_ERROR");
      return { analytics_plugin: { version: "1.0.34", download_url: "/plugin.rar" } };
    } },
    ElMessageBox: { confirm: async (message, title, options) => {
      prompts.push({ message, title, options });
      if (!download) throw new Error("cancel");
    } },
    window: { open: (url) => downloads.push(url) }
  };
  const connected = await new AsyncFunction(...Object.keys(context), `${requireInstance}\nreturn requireAnalyticsPluginInstance();`)(...Object.values(context));
  return { connected, prompts, downloads };
}

test("an unanswered instance message prompts connection troubleshooting without automatic downloads", async () => {
  const result = await checkPluginConnection();
  assert.equal(result.connected, false);
  assert.equal(result.downloads.length, 0);
  assert.equal(result.prompts[0].title, "分析插件暂未连通");
  assert.match(result.prompts[0].message, /ERP 地址与登录令牌/);
  assert.doesNotMatch(result.prompts[0].message, /请下载并安装|未检测到.*1\.0\.34/);
  assert.equal(result.prompts[0].options.confirmButtonText, "下载插件（可选）");
});

test("plugin download requires the user's optional download choice", async () => {
  const result = await checkPluginConnection({ download: true });
  assert.deepEqual(result.downloads, ["/plugin.rar"]);
});

test("download metadata failure still allows plugin connection troubleshooting", async () => {
  const result = await checkPluginConnection({ metadataUnavailable: true });
  assert.equal(result.connected, false);
  assert.equal(result.prompts.length, 1);
  assert.equal(result.prompts[0].options.confirmButtonText, "知道了");
  assert.deepEqual(result.downloads, []);
});

test("seller analytics route is lazy-loaded so the admin shell can start quickly", () => {
  const router = routerSource();
  const shell = shellSource();

  assert.doesNotMatch(router, /import SellerAnalyticsView from "\.\.\/views\/analytics\/SellerAnalyticsView\.vue"/);
  assert.match(router, /const SellerAnalyticsView = \(\) => import\("\.\.\/views\/analytics\/SellerAnalyticsView\.vue"\)/);
  assert.doesNotMatch(shell, /routePreloadSources|SellerAnalyticsView\.vue/);
  assert.match(shell, /loadingHint: "\\u6b63\\u5728\\u52a0\\u8f7d\\u7cfb\\u7edf\\u8d44\\u6e90/);
});

test("seller analytics page has local product pagination controls", () => {
  const source = viewSource();

  assert.match(source, /import PageFooterPagination/);
  assert.match(source, /<PageFooterPagination/);
  assert.match(source, /class="seller-global-footer"/);
  assert.match(source, /:page-size="state\.pageSize"/);
  assert.match(source, /:page-sizes="ANALYTICS_PAGE_SIZE_OPTIONS"/);
  assert.match(source, /:total="totalProductCount"/);
  assert.match(source, /@update:page="handlePageChange"/);
  assert.match(source, /@update:pageSize="handlePageSizeChange"/);
  assert.doesNotMatch(source, /<el-pagination/);
  assert.doesNotMatch(source, /seller-table-actions--pagination/);
});

test("seller analytics keeps collection logs out of the client workbench", () => {
  const source = viewSource();

  assert.doesNotMatch(source, /<el-tab-pane label="回传快照" name="snapshots">/);
  assert.doesNotMatch(source, /<el-tab-pane label="采集批次" name="runs">/);
  assert.doesNotMatch(source, /label="最近回传"/);
});

test("seller analytics default workbench separates overview actions and metric details", () => {
  const source = viewSource();

  assert.match(source, /const activePane = ref\("metrics"\)/);
  assert.match(source, /class="seller-ozon-overview"/);
  assert.match(source, /overviewFunnelStages/);
  assert.match(source, /class="seller-workspace-scroll"/);
  assert.match(source, /<el-tab-pane label="商品诊断" name="diagnosis"/);
  assert.match(source, /<el-tab-pane label="行动项" name="actions"/);
  assert.match(source, /<el-tab-pane label="指标明细" name="metrics"/);
  assert.match(source, /:deep\(#tab-metrics\) \{ order: 1; \}/);
  assert.match(source, /:deep\(#tab-actions\) \{ order: 2; \}/);
  assert.match(source, /:deep\(#tab-diagnosis\) \{ order: 3; \}/);
  assert.match(source, /:deep\(#tab-recommendations\) \{ order: 4; \}/);
  assert.doesNotMatch(source, /overviewCards/);
  assert.doesNotMatch(source, /seller-overview-card/);
  assert.doesNotMatch(source, /seller-summary-grid/);
  assert.doesNotMatch(source, /seller-period-hint/);
});

test("seller analytics metric details use revenue default and server-side column sorting", () => {
  const source = viewSource();

  assert.match(source, /sortKey:\s*"metric:revenue"/);
  assert.match(source, /function metricSortProp/);
  assert.match(source, /function compactMetricSortProp/);
  assert.match(source, /function handleSortChange/);
  assert.match(source, /@sort-change="handleSortChange"/);
  assert.match(source, /:default-sort="\{ prop: state\.sortKey/);
  assert.match(source, /v-for="column in visibleTableMetricColumns"/);
  assert.match(source, /:prop="column\.sortProp"/);
  assert.match(source, /sortable="custom"/);
  assert.match(source, /prop="score" sortable="custom"/);
});

test("seller analytics workbench keeps filters tabs and table headers fixed", () => {
  const source = viewSource();

  assert.match(source, /class="seller-sticky-head"/);
  assert.match(source, /\.seller-sticky-head \{[^}]*position: sticky/);
  assert.match(source, /<ErpFilterBar class="seller-toolbar">[\s\S]*class="seller-toolbar__filters"[\s\S]*class="seller-toolbar__query"[\s\S]*class="seller-filter seller-filter--source"[\s\S]*class="seller-toolbar__divider"[\s\S]*class="seller-toolbar__collect"/);
  assert.match(source, /<ErpPageHeader compact title="数据分析"/);
  assert.match(source, /\.seller-analytics-page \{[^}]*overflow: hidden/);
  assert.match(source, /\.seller-workspace-scroll \{[^}]*overflow: hidden/);
  assert.match(source, /\.seller-toolbar \{[^}]*display: flex/);
  assert.match(source, /\.seller-toolbar \{[^}]*overflow: visible/);
  assert.match(source, /\.seller-toolbar \{[^}]*flex-wrap: wrap/);
  assert.match(source, /\.seller-toolbar__divider \{[^}]*width: 1px/);
  assert.match(source, /\.seller-source-tabs \{[^}]*overflow-x: auto/);
  assert.match(source, /\.seller-source-tabs--inline \{[^}]*height: 32px/);
  assert.match(source, /\.seller-source-tabs button \{[^}]*height: 32px/);
  assert.match(source, /\.seller-tabs :deep\(\.el-table\) \{ height: 100% !important; \}/);
  assert.match(source, /\.seller-tabs :deep\(\.el-table__header-wrapper\)/);
});

test("seller analytics shop filter refreshes and is sent to analysis APIs", () => {
  const source = viewSource();

  assert.match(source, /import \{ useAuthStore \} from "\.\.\/\.\.\/stores\/auth"/);
  assert.match(source, /const FILTER_CACHE_KEY_PREFIX = "ozon-erp:seller-analytics:filters"/);
  assert.match(source, /function filterCacheKey\(\)/);
  assert.match(source, /const userKey = String\(user\.id \|\| user\.person_id \|\| user\.username \|\| user\.name \|\| "anonymous"\)/);
  assert.match(source, /v-model="state\.filters\.shopId"[^>]*@change="handleShopChange"/);
  assert.match(source, /async function handleShopChange\([\s\S]*?handleSearch\(\)/);
  assert.match(source, /const selectedStoreId = computed/);
  assert.match(source, /function getShopSellerStoreId/);
  assert.match(source, /const source = shop \|\| \{\};/);
  assert.match(source, /function normalizeShopOption/);
  assert.match(source, /if \(cached\.shopId\) state\.filters\.shopId = String\(cached\.shopId\)/);
  assert.match(source, /tabKey: state\.filters\.tabKey/);
  assert.match(source, /keyword: state\.filters\.keyword/);
  assert.match(source, /activePane: activePane\.value/);
  assert.match(source, /if \(state\.filters\.shopId && !shops\.value\.some/);
  assert.match(source, /shopLabel/);
  assert.match(source, /ozon_client_id/);
  assert.match(source, /store_id:\s*selectedStoreId\.value/);
  assert.match(source, /getSellerAnalyticsSnapshots\(\{[\s\S]*store_id:\s*selectedStoreId\.value/);
  assert.match(source, /getSellerAnalyticsCollectRuns\(\{[\s\S]*store_id:\s*selectedStoreId\.value/);
  assert.match(source, /shop_id:\s*state\.filters\.shopId/);
  assert.match(source, /company_id:\s*selectedStoreId\.value/);
});

test("seller analytics verifies the current plugin store before reusing a binding or creating a collect run", () => {
  const source = viewSource();
  const ready = source.slice(source.indexOf("async function ensureCollectReady()"), source.indexOf("async function bindCurrentShopAuth()"));

  assert.match(ready, /await checkCurrentShopViaPlugin\(expectedStoreId\)/);
  assert.match(ready, /storeCheck\.code === "store_mismatch" \|\| storeCheck\.code === "identity_conflict"/);
  assert.ok(ready.indexOf("await checkCurrentShopViaPlugin(expectedStoreId)") < ready.indexOf("await loadPluginValidation()"));
  assert.match(ready, /await waitForSellerAnalyticsPreparation\(\{/);
  assert.match(ready, /requestId: queued\?\.data\?\.id \|\| queued\?\.id/);
  assert.match(ready, /if \(result\.status === "ready"\)/);
  assert.match(ready, /if \(selectedStoreId\.value !== expectedStoreId\) return false;[\s\S]*?return true;/);
});

test("seller analytics period presets stay synchronized with the visible date range", () => {
  const source = viewSource();

  assert.match(source, /import \{ getAnalyticsPeriodDateRange \}/);
  assert.match(source, /const presetRange = getAnalyticsPeriodDateRange\(state\.filters\.periodKey\)/);
  assert.match(source, /if \(presetRange\) state\.filters\.dateRange = presetRange/);
  assert.match(source, /@change="handlePeriodChange"/);
});

test("seller analytics recommendation table normalizes sparse rows before rendering", () => {
  const source = viewSource();

  assert.match(source, /const recommendationRows = computed/);
  assert.match(source, /recommendationKey/);
  assert.match(source, /product_name: row\.product_name \|\| row\.productName \|\| row\.title \|\| ""/);
  assert.match(source, /<el-table :data="recommendationRows" height="100%">/);
  assert.match(source, /未命名商品/);
});

test("seller analytics diagnosis rows use compact recommendation summaries", () => {
  const source = viewSource();

  assert.match(source, /function topRecommendation/);
  assert.match(source, /function recommendationTooltipText/);
  assert.match(source, /class="seller-rec-summary"/);
  assert.match(source, /\.seller-product-table--compact :deep\(\.el-table__row\) \{ height: 58px; \}/);
});

test("seller analytics funnel tooltips are only rendered for visible rates", () => {
  const source = viewSource();

  assert.doesNotMatch(source, /<el-tooltip v-for="rate[^>]+:disabled="!isVisibleFunnelRate\(rate\)"/);
  assert.match(source, /<template v-for="rate in \[funnel\.rateByKey\.exposureOrder/);
  assert.match(source, /<el-tooltip v-if="isVisibleFunnelRate\(rate\)"/);
});

test("seller analytics next collect page does not depend on the local view page", () => {
  const source = viewSource();

  assert.match(source, /const nextCollectPage = computed/);
  assert.match(source, /page:\s*targetPage/);
  assert.doesNotMatch(source, /state\.page\s*=\s*page;\s*\n\s*await handleCollect\(\)/);
  assert.match(source, /async function collectNextPage\(\) \{\s*await handleCollect\(nextCollectPage\.value\)/);
});

test("seller analytics has a full-store auto collect action", () => {
  const source = viewSource();

  assert.match(source, /async function collectFullStore/);
  assert.match(source, /auto_all_pages:\s*true/);
  assert.match(source, /full_store:\s*true/);
  assert.match(source, /全店自动采集/);
  assert.match(source, /@click="collectFullStore"/);
});

test("seller analytics shows persistent collect completion status for current shop", () => {
  const source = viewSource();

  assert.match(source, /const latestCurrentPeriodRun = computed/);
  assert.match(source, /const collectStatus = computed/);
  assert.match(source, /当前店铺采集完成/);
  assert.match(source, /await loadRunsMeta\(true\)/);
  assert.match(source, /class="seller-sync-assistant__progress"/);
  assert.match(source, /class="seller-sync-assistant__progress-row" :class="`seller-sync-assistant__progress-row--\$\{collectStatus\.tone\}`"/);
  assert.match(source, /ElMessage\.success\("当前店铺采集完成/);
  assert.doesNotMatch(source, /已采集 \${summary\.value\.collectedPageCount/);
});

test("seller analytics can create daily 7d and 28d full-store collect runs", () => {
  const source = viewSource();

  assert.match(source, /const DAILY_SYNC_PERIOD_KEYS = \["7d", "28d"\]/);
  assert.match(source, /function buildCollectPayload/);
  assert.match(source, /createPluginCollectRun\(buildCollectPayload/);
  assert.match(source, /async function createPluginCollectRun/);
  assert.match(source, /store_id:\s*selectedStoreId\.value/);
  assert.match(source, /company_id:\s*selectedStoreId\.value/);
  assert.match(source, /async function collectDailyDefaultPeriods/);
  assert.match(source, /for \(const periodKey of DAILY_SYNC_PERIOD_KEYS\)/);
  assert.match(source, /createPluginCollectRun\(buildCollectPayload/);
  assert.match(source, /period_key:\s*periodKey/);
  assert.match(source, /auto_all_pages:\s*true/);
  assert.match(source, /full_store:\s*true/);
  assert.match(source, /已创建近 7 天和近 28 天全店同步批次/);
  assert.match(source, /@click="collectFullStore"/);
});

test("seller analytics verifies plugin store alignment before starting collection", () => {
  const source = viewSource();

  assert.match(source, /getSellerAnalyticsPluginStatus/);
  assert.match(source, /validateSellerAnalyticsPluginStatus/);
  assert.match(source, /async function ensureCollectReady/);
  assert.match(source, /const skipPluginValidation = computed/);
  assert.match(source, /localhost\|127\\\.0\\\.0\\\.1/);
  assert.match(source, /await checkCurrentShopViaPlugin\(expectedStoreId\)/);
  assert.doesNotMatch(source, /if \(skipPluginValidation\.value\) return true;/);
  assert.match(source, /ElMessageBox\.alert/);
  assert.match(source, /if \(!\(await ensureCollectReady\(\)\) \|\| selectedStoreId\.value !== expectedStoreId \|\| state\.filters\.shopId !== expectedShopId\) return;/);
  assert.match(source, /店铺未对齐/);
});

test("seller analytics table uses Ozon ERP metric groups and source tab metric sets", () => {
  const source = viewSource();

  assert.match(source, /const metricGroups = \[/);
  assert.match(source, /const metricKeysBySourceTab = \{/);
  assert.match(source, /const visibleMetricGroups = computed/);
  assert.match(source, /const compactMetricColumns = \[/);
  assert.match(source, /label: "销售"/);
  assert.match(source, /label: "流量搜索"/);
  assert.match(source, /label: "商品卡片"/);
  assert.match(source, /label: "成交质量"/);
  assert.match(source, /const visibleTableMetricColumns = computed/);
  assert.match(source, /v-for="column in visibleTableMetricColumns"/);
  assert.doesNotMatch(source, /v-for="group in visibleMetricGroups"/);
  assert.doesNotMatch(source, /v-for="metric in group\.children"/);
});

test("seller analytics metric table keeps diagnosis explanation after sortable metrics", () => {
  const source = viewSource();
  const paneStart = source.indexOf('<el-tab-pane label="指标明细" name="metrics"');
  const metricsPane = source.slice(paneStart, source.indexOf('</el-tab-pane>', paneStart));
  const salesIndex = metricsPane.indexOf('v-for="column in visibleTableMetricColumns"');
  const diagnosisIndex = metricsPane.indexOf('label="诊断"');
  const adviceIndex = metricsPane.indexOf('label="优化建议"');

  assert.ok(salesIndex > 0);
  assert.ok(diagnosisIndex > salesIndex);
  assert.ok(adviceIndex > diagnosisIndex);
  assert.match(metricsPane, /recommendationTooltipText\(row\)/);
  assert.match(metricsPane, /popper-class="seller-rec-tooltip"/);
});

test("seller analytics product table includes the Ozon ERP totals row", () => {
  const source = viewSource();

  assert.match(source, /const tableProducts = computed/);
  assert.match(source, /\? \[analysis\.value\.totalsRow, \.\.\.products\.value\]/);
  assert.match(source, /:data="tableProducts"/);
});

test("seller analytics action issue distribution has Ozon ERP hover popup and tone colors", () => {
  const source = viewSource();

  assert.match(source, /const actionInsights = computed/);
  assert.match(source, /const selectedIssueInsight = reactive/);
  assert.match(source, /seller-action-bar--\$\{item\.tone\}/);
  assert.match(source, /<el-tooltip[\s\S]*seller-action-tooltip/);
  assert.match(source, /@click="openIssueInsight\(item\)"/);
  assert.match(source, /<el-dialog[\s\S]*selectedIssueInsight\.visible/);
  assert.match(source, /seller-focus-modal-product/);
});

test("seller analytics zero-count action issues do not show colored progress", () => {
  const source = viewSource();

  assert.match(source, /v-if="Number\(item\.count \|\| 0\) > 0"/);
  assert.match(source, /seller-action-bar--empty/);
  assert.doesNotMatch(source, /Math\.max\(3, Math\.round\(\(Number\(item\.count \|\| 0\)/);
});

test("seller analytics issue modal separates recommendation items with colored types", () => {
  const source = viewSource();

  assert.match(source, /function recommendationTone/);
  assert.match(source, /seller-rec-item--\$\{recommendationTone\(rec\)\}/);
  assert.match(source, /<el-tag[\s\S]*:type="recommendationTagType\(rec\)"/);
  assert.match(source, /class="seller-rec-item__body"/);
  assert.match(source, /class="seller-rec-item__evidence"/);
});

test("seller analytics behavior funnel modal retains Ozon ERP rate details", () => {
  const source = viewSource();

  assert.match(source, /function getProductFunnelStages/);
  assert.match(source, /function getProductFunnelRates/);
  assert.match(source, /function formatFunnelRate/);
  assert.match(source, /v-model="funnelDialog\.visible"/);
  assert.match(source, /productFunnelData\(funnelDialog\.row\)/);
  assert.match(source, /class="seller-funnel"/);
  assert.match(source, /曝光点击率/);
  assert.match(source, /点击加购率/);
  assert.match(source, /点击转化率/);
  assert.match(source, /曝光转化率/);
  assert.match(source, /加购转化率/);
  assert.match(source, /路径：曝光 → 点击 → 加购 → 下单 → 复购/);
  assert.match(source, /复购来自本地订单中同一客户重复购买的识别结果/);
  assert.doesNotMatch(source, /<el-button v-else link type="primary" @click="showFunnel\(row\)">查看漏斗<\/el-button>/);
});

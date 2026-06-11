import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const viewSource = () => fs.readFileSync("frontend/admin/views/analytics/SellerAnalyticsView.vue", "utf8");
const routerSource = () => fs.readFileSync("frontend/admin/router/index.js", "utf8");
const shellSource = () => fs.readFileSync("scripts/generate-admin-shell.mjs", "utf8");

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
  assert.match(source, /:page-size="ANALYTICS_PAGE_SIZE"/);
  assert.match(source, /:total="totalProductCount"/);
  assert.match(source, /@update:page="handlePageChange"/);
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
  assert.match(source, /:prop="compactMetricSortProp\(column\)"/);
  assert.match(source, /sortable="custom"/);
  assert.match(source, /prop="score" sortable="custom"/);
});

test("seller analytics workbench keeps filters tabs and table headers fixed", () => {
  const source = viewSource();

  assert.match(source, /class="seller-sticky-head"/);
  assert.match(source, /\.seller-sticky-head \{[^}]*position: sticky/);
  assert.match(source, /<section class="seller-toolbar">[\s\S]*class="seller-toolbar__filters"[\s\S]*class="seller-toolbar__query"[\s\S]*class="seller-toolbar__divider"[\s\S]*class="seller-source-tabs seller-source-tabs--inline"[\s\S]*class="seller-toolbar__collect"/);
  assert.doesNotMatch(source, /<section class="seller-source-tabs">/);
  assert.match(source, /\.seller-analytics-page \{[^}]*overflow: hidden/);
  assert.match(source, /\.seller-workspace-scroll \{[^}]*overflow: hidden/);
  assert.match(source, /\.seller-toolbar \{[^}]*display: flex/);
  assert.match(source, /\.seller-toolbar \{[^}]*overflow-x: auto/);
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
  assert.match(source, /v-model="state\.filters\.shopId"[^>]*@change="handleSearch"/);
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
  assert.match(source, /采集第 \{\{ nextCollectPage \}\} 页/);
  assert.doesNotMatch(source, /采集下一页（第 \{\{ nextCollectPage \}\} 页）/);
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
  assert.match(source, /class="seller-collect-panel"/);
  assert.match(source, /class="seller-collect-status"/);
  assert.match(source, /ElMessage\.success\("当前店铺采集完成/);
  assert.doesNotMatch(source, /已采集 \${summary\.value\.collectedPageCount/);
});

test("seller analytics can create daily 7d and 28d full-store collect runs", () => {
  const source = viewSource();

  assert.match(source, /const DAILY_SYNC_PERIOD_KEYS = \["7d", "28d"\]/);
  assert.match(source, /function buildCollectPayload/);
  assert.match(source, /startSellerAnalyticsDirectCollect/);
  assert.match(source, /async function createCollectRunAndStartDirect/);
  assert.match(source, /store_id:\s*selectedStoreId\.value/);
  assert.match(source, /company_id:\s*selectedStoreId\.value/);
  assert.match(source, /async function collectDailyDefaultPeriods/);
  assert.match(source, /for \(const periodKey of DAILY_SYNC_PERIOD_KEYS\)/);
  assert.match(source, /createCollectRunAndStartDirect\(buildCollectPayload/);
  assert.match(source, /period_key:\s*periodKey/);
  assert.match(source, /auto_all_pages:\s*true/);
  assert.match(source, /full_store:\s*true/);
  assert.match(source, /同步 7天\+28天/);
  assert.match(source, /@click="collectDailyDefaultPeriods"/);
});

test("seller analytics verifies plugin store alignment before starting collection", () => {
  const source = viewSource();

  assert.match(source, /getSellerAnalyticsPluginStatus/);
  assert.match(source, /validateSellerAnalyticsPluginStatus/);
  assert.match(source, /async function ensureCollectReady/);
  assert.match(source, /const skipPluginValidation = computed/);
  assert.match(source, /localhost\|127\\\.0\\\.0\\\.1/);
  assert.match(source, /if \(skipPluginValidation\.value\) return true;/);
  assert.match(source, /本地环境已跳过校验/);
  assert.match(source, /ElMessageBox\.alert/);
  assert.match(source, /if \(!\(await ensureCollectReady\(\)\)\) return;/);
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
  assert.match(source, /v-for="column in compactMetricColumns"/);
  assert.doesNotMatch(source, /v-for="group in visibleMetricGroups"/);
  assert.doesNotMatch(source, /v-for="metric in group\.children"/);
});

test("seller analytics metric table keeps diagnosis explanation in hover and pushes source metadata later", () => {
  const source = viewSource();
  const metricsPane = source.slice(source.indexOf('<el-tab-pane label="指标明细" name="metrics">'));
  const funnelIndex = metricsPane.indexOf('label="行为漏斗"');
  const salesIndex = metricsPane.indexOf('v-for="column in compactMetricColumns"');
  const diagnosisIndex = metricsPane.indexOf('label="诊断"');
  const onlineIndex = metricsPane.indexOf('label="在线商品"');
  const sourceIndex = metricsPane.indexOf('label="来源"');

  assert.ok(funnelIndex > 0);
  assert.ok(salesIndex > funnelIndex);
  assert.ok(diagnosisIndex > salesIndex);
  assert.ok(onlineIndex > diagnosisIndex);
  assert.ok(sourceIndex > onlineIndex);
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

test("seller analytics behavior funnel mirrors Ozon ERP list and modal display", () => {
  const source = viewSource();

  assert.match(source, /function getProductFunnelStages/);
  assert.match(source, /function getProductFunnelRates/);
  assert.match(source, /function formatFunnelRate/);
  assert.match(source, /class="seller-funnel-button"/);
  assert.match(source, /class="seller-funnel seller-funnel--compact"/);
  assert.match(source, /曝光点击率/);
  assert.match(source, /点击加购率/);
  assert.match(source, /点击转化率/);
  assert.match(source, /曝光转化率/);
  assert.match(source, /加购转化率/);
  assert.match(source, /路径：曝光 → 点击 → 加购 → 下单 → 复购/);
  assert.match(source, /复购来自本地订单中同一客户重复购买的识别结果/);
  assert.doesNotMatch(source, /<el-button v-else link type="primary" @click="showFunnel\(row\)">查看漏斗<\/el-button>/);
});

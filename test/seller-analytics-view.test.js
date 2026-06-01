import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const viewSource = () => fs.readFileSync("frontend/admin/views/analytics/SellerAnalyticsView.vue", "utf8");

test("seller analytics page has local product pagination controls", () => {
  const source = viewSource();

  assert.match(source, /<el-pagination/);
  assert.match(source, /v-model:current-page="state\.page"/);
  assert.match(source, /:page-size="ANALYTICS_PAGE_SIZE"/);
  assert.match(source, /:total="totalProductCount"/);
});

test("seller analytics next collect page does not depend on the local view page", () => {
  const source = viewSource();

  assert.match(source, /const nextCollectPage = computed/);
  assert.match(source, /page:\s*targetPage/);
  assert.doesNotMatch(source, /state\.page\s*=\s*page;\s*\n\s*await handleCollect\(\)/);
  assert.match(source, /采集下一页（第 \{\{ nextCollectPage \}\} 页）/);
});

test("seller analytics table uses Ozon ERP metric groups and source tab metric sets", () => {
  const source = viewSource();

  assert.match(source, /const metricGroups = \[/);
  assert.match(source, /const metricKeysBySourceTab = \{/);
  assert.match(source, /const visibleMetricGroups = computed/);
  assert.match(source, /v-for="group in visibleMetricGroups"/);
  assert.match(source, /v-for="metric in group\.children"/);
  assert.doesNotMatch(source, /const metricColumns = \[/);
  assert.doesNotMatch(source, /v-for="column in metricColumns"/);
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

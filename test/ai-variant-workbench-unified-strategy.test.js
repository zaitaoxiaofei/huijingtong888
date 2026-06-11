import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");
const collectorBoxSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");
const listingRecordsSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const onlineProductsSource = readFileSync(new URL("../frontend/admin/views/inventory/OnlineProductsView.vue", import.meta.url), "utf8");
const selectionSource = readFileSync(new URL("../frontend/admin/views/selection/SelectionView.vue", import.meta.url), "utf8");

test("asset variant route uses the dedicated variant workbench", () => {
  assert.match(routerSource, /asset-variant-center\/create/);
  assert.match(routerSource, /redirect: \(to\) => \(\{ name: "asset-variant-center-wizard", query: to\.query \}\)/);
  assert.match(routerSource, /asset-variant-center\/wizard/);
  assert.match(routerSource, /AiProductVariantWizardView/);
  assert.match(routerSource, /ai-optimization-workbench-v2/);
  assert.match(routerSource, /PromptLibraryView\.vue/);
});

test("AI variant buttons and navigation open the wizard workbench", () => {
  assert.match(navigationSource, /label: "AI裂变", route: "\/asset-variant-center\/wizard"/);
  for (const pageSource of [collectorBoxSource, listingRecordsSource, onlineProductsSource, selectionSource]) {
    assert.match(pageSource, /asset-variant-center-wizard/);
    assert.doesNotMatch(pageSource, /name: "asset-variant-center-create"/);
  }
});

test("V2 optimization workbench keeps unified strategy bundle search", () => {
  assert.match(source, /matchAiStrategyBundles/);
  assert.match(source, /resolveRemoteAiStrategyPlan/);
  assert.match(source, /strategyBundleSearch\s*=\s*reactive/);
  assert.match(source, /class="variant-plan-search"/);
  assert.match(source, /class="variant-plan-results"/);
});

test("variant work rows inherit selected unified bundle strategy instead of row-level editing", () => {
  assert.match(source, /unifiedBundleStrategy/);
  assert.match(source, /if \(unifiedBundleStrategy\.value\) return unifiedBundleStrategy\.value/);
  assert.match(source, /strategyFromSelectedBundle/);
  assert.match(source, /查看继承方案/);
  assert.match(source, /单独覆盖/);
  assert.doesNotMatch(source, /openStrategyTree\('edit'\)">编辑/);
});

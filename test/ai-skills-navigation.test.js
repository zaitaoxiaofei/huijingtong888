import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");
const router = readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const collector = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");
const records = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const onlineProducts = readFileSync(new URL("../frontend/admin/views/inventory/OnlineProductsView.vue", import.meta.url), "utf8");
const selection = readFileSync(new URL("../frontend/admin/views/selection/SelectionView.vue", import.meta.url), "utf8");

test("AI skills navigation uses the requested labels and ordering", () => {
  const aiSkills = navigation.match(/key: "ai-skills"[\s\S]*?\n  \},/)?.[0] || "";
  const expected = [
    'label: "AI裂变"',
    'label: "裂变案例"',
    'label: "AI优化"',
    'label: "素材优化记录"'
  ];
  let previous = -1;
  for (const label of expected) {
    const index = aiSkills.indexOf(label);
    assert.ok(index > previous, `${label} should appear in the requested order`);
    previous = index;
  }
  assert.doesNotMatch(navigation, /AI商品3 内容优化/);
  assert.doesNotMatch(navigation.match(/key: "products"[\s\S]*?\n  \},/)?.[0] || "", /ai-material-optimization-records/);
});

test("removed AI content optimization route is no longer registered", () => {
  assert.doesNotMatch(router, /AiOptimizationWorkbenchV2View/);
  assert.doesNotMatch(router, /path: "ai-optimization-workbench-v2"/);
  assert.match(router, /breadcrumb: \["AI技能库", "素材优化记录"\]/);
});

test("operational page buttons use the new AI names and valid destinations", () => {
  for (const page of [collector, records, onlineProducts]) {
    assert.match(page, /openAiProductMaterialOptimizerWindow/);
    assert.doesNotMatch(page, /name: "ai-optimization-workbench-v2"/);
    assert.doesNotMatch(page, /AI裂变实验室/);
  }
  assert.match(selection, />AI裂变<\/el-button>/);
  assert.match(selection, /批量AI裂变/);
  assert.doesNotMatch(selection, /AI裂变实验室/);
});

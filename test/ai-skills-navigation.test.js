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
    'label: "AI裂变案例库"',
    'label: "AI优化"',
    'label: "素材优化记录"',
    'label: "AI素材"',
    'label: "AI提示词库"'
  ];
  let previous = -1;
  for (const label of expected) {
    const index = aiSkills.indexOf(label);
    assert.ok(index > previous, `${label} should appear in the requested order`);
    previous = index;
  }
  assert.doesNotMatch(navigation, /AI商品3 内容优化/);
  assert.doesNotMatch(navigation.match(/key: "products"[\s\S]*?\n  \},/)?.[0] || "", /ai-material-optimization-records/);
  assert.doesNotMatch(navigation.match(/key: "settings"[\s\S]*?\n  \}/)?.[0] || "", /settings-materials|settings-prompts/);
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
  assert.match(selection, /批量AI优化/);
  assert.match(selection, /@click="startBatchVariant"[\s\S]{0,80}批量AI优化/);
  assert.doesNotMatch(selection, /AI裂变实验室/);
});

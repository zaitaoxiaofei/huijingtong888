import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const view = fs.readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");
const generateSection = view.slice(view.indexOf('<section v-show="currentStep === \'generate\'"'), view.indexOf("<el-dialog", view.indexOf('<section v-show="currentStep === \'generate\'"')));

test("generate queue does not require manual offer id generation", () => {
  assert.doesNotMatch(generateSection, />一键生成货号</);
  assert.match(view, /missingOfferRows[\s\S]*generateOfferIds\(missingOfferRows\)/);
});

test("failed item action confirms and retries directly", () => {
  assert.match(view, /重新生成失败项/);
  assert.match(view, /await executeBatchImages\(\{ retryFailed: true \}\)/);
  assert.match(view, /已取消选择失败任务/);
});

test("image request fee disclosure distinguishes retries", () => {
  assert.match(view, /图片请求约 ¥\{\{ imageRequestUnitCost/);
  assert.match(view, /失败后重试属于新请求/);
});

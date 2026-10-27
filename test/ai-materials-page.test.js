import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse, compileScript, compileStyle, compileTemplate } from "@vue/compiler-sfc";

const source = readFileSync("frontend/admin/views/settings/MaterialCenterView.vue", "utf8");
const matrix = readFileSync("frontend/admin/views/listing/ShopAssetVariantCenter.vue", "utf8");

test("AI materials remain a scoped image/video/text page without a shop library or physical file deletion", () => {
  assert.match(source, /<h1>AI素材<\/h1>/);
  assert.match(source, /source_type: "ai_generated", recent_days: "7"/);
  assert.match(source, /field_key: "main_image", repair_temp_ai: "1", recent_days: "7"/);
  assert.match(source, /仅展示近 7 天创建/);
  assert.match(source, /asset_type: filters\.mediaType \|\| ""/);
  assert.match(source, /previewDialog\.type = "text"/);
  assert.match(source, /class="dialog-text"/);
  assert.match(source, /shanghaiDateTimeText/);
  assert.match(source, /signal: context\.signal/);
  assert.match(source, /erp:auth-scope-changed/);
  assert.doesNotMatch(source, /loadShopAssets|selectedShopRows|delete-media-group|数据库|店铺矩阵素材|<el-tabs/);
  assert.match(source, /sourceAiAssetId: row\.id/);
});

test("AI main-image recovery preserves current displayable managed images without reviving obsolete private task URLs", () => {
  const a = source.indexOf("function normalizeAiMainImageAssetRows("), b = source.indexOf("function clearFilters(", a);
  const context = vm.createContext({ matchesKeyword: () => true });
  vm.runInContext(source.slice(a, b), context);
  const rows = context.normalizeAiMainImageAssetRows([
    { id: 1, asset: { url: "/api/ai/file/old/preview.png" } },
    { id: 2, asset: { publishUrl: "https://media.example.test/current.png", localUrl: "/api/ai/file/old/preview.png" }, product_name: "Current main" }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://media.example.test/current.png");
  assert.equal(rows[0].sourceAiAssetId, 2);
});

test("matrix removes hidden asset loading while retaining generation, source imports and video registration", () => {
  assert.doesNotMatch(matrix, /loadMediaAssets|mediaAssets|assetProductGroups|media-assets-panel|delete-media-group|limit=500|统一素材资产/);
  for (const fn of ["applySelectionProduct", "applyCollectorBoxProduct", "applyPublishRecord", "buildGeneratePayload", "generateVariants", "startGenerateAllShopsJob", "generateVideoForVariant", "importToListingAutomation", "goToListingAutomation"]) assert.match(matrix, new RegExp(`function ${fn}\\(`));
  assert.match(matrix, /role: "asset_variant_source_image"/);
  assert.match(matrix, /\/api\/asset-variant-engine\/generate/);
  assert.match(matrix, /\/api\/asset-variant-engine\/generate-async/);
  assert.match(matrix, /uploadListingMedia\(file, \{[\s\S]*?source_module: "asset_variant"[\s\S]*?role: "video"/);
});

test("both simplified material views compile through the standard Vue pipeline", () => {
  for (const [filename, text] of [["MaterialCenterView.vue", source], ["ShopAssetVariantCenter.vue", matrix]]) {
    const { descriptor, errors } = parse(text, { filename });
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: "material-ui" });
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: "material-ui", compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename, id: "data-v-material-ui", scoped: style.scoped }).errors, []);
  }
});

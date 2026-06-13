import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const wrapperSource = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");
const runtimeAsset = wrapperSource.match(/const runtimeAsset = "([^"?]+AiOptimizationWorkbenchV2-[^"?]+\.js)/)?.[1]
  || wrapperSource.match(/import\([^)]*"([^"?]*AiOptimizationWorkbenchV2-[^"?]+\.js)/)?.[1]
  || "";
const runtimeCssAsset = runtimeAsset.replace(/AiOptimizationWorkbenchV2-[^/]+\.js$/, "AiOptimizationWorkbenchV2-wGTlZd1f-20260611213517.css");
const source = [
  wrapperSource,
  runtimeAsset ? readFileSync(new URL(`../public${runtimeAsset}`, import.meta.url), "utf8") : "",
  runtimeCssAsset ? readFileSync(new URL(`../public${runtimeCssAsset}`, import.meta.url), "utf8") : ""
].join("\n");
const runtimeSource = runtimeAsset ? readFileSync(new URL(`../public${runtimeAsset}`, import.meta.url), "utf8") : "";

test("AI variant step two keeps variable input visible and uses a field prompt matrix", () => {
  assert.match(source, /confirm-diy-grid/);
  assert.match(source, /target-workbench-column/);
  assert.match(source, /prompt-plan-column/);
  assert.match(source, /confirm-summary-card/);
  assert.match(source, /compact-target-list/);
  assert.match(source, /prompt-config-fields/);
  assert.match(source, /prompt-config-field/);
  assert.match(source, /template-search-inline/);
  assert.match(source, /aiPromptTemplates/);
  assert.match(source, /watermark/);
});

test("AI variant result step renders rows in a table layout", () => {
  assert.match(source, /variant-result-table/);
  assert.match(source, /variant-result-table-wrap/);
  assert.match(source, /variant-main-image-head/);
  assert.match(source, /variant-detail-head/);
  assert.match(source, /variant-title-head/);
  assert.match(source, /variant-tags-head/);
  assert.match(source, /variant-description-head/);
  assert.match(source, /variant-richtext-head/);
  assert.match(source, /variant-video-cell/);
  assert.match(source, /variant-action-cell/);
});

test("AI variant generation fields default to every asset field", () => {
  for (const field of ["mainImage", "detailImages", "title", "tags", "description", "video"]) {
    assert.match(source, new RegExp(`label:\`${field}\``));
  }
  assert.match(source, /richText:/);
  assert.match(source, /variant-richtext-head/);
  assert.match(source, /richtext-cell/);
  assert.match(source, /field-checks/);
  assert.match(source, /prompt-field-chips/);
  assert.match(source, /generatedDetailImages/);
});

test("AI variant video state uses queued tasks and keeps preview URLs explicit", () => {
  assert.match(source, /\/api\/ai-generation\/tasks/);
  assert.match(source, /function XcTask/);
  assert.match(source, /function ZcTask/);
  assert.match(source, /taskId:r/);
  assert.match(source, /label:`\\u89c6\\u9891\\u6392\\u961f\\u4e2d/);
  assert.match(source, /label:`\\u89c6\\u9891\\u751f\\u6210\\u4e2d/);
  assert.match(source, /status:`failed`/);
  assert.match(source, /status:[^?]+?\?`generated`:`local_ready`/);
  assert.match(source, /publishUrl:[^,]+/);
  assert.match(source, /\.localUrl\|\|a\?\.url/);
  assert.match(source, /video_urls:\[[^\]]+\]/);
  assert.match(source, /video_cover_urls:\[[^\]]+\]/);
  assert.match(source, /previewUrl\|\|t\.result\.video\?\.localUrl\|\|t\.result\.video\?\.url\|\|t\.result\.video\?\.publishUrl/);
  assert.match(source, /P\.row\.video\?\.previewUrl\|\|P\.row\.video\?\.localUrl\|\|P\.row\.video\?\.url\|\|P\.row\.video\?\.publishUrl/);
  assert.match(source, /P\.row\.video\.previewUrl\|\|P\.row\.video\.localUrl\|\|P\.row\.video\.url\|\|P\.row\.video\.publishUrl/);
});

test("AI variant result preview generates recoverable rich content and waits for video", () => {
  assert.match(source, /richTextContent/);
  assert.match(source, /function Bd\(e=\{\}\)/);
  assert.match(source, /widgetName:`raShowcase`/);
  assert.match(source, /fieldKey:t,input:r/);
  assert.match(source, /XcTask\(e,`richText`/);
  assert.match(source, /富文本排队中/);
  assert.match(source, /富文本生成中/);
  assert.match(source, /rich_content_json:e\.richTextContent/);
  assert.match(source, /async function Yc\(e\)/);
  assert.match(source, /e\.video\?\.generating/);
  assert.match(source, /await Kc\(e,\{silent:!0\}\)/);
});

test("AI variant title tags and description generation use queued tasks", () => {
  assert.match(source, /gc\(t\)\)\{try\{/);
  assert.match(source, /XcTask\(e,t,\{productName:/);
  assert.match(source, /\$\{Z\(t\)\}排队中/);
  assert.match(source, /\$\{Z\(t\)\}生成中/);
  assert.match(source, /ZcTask\(s,_i\)/);
  assert.match(source, /Ec\(e,t,l\)/);
  assert.match(source, /Dc\(e,t,l\)/);
  assert.match(source, /\$\{Z\(t\)\}已进入队列并生成完成/);
});

test("AI variant rich text and video labels do not expose mojibake or raw JSON fallback", () => {
  assert.equal(source.includes("\u95b8\u719a\u68d7\u93bc"), false);
  assert.match(source, /\u5bcc\u6587\u672c\u5df2\u6309\u4e3b\u56fe\u548c\u63cf\u8ff0\u751f\u6210/);
  assert.match(source, /\u5df2\u751f\u6210\u5bcc\u6587\u672c|\u5bcc\u6587\u672c\u5df2\u751f\u6210/);
  assert.match(source, /\u89c6\u9891\u6b63\u5728\u751f\u6210\uff0c\u8bf7\u7a0d\u540e\u9884\u89c8/);
  assert.match(source, /\u89c6\u9891\u751f\u6210\u5931\u8d25\uff0c\u6682\u65e0\u53ef\u9884\u89c8\u5730\u5740/);
  assert.match(source, /\.richtext-cell\[data-v-750c83a9\] p[\s\S]*border-radius:\s*999px/);
  assert.doesNotMatch(source, /richtext-cell\[data-v-750c83a9\] p[\s\S]*font-family:\s*Consolas/);
});

test("AI variant rich text preview extracts real Ozon rich content text", () => {
  assert.match(source, /function TextFrom\(e,t=\[`summary`,`description`,`content`\],n=0\)/);
  assert.match(source, /n>10/);
  assert.match(source, /Object\.values\(e\)/);
  assert.match(source, /new Set\(r\)/);
  assert.match(source, /RichPreview\(t\.result\)\|\|`待生成`/);
  assert.match(source, /richTextStatus=RichPreview\(e\)\|\|`富文本已按主图和描述生成`/);
  assert.match(source, /TextFrom\(t\.text\|\|``,\[`content`,`text`,`summary`,`description`\]\)/);
});

test("AI variant batch generation isolates per-field failures", () => {
  assert.match(source, /function variantBatchFailure\(e,t,n\)/);
  assert.match(source, /batchErrors=\[\.\.\.e\.batchErrors\|\|\[\],\{field:t,message:r\}\]/);
  assert.match(source, /n=Ds\(\),r=n\.includes\(`richText`\),i=n\.filter\(e=>e!==`video`&&e!==`richText`\)/);
  assert.match(source, /r&&await Vc\(o,async\(\{row:e,field:t\}\)=>/);
  assert.match(source, /e\.jobs\?\.title\?\.status===`failed`/);
  assert.match(source, /if\(!e\.title\|\|!e\.description\)throw Error\(`/);
  assert.match(source, /try\{await Kc\(e,\{silent:!0\}\)\}catch\(t\)\{s\+=1,e\.video=\{/);
  assert.match(source, /s\?S\.warning\(`/);
  assert.match(source, /\$\{s\} \\u4e2a\\u4efb\\u52a1\\u5931\\u8d25/);
});

test("AI variant queue skips draft template vehicle self-targets", () => {
  assert.match(source, /function variantSelfKey\(e=``\)/);
  assert.match(source, /function variantSelfExtract\(e=``\)/);
  assert.match(source, /function variantSelfTarget\(e=\{\},t\)/);
  assert.match(source, /function variantSelfFilteredTargets\(e,t=\[\]\)/);
  assert.match(source, /function variantSelfPruneResults\(\)/);
  assert.match(source, /e\.name,e\.title,e\.description/);
  assert.match(source, /W\.value\.flatMap\(e=>variantSelfFilteredTargets\(e,t\)\.map/);
  assert.match(source, /function variantSelfExpectedCount\(\)/);
  assert.match(source, /!variantSelfTarget\([^,]+,e\.variantTarget\)/);
  assert.match(source, /variantSelfPruneResults\(\);let e=ic\(\)/);
  assert.match(source, /function variantValidResult\(e=\{\}\)/);
  assert.match(source, /function variantBatchRows\(e=\[\]\)/);
  assert.match(source, /let n=ot\(t\),r=variantSelfBaseKeys\(e\),i=\[n\.label,n\.model/);
  assert.match(source, /variantBatchRows\(dc\(\)\)/);
  assert.match(source, /variantBatchRows\(\[e\.result\]\)/);
});

test("AI variant import dialog excludes deleted draft rows from selection", () => {
  assert.match(runtimeSource, /function importableSource\(e=\{\}\)\{return String\(e\?\.raw\?\.status\?\?e\?\.status\?\?``\)\.toLowerCase\(\)!==`deleted`\}/);
  assert.match(runtimeSource, /\.filter\(importableSource\)\.map\(\(e,n\)=>_s\(e,t,n\)\)\.filter\(e=>e\.name&&importableSource\(e\)\)/);
  assert.match(runtimeSource, /U\.rows\.find\(t=>t\.id===e&&importableSource\(t\)\)/);
  assert.match(runtimeSource, /U\.rows\.filter\(importableSource\)\.forEach\(e=>\{U\.selectedById\[e\.id\]=e\}\)/);
  assert.match(runtimeSource, /Object\.values\(U\.selectedById\|\|\{\}\)\.filter\(importableSource\)/);
  assert.match(runtimeSource, /\.map\(e=>ha\(e,t\)\)\.filter\(importableSource\);U\.loading=!1;if\(!n\.length\)/);
  assert.match(runtimeSource, /\\u5df2\\u5220\\u9664\\u8bb0\\u5f55\\u4e0d\\u80fd\\u5bfc\\u5165/);
});

test("AI variant results require a real base material and never use the base row as a result", () => {
  assert.match(source, /function variantSelfSourceForRow\(e=\{\}\)\{let t=e\.sourceProductId\|\|e\.product\?\.sourceProductId\|\|``;return t\?W\.value\.find/);
  assert.match(source, /\|\|null:null\}function variantValidResult/);
  assert.match(source, /!!r&&!!t&&String\(n\)!==String\(t\)&&i\.has\(t\)&&!variantSelfTarget/);
  assert.match(source, /function variantBaseMaterialKeys\(\)/);
  assert.match(source, /function variantBaseMaterialTarget\(e\)/);
  assert.match(source, /&&!variantBaseMaterialTarget\(t\)/);
  assert.match(source, /&&!variantBaseMaterialTarget\(e\.variantTarget\)/);
  assert.match(source, /\(ji\.value\|\|location\.hash\.includes\(`asset-variant-center`\)\)&&E\.value===`variant`&&variantSelfPruneResults\(\)/);
  assert.match(source, /location\.hash\.includes\(`asset-variant-center`\)/);
  assert.match(source, /E\.value=\(ji\.value\|\|location\.hash\.includes\(`asset-variant-center`\)\)\?`variant`:t\.taskMode\|\|E\.value/);
  assert.doesNotMatch(source, /variantSelfSourceForRow\(e=\{\}\)\{return W\.value\.find[\s\S]*\|\|e\.product\|\|\{\}/);
});

test("AI variant result table keeps a polished review layout", () => {
  assert.match(source, /ai variant result layout polish/);
  assert.match(source, /\.variant-result-table\[data-v-750c83a9\]\s*\{[^}]*table-layout:\s*fixed/);
  assert.match(source, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(source, /\.table-video-preview video\[data-v-750c83a9\],\s*\.table-video-placeholder\[data-v-750c83a9\]\s*\{[^}]*height:\s*76px/);
  assert.match(source, /height:\s*112px/);
  assert.match(source, /\.variant-action-cell\[data-v-750c83a9\]\s*\{[^}]*width:\s*260px/);
  assert.match(source, /text-overflow:\s*ellipsis/);
  assert.match(source, /\.variant-action-cell\[data-v-750c83a9\]\s*\.el-button \+ \.el-button/);
});

test("AI variant video failures keep table labels short", () => {
  assert.match(source, /label:`(?:\u89c6\u9891\u751f\u6210\u5931\u8d25|\\u89c6\\u9891\\u751f\\u6210\\u5931\\u8d25)`/);
  assert.match(source, /error:r\.message\|\|``/);
  assert.doesNotMatch(source, /label:r\.message\|\|`视频生成失败`/);
});

test("AI variant draft save uses limited concurrency and shows progress", () => {
  assert.match(source, /vi=2/);
  assert.match(source, /Math\.min\(vi,[^)]+\.length\)/);
  assert.match(source, /save-progress/);
  assert.match(source, /正在保存/);
  assert.match(source, /A\.done\/A\.total\*100/);
});

test("AI variant draft save emits frontend performance segments", () => {
  assert.match(source, /\[ai-variant-save-perf\]/);
  assert.match(source, /gi=9e4/);
  assert.match(source, /_i=9e4/);
  assert.match(source, /ai-save-/);
  assert.match(source, /\/api\/listing\/drafts\/ai-variant-lightweight/);
  assert.match(source, /frontend\.lightweight_draft\.create\.start/);
  assert.match(source, /frontend\.template\.create\.start/);
  assert.match(source, /frontend\.template\.create/);
  assert.match(source, /frontend\.draft\.create\.start/);
  assert.match(source, /frontend\.draft\.create/);
  assert.match(source, /frontend\.save\.done/);
  assert.match(source, /\/api\/listing\/templates/);
  assert.match(source, /\/api\/listing\/drafts/);
});

test("AI variant generated fields are persisted as recoverable asset records", () => {
  assert.match(source, /\/api\/listing\/ai-variant-assets/);
  assert.match(source, /field_key:/);
  assert.match(source, /field_status:/);
  assert.match(source, /variantTarget:/);
  assert.match(source, /asset:/);
  assert.match(source, /generated/);
  assert.match(source, /failed/);
  assert.match(source, /video/);
  assert.doesNotMatch(source, /if \(row\.listingDraftId\) return row/);
});

test("AI variant queued text tasks keep payloads small", () => {
  assert.match(source, /function Mc\(e=\{\}\)\{let t=e\.product\|\|\{\}/);
  assert.match(source, /description:String\(e\.description\|\|``\)\.slice\(0,6e3\)/);
  assert.match(source, /async function XcTask\(e=\{\},t=``,n=\{\}\)\{let r=\{\.\.\.n,row:Mc\(e\)\}/);
  assert.match(source, /strategyPrompt:String\(r\.sourceContext\.strategyPrompt\|\|``\)\.slice\(0,8e3\)/);
  assert.doesNotMatch(source, /promptVariables:i,strategyPrompt:r\.renderedPrompt/);
});

test("AI variant rich text and video never fall back to mother material image", () => {
  assert.match(source, /mainImageUrl:e\.generatedMainImageUrl\|\|``/);
  assert.match(source, /title:e\.title\|\|``/);
  assert.match(source, /description:e\.description\|\|``/);
  assert.match(source, /let n=e\.generatedMainImageUrl;if\(!n\)/);
  assert.match(source, /\\u4e0d\\u80fd\\u4f7f\\u7528\\u6bcd\\u7d20\\u6750\\u53c2\\u8003\\u56fe\\u751f\\u6210\\u89c6\\u9891/);
  assert.doesNotMatch(source, /mainImageUrl:e\.generatedMainImageUrl\|\|e\.product\?\.imageUrl/);
  assert.doesNotMatch(source, /let n=e\.generatedMainImageUrl\|\|e\.product\.imageUrl/);
});

test("AI variant asset history drawer can recover a single generated field", () => {
  assert.match(source, /asset-history-drawer/);
  assert.match(source, /asset-history-list/);
  assert.match(source, /asset-history-row/);
  assert.match(source, /source_batch_id/);
  assert.match(source, /fieldKey/);
  assert.match(source, /field_key/);
  assert.match(source, /updatedAt/);
  assert.match(source, /updated_at/);
  assert.match(source, /应用到结果/);
  assert.match(source, /资产已找回，待保存草稿/);
});

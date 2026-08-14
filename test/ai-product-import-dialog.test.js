import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeImportCandidate, normalizeImportVariants } from "../frontend/admin/utils/ai-product-import.js";

const optimizerSource = readFileSync(new URL("../frontend/admin/views/listing/AiProductMaterialOptimizerView.vue", import.meta.url), "utf8");
const variantSource = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");
const importDialogSource = readFileSync(new URL("../frontend/admin/components/listing/AiProductImportDialog.vue", import.meta.url), "utf8");

test("AI material optimizer and variant lab reuse the same product import dialog", () => {
  assert.match(optimizerSource, /import AiProductImportDialog/);
  assert.match(optimizerSource, /<AiProductImportDialog/);
  assert.match(variantSource, /import AiProductImportDialog/);
  assert.match(variantSource, /<AiProductImportDialog/);
});

test("AI variant lab defaults draft imports to the current user and exposes common filters", () => {
  assert.match(variantSource, /defaultDraftScope: source === "draft" \? "mine" : "all"/);
  assert.match(importDialogSource, /params\.set\("creatorId", state\.creatorId\)/);
  assert.match(importDialogSource, /params\.set\("shopId", state\.shopId\)/);
  assert.match(importDialogSource, /params\.set\("developmentType", state\.developmentType\)/);
  assert.match(importDialogSource, /params\.set\("startDate", state\.startDate\)/);
  assert.match(importDialogSource, /params\.set\("endDate", state\.endDate\)/);
  assert.match(importDialogSource, /apiClient\.get\("\/api\/people"/);
  assert.match(importDialogSource, /apiClient\.get\("\/api\/shops"/);
});

test("draft import prefers edited variant image before template and source images", () => {
  const candidate = normalizeImportCandidate({
    id: 940,
    product_name: "Draft product",
    draft_variant_primary_image: "/uploads/listing-media/edited.jpg",
    draft_template_primary_image: "/uploads/listing-media/template.jpg",
    source_images_json: JSON.stringify(["/uploads/listing-media/source.jpg"])
  }, "draft");

  assert.equal(candidate.imageUrl, "/uploads/listing-media/edited.jpg");
  assert.deepEqual(candidate.detailImages, [
    "/uploads/listing-media/template.jpg",
    "/uploads/listing-media/source.jpg"
  ]);
});

test("draft import uses the current draft list thumbnail before stale source images", () => {
  const candidate = normalizeImportCandidate({
    id: 1713,
    product_name: "Current draft product",
    list_image_url: "/uploads/listing-media/current-draft.png",
    source_images_json: JSON.stringify([
      "https://collector.example/oldest.jpg",
      "https://collector.example/second.jpg"
    ])
  }, "draft");

  assert.equal(candidate.imageUrl, "/uploads/listing-media/current-draft.png");
  assert.deepEqual(candidate.detailImages, [
    "https://collector.example/oldest.jpg",
    "https://collector.example/second.jpg"
  ]);
});

test("draft import prefers editable title over stale list product name", () => {
  const candidate = normalizeImportCandidate({
    id: 1028,
    product_name: "Защитный TPU-чехол для ключа TENET T4 / T4L с ремешком",
    template_payload_json: JSON.stringify({
      title: "Чехол для ключа TENET T4, защитный TPU-кейс, глянцевый, тонкий, не мешает сигналу",
      editable_payload: {
        title: "Чехол для ключа TENET T4, защитный TPU-кейс, глянцевый, тонкий, не мешает сигналу",
        variants: [{ name: "Чехол для ключа TENET T4, защитный TPU-кейс, глянцевый, тонкий, не мешает сигналу" }]
      }
    })
  }, "draft");

  assert.equal(candidate.title, "Чехол для ключа TENET T4, защитный TPU-кейс, глянцевый, тонкий, не мешает сигналу");
  assert.doesNotMatch(candidate.title, /ремешком/i);
});

test("AI material optimizer performs real generation and can save a listing draft", () => {
  assert.match(optimizerSource, /generateReviewedImage\(mainSource, "main", 0\)/);
  assert.match(optimizerSource, /generateAiCommerceCopy\(buildCopyGenerationPayload\(mainImage\)\)/);
  assert.match(optimizerSource, /\/api\/asset-variant-engine\/generate-video/);
  assert.match(optimizerSource, /\/api\/listing\/drafts\/ai-variant-lightweight/);
  assert.match(optimizerSource, /人工优化备注/);
  assert.match(optimizerSource, /title="提示词审核"/);
  assert.match(optimizerSource, /v-model="planEditor\.main"/);
  assert.match(optimizerSource, /v-model="promptEditor\.imageGlobalRules"/);
  assert.match(optimizerSource, /confirmPlanAndGenerate/);
  assert.match(optimizerSource, /clone_source_draft: true/);
  assert.match(optimizerSource, /video_cover_urls: state\.generated\.videoCoverUrls/);
  assert.match(optimizerSource, /watermark-removal-only or cleanup-only result is unacceptable/);
  assert.doesNotMatch(optimizerSource, /const optimizedCandidates = originalCandidates\.map/);
});

test("AI material optimizer completes missing Russian image copy instead of blocking an uneditable plan", () => {
  assert.match(optimizerSource, /DEFAULT_MAIN_OVERLAY_RU/);
  assert.match(optimizerSource, /titleCandidates\.find/);
  assert.match(optimizerSource, /detailOverlayText\(shot, index\)/);
  assert.doesNotMatch(optimizerSource, /state\.plan\?\.main_overlay_ru\?\.title_ru \|\| form\.title \|\| "待生成商品标题"/);
});

test("AI material optimizer uses a business offer prefix without AI branding", () => {
  assert.match(optimizerSource, /prefix: `OPT-\$\{variant\.key\}`/);
  assert.doesNotMatch(optimizerSource, /prefix: `AI-OPT-/);
});

test("AI material optimizer generates a reviewed main image before parallel suite batches", () => {
  assert.match(optimizerSource, /generateReviewedImage\(mainSource, "main", 0\)/);
  assert.match(optimizerSource, /runWithConcurrency\(detailSources, concurrency/);
  assert.match(optimizerSource, /Math\.min\(6, Math\.max\(1/);
  assert.match(optimizerSource, /generateAiCommerceCopy\(buildCopyGenerationPayload\(main\.image\)\)/);
  assert.match(optimizerSource, /generatedMainImageUrl, productTruth/);
  assert.match(optimizerSource, /generateReviewedImage\(source, "detail", index, main\.image\)/);
  assert.match(optimizerSource, /reference image is the approved main visual/i);
});

test("AI material optimizer executes a product-specific coherent suite storyboard", () => {
  assert.match(optimizerSource, /function optimizerStoryboard\(\)/);
  assert.match(optimizerSource, /function storyboardShot\(role, index\)/);
  assert.match(optimizerSource, /SHOT OBJECTIVE/);
  assert.match(optimizerSource, /COMPOSITION/);
  assert.match(optimizerSource, /MUST SHOW/);
  assert.doesNotMatch(optimizerSource, /buildImageGenerationPayload\(detailSources\[index\], "detail", index\)\)/);
});

test("AI material optimizer reviews each image and retries material defects once", () => {
  assert.match(optimizerSource, /function generateReviewedImage\(source, role, index, visualAnchorUrl = ""\)/);
  assert.match(optimizerSource, /\/api\/ai-variant-lab\/optimize\/review-image/);
  assert.match(optimizerSource, /QUALITY REVIEW CORRECTION/);
  assert.match(optimizerSource, /if \(review\.pass \|\| !review\.corrections_en\)/);
  assert.match(optimizerSource, /const retryResult = await generateAiImages\(retryPayload\)/);
  assert.match(optimizerSource, /const imageReviewCache = new Map\(\)/);
  assert.match(optimizerSource, /if \(imageReviewCache\.has\(reviewKey\)\) return imageReviewCache\.get\(reviewKey\)/);
});

test("AI material optimizer lets image2 design exact Russian typography", () => {
  assert.match(optimizerSource, /Render the following buyer-facing Russian copy directly into the final image, verbatim and fully legible/);
  assert.match(optimizerSource, /Do not translate, paraphrase, misspell, omit or invent any text/);
  assert.match(optimizerSource, /typography_source: "image_model"/);
  assert.match(optimizerSource, /overlay_text_ru/);
  assert.doesNotMatch(optimizerSource, /generatedImages = await composeGeneratedImageText/);
});

test("AI material optimizer adapts copy hierarchy and typography to each product and shot", () => {
  assert.match(optimizerSource, /const copyStrategy = computed/);
  assert.match(optimizerSource, /const visualLanguage = computed/);
  assert.match(optimizerSource, /Reject a title or selling point when replacing the exact product name/);
  assert.match(optimizerSource, /Do not use the same oversized bold black heading, underline, equal icon grid/);
  assert.match(optimizerSource, /TYPOGRAPHY DIRECTION/);
});

test("AI material optimizer validates and rewrites generic titles and duplicate tags without regenerating images", () => {
  assert.match(optimizerSource, /function commerceCopyQualityIssues\(copy = \{\}\)/);
  assert.match(optimizerSource, /标题包含可套用于任意商品的泛化表达/);
  assert.match(optimizerSource, /标签存在同义或格式化重复/);
  assert.match(optimizerSource, /async function generateValidatedCommerceCopy/);
  assert.match(optimizerSource, /QUALITY GATE REJECTED THE PREVIOUS COPY/);
  assert.match(optimizerSource, /qualityStatus: rewritten\.qualityIssues\.length \? "fallback" : "passed"/);
});

test("AI material optimizer generates two main directions and keeps the unselected option", () => {
  assert.match(optimizerSource, /function generateMainVisualOptions\(source\)/);
  assert.match(optimizerSource, /mainVisualDirections\(\)\.slice\(0, 2\)/);
  assert.match(optimizerSource, /left\.review\.pass !== right\.review\.pass/);
  assert.match(optimizerSource, /视觉复检 \$\{item\.review\.score \|\| 0\} 分/);
  assert.match(optimizerSource, /state\.candidates = \[\.\.\.originals, \.\.\.generatedImages, \.\.\.mainAlternativeCandidates\]/);
});

test("AI material optimizer keeps two main-image draft variants with shared details and separate videos", () => {
  assert.match(optimizerSource, /const mainOptions = \[main\.candidate, \.\.\.mainAlternativeCandidates\][\s\S]*slice\(0, 2\)/);
  assert.match(optimizerSource, /variants: mainOptions\.map/);
  assert.match(optimizerSource, /images: \[option\.url, \.\.\.generatedImages\.slice\(1\)/);
  assert.match(optimizerSource, /mainOptions\.map\(async \(option\)/);
  assert.match(optimizerSource, /for \(const variant of variants\)/);
  assert.match(optimizerSource, /state\.savedDraftIds = results\.filter/);
});

test("AI material optimizer supports manual main selection and saves evaluation metrics", () => {
  assert.match(optimizerSource, /function selectMainVisual\(candidate\)/);
  assert.match(optimizerSource, /mainVisualCandidates\.length > 1/);
  assert.match(optimizerSource, /function buildOptimizationEvaluation\(\)/);
  assert.match(optimizerSource, /main_manually_overridden/);
  assert.match(optimizerSource, /evaluation: buildOptimizationEvaluation\(\)/);
});

test("AI material optimizer shows the full blueprint before generation finishes", () => {
  assert.match(optimizerSource, /本次生成蓝图/);
  assert.match(optimizerSource, /mainOverlayPlan\.title/);
  assert.match(optimizerSource, /mainDirectionPreview/);
  assert.match(optimizerSource, /storyboardPreview/);
  assert.match(optimizerSource, /state\.candidates\.push\(candidate\)/);
});

test("AI material optimizer shows plan targets progress and retry before generation", () => {
  assert.match(optimizerSource, /const planTargets = computed/);
  assert.match(optimizerSource, /本次生成目标/);
  assert.match(optimizerSource, /主图方向/);
  assert.match(optimizerSource, /详情图套图/);
  assert.match(optimizerSource, /俄语商品文案/);
  assert.match(optimizerSource, /商品视频/);
  assert.match(optimizerSource, /target\.status === 'failed'/);
  assert.match(optimizerSource, />重试建议</);
});

test("AI material optimizer requires precise copy and saves main-led rich content and video cover", () => {
  assert.match(optimizerSource, /Never reduce the product to a generic category/);
  assert.match(optimizerSource, /Generate 20 to 25 precise Russian search tags/);
  assert.match(optimizerSource, /content: images\.slice\(0, 1\)\.map/);
  assert.match(optimizerSource, /const videoCoverUrls = video\.url \? \[video\.url\] : \[\]/);
  assert.match(optimizerSource, /state\.generated\.videoCoverUrls = video\.url \? \[video\.url\] : \[\]/);
});

test("AI material optimizer can remove imported detail images before analysis", () => {
  assert.match(optimizerSource, /function removeDetailCandidate\(candidateId\)/);
  assert.match(optimizerSource, /form\.detailImageText = state\.candidates/);
  assert.match(optimizerSource, /@click\.stop="removeDetailCandidate\(item\.candidate_id\)"/);
  assert.match(optimizerSource, /item\.kind !== 'main'/);
});

test("AI material optimizer prevents Chinese source text from reaching generated images", () => {
  assert.match(optimizerSource, /function sanitizeImagePrompt\(value = ""\)/);
  assert.match(optimizerSource, /Remove all source-image captions and Chinese characters/);
  assert.match(optimizerSource, /must use Russian Cyrillic only/);
  assert.match(optimizerSource, /Newly rendered buyer-facing text must be concise/);
  assert.match(optimizerSource, /verified product facts/);
});

test("AI material optimizer applies global, operator, then AI prompt priority", () => {
  assert.match(optimizerSource, /STRICT PROMPT PRIORITY: 1\) GLOBAL RULES AND VERIFIED PRODUCT FACTS; 2\) OPERATOR REQUIREMENTS; 3\) AI OPTIMIZATION SUGGESTIONS/);
  assert.match(optimizerSource, /HIGHEST PRIORITY - global rules/);
  assert.match(optimizerSource, /SECOND PRIORITY - operator requirements/);
  assert.match(optimizerSource, /THIRD PRIORITY - AI optimization suggestions/);
  assert.match(optimizerSource, /When instructions conflict, always discard the lower-priority instruction/);
});

test("AI material optimizer requires uncropped exact 3:4 image composition", () => {
  assert.match(optimizerSource, /final image canvas must be exactly 3:4 \(width:height\)/);
  assert.match(optimizerSource, /Do not output 2:3, 9:16, or any other aspect ratio/);
  assert.match(optimizerSource, /Do not achieve 3:4 by cropping, stretching, squeezing, or cutting off/);
  assert.match(optimizerSource, /autoCrop: false/);
});

test("AI material optimizer combines image ordering with results and supports main-only optimization", () => {
  assert.match(optimizerSource, /optimizationScope: "full"/);
  assert.match(optimizerSource, /form\.optimizationScope === "main_only"/);
  assert.match(optimizerSource, /draggable="true"/);
  assert.match(optimizerSource, /@drop\.prevent="dropSlot\(index\)"/);
  assert.match(optimizerSource, /第一张自动作为主图/);
  assert.doesNotMatch(optimizerSource, /\{ key: "select", title:/);
});

test("AI material optimizer plans and tracks parallel generation modules before execution", () => {
  assert.match(optimizerSource, /imageConcurrency: 6/);
  assert.match(optimizerSource, /function prepareGenerationPlan\(\)/);
  assert.match(optimizerSource, /name: "详情图套图"/);
  assert.match(optimizerSource, /name: "商品文案"/);
  assert.match(optimizerSource, /name: "富文本与封面"/);
  assert.match(optimizerSource, /确认并保存生成计划/);
  assert.match(optimizerSource, /generationStatusLabel/);
  assert.match(optimizerSource, /retryGenerationModule\(module\.id\)/);
  assert.match(optimizerSource, /最终详情图 \{\{ index \+ 1 \}\} 提示词/);
});

test("multi-variant imports stay isolated by variant SKU and images", () => {
  const candidate = normalizeImportCandidate({
    id: 951,
    product_name: "Door sill protector",
    template_payload: {
      editable_payload: {
        variants: [
          { sku: "BLACK-4", primary_image: "/black-main.jpg", images: ["/black-main.jpg", "/black-detail.jpg"] },
          { sku: "SILVER-4", primary_image: "/silver-main.jpg", images: ["/silver-main.jpg", "/silver-detail.jpg"] }
        ]
      }
    }
  }, "draft");
  const variants = normalizeImportVariants(candidate);
  assert.equal(variants.length, 2);
  assert.deepEqual(variants.map((item) => item.sourceSku), ["BLACK-4", "SILVER-4"]);
  assert.deepEqual(variants[0].detailImages, ["/black-detail.jpg"]);
  assert.deepEqual(variants[1].detailImages, ["/silver-detail.jpg"]);
  assert.equal(variants[0].templatePayload.editable_payload.variants.length, 1);
  assert.equal(variants[1].templatePayload.editable_payload.variants[0].sku, "SILVER-4");
});

test("AI material optimizer exposes an isolated selectable source-variant queue", () => {
  assert.match(optimizerSource, /normalizeImportVariants\(row\)/);
  assert.match(optimizerSource, /selectedSourceTaskIds/);
  assert.match(optimizerSource, /runSelectedSourceTasks/);
  assert.match(optimizerSource, /source_variant_key:/);
  assert.match(optimizerSource, /批量优化并保存草稿/);
});

test("AI material optimizer uses a four-stage workflow with a separate generation plan", () => {
  assert.match(optimizerSource, /title: "导入素材"/);
  assert.match(optimizerSource, /title: "AI 识别"/);
  assert.match(optimizerSource, /title: "生成计划"/);
  assert.match(optimizerSource, /title: "生成结果"/);
  assert.match(optimizerSource, /confirmMaterialAndOptimize/);
  assert.match(optimizerSource, /analyzeMaterial\(\{ auto: true \}\)/);
  assert.match(optimizerSource, /options\.auto \|\| await confirmUseHistoryAnalysis/);
  assert.match(optimizerSource, /saveResultToDraft/);
  assert.match(optimizerSource, /prepareTemplate\(\{ navigate: false \}\)/);
  assert.match(optimizerSource, /v-show="currentStep === 'recognize'"/);
  assert.match(optimizerSource, /v-show="currentStep === 'plan'"/);
  assert.match(optimizerSource, /确认并保存生成计划/);
  const importFlow = optimizerSource.match(/async function confirmMaterialAndOptimize[\s\S]*?function markWorkflowStopped/)?.[0] || "";
  assert.doesNotMatch(importFlow, /await planMaterial\(\)/);
  assert.match(optimizerSource, /const recognitionProgress = reactive/);
  assert.match(optimizerSource, /已等待 \{\{ recognitionProgress\.elapsedSeconds \}\} 秒/);
  assert.match(optimizerSource, /识别完成，等待你检查并确认结果/);
  assert.doesNotMatch(optimizerSource, /v-show="currentStep === 'save'"/);
});

test("AI material optimizer removes the duplicate right-side source image panel", () => {
  assert.match(optimizerSource, /<el-button :icon="UploadFilled">临时上传主图<\/el-button>/);
  assert.doesNotMatch(optimizerSource, /<el-upload drag/);
  assert.match(optimizerSource, /\.material-layout \{[\s\S]*grid-template-columns: minmax\(0, 1fr\);/);
});

test("AI material optimizer can remove imported variant tasks before batch execution", () => {
  assert.match(optimizerSource, /function removeSourceTask\(taskId\)/);
  assert.match(optimizerSource, /sourceTasks\.value\.splice\(index, 1\)/);
  assert.match(optimizerSource, /clearImportedMaterial\(\)/);
  assert.match(optimizerSource, /移除该变体/);
  assert.match(optimizerSource, /:disabled="running\.batchSource"/);
});

test("AI material optimizer requires Russian copy on every generated image", () => {
  assert.match(optimizerSource, /主图缺少俄语商品标题/);
  assert.match(optimizerSource, /主图至少需要 2 个俄语卖点/);
  assert.match(optimizerSource, /详情图缺少俄语文字说明/);
  assert.match(optimizerSource, /function detailOverlayText\(shot, index\)/);
  assert.match(optimizerSource, /:disabled="generationPlanBlockers\.length > 0"/);
});

test("AI material optimizer checkpoints successful images and isolates partial failures", () => {
  assert.match(optimizerSource, /function checkpointGeneratedCandidate\(candidate, role, index\)/);
  assert.match(optimizerSource, /saveActiveTaskWorkspace\(\)/);
  assert.match(optimizerSource, /已保留 \$\{preserved\} 张成功素材/);
  assert.match(optimizerSource, /correction retry failed; preserving initial image/);
  assert.match(optimizerSource, /return \{ url: "", review: \{ pass: false/);
});

test("AI material optimizer warns but still allows saving images that fail Russian copy review", () => {
  assert.match(optimizerSource, /const typographyIncomplete = computed/);
  assert.match(optimizerSource, /富文本组装/);
  assert.match(optimizerSource, /部分图片没有通过俄语文案审核，仍可保存当前结果/);
  assert.match(optimizerSource, /typography_status !== "done"/);
  assert.match(optimizerSource, /const canPrepare = computed\(\(\) => state\.finalImageSlots\.some\(\(item\) => item\.url\)\)/);
  assert.match(optimizerSource, /:disabled="!canPrepare" @click="saveResultToDraft"/);
  assert.match(optimizerSource, /moduleId === "assemble"/);
});

test("AI material optimizer confirms and saves recognition and plan before generation", () => {
  assert.match(optimizerSource, /const canPlan = computed\(\(\) => Boolean\(state\.analysis && state\.analysisConfirmed\)\)/);
  assert.match(optimizerSource, /const canGenerate = computed\(\(\) => Boolean\(state\.plan && state\.planConfirmed\)\)/);
  assert.match(optimizerSource, /\/api\/ai-variant-lab\/optimize\/analysis\/confirm/);
  assert.match(optimizerSource, /\/api\/ai-variant-lab\/optimize\/plan\/confirm/);
  assert.match(optimizerSource, /\/api\/ai-variant-lab\/optimize\/result/);
  assert.match(optimizerSource, /确认并保存识别结果/);
  assert.match(optimizerSource, /确认并保存生成计划/);
  assert.match(optimizerSource, /按已保存计划开始生成/);
  assert.match(optimizerSource, /class="step-heading-actions"/);
  assert.match(optimizerSource, /\.step-heading-actions \{[\s\S]*margin-left: auto/);
});

test("AI material optimizer recovers interrupted generation and hides prompts behind a dialog", () => {
  assert.match(optimizerSource, /continueMaterialOptimization/);
  assert.match(optimizerSource, /options\.reimport !== false/);
  assert.match(optimizerSource, /workflowError/);
  assert.match(optimizerSource, /从当前阶段继续优化/);
  assert.match(optimizerSource, /查看 \/ 修改提示词/);
  assert.match(optimizerSource, /v-model="promptReviewDialog\.visible"/);
  assert.match(optimizerSource, /按当前提示词重新生成/);
  assert.doesNotMatch(optimizerSource, /:model-value="\['prompts'\]"/);
});

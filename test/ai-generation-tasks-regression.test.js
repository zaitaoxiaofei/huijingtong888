import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __test__ as aiTaskInternals } from "../src/services/ai-generation-tasks.js";

const serviceSource = readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/aiGenerationTasks.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const runtimeServicesSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const listingAutomationSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("ai generation tasks have a shared persistent task schema", () => {
  assert.match(serviceSource, /CREATE TABLE IF NOT EXISTS ai_generation_tasks/);
  assert.match(serviceSource, /task_no VARCHAR\(64\) NOT NULL/);
  assert.match(serviceSource, /workflow_id VARCHAR\(128\) NOT NULL DEFAULT ''/);
  assert.match(serviceSource, /result_id VARCHAR\(128\) NOT NULL DEFAULT ''/);
  assert.match(serviceSource, /field_key VARCHAR\(64\) NOT NULL DEFAULT ''/);
  assert.match(serviceSource, /depends_on_task_ids VARCHAR\(500\) NOT NULL DEFAULT ''/);
  assert.match(serviceSource, /INDEX idx_ai_generation_tasks_status \(status, priority, created_at\)/);
});

test("ai generation task routes expose create, query, and retry APIs", () => {
  assert.match(routeSource, /POST \/api\/ai-generation\/tasks/);
  assert.match(routeSource, /GET \/api\/ai-generation\/tasks/);
  assert.match(routeSource, /parts\[4\] === "retry"/);
  assert.match(serverSource, /createAiGenerationTaskRoutes/);
  assert.match(serverSource, /handleAiGenerationTaskRestRoute/);
  assert.match(runtimeServicesSource, /createAiGenerationTasks/);
  assert.match(runtimeServicesSource, /aiGenerationTasks/);
  assert.match(runtimeServicesSource, /retryAiGenerationTask/);
});

test("ai generation task worker isolates field failures", () => {
  assert.match(serviceSource, /status = 'running'/);
  assert.match(serviceSource, /status = 'done'/);
  assert.match(serviceSource, /status = CASE WHEN \? = 1 THEN 'provider_pending' WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END/);
  assert.match(serviceSource, /activeByField/);
  assert.match(serviceSource, /WORKER_LIMITS/);
  assert.match(serviceSource, /video: 1/);
  assert.match(serviceSource, /richText: 3/);
  assert.match(serviceSource, /AI_IMAGE_TASK_CONCURRENCY_CAP/);
  assert.match(serviceSource, /aiImageRuntimePoolConfig/);
  assert.match(serviceSource, /field_key IN \('mainImage', 'detailImages'\)/);
  assert.doesNotMatch(serviceSource, /mainImage: 1/);
  assert.doesNotMatch(serviceSource, /detailImages: 1/);
});

test("ai generation task inputs are compacted before MySQL insert", () => {
  assert.match(serviceSource, /MAX_TASK_INPUT_JSON_BYTES/);
  assert.match(serviceSource, /compactAiGenerationTaskInput\(input, fieldKey\)/);
  assert.match(serviceSource, /JSON\.stringify\(compactInput\)/);
  assert.match(serviceSource, /function compactSourceContext/);
  assert.match(serviceSource, /function compactTaskRow/);
  assert.match(serviceSource, /function fitJsonBytes/);
});

test("ai generation task handlers cover text fields, rich text, and video", () => {
  assert.match(serviceSource, /\["title", "tags", "description"\]\.includes\(fieldKey\)/);
  assert.match(serviceSource, /generateTextFieldOutput/);
  assert.match(serviceSource, /generateDeepSeekListingContent/);
  assert.match(serviceSource, /type: fieldKey/);
  assert.match(serviceSource, /fieldKey === "richText"/);
  assert.match(serviceSource, /ensureAssetVariantImagePublishUrl\(mainImageSource/);
  assert.match(serviceSource, /imageStatus: mainImageAsset\.status \|\| ""/);
  assert.match(serviceSource, /fieldKey === "video"/);
  assert.match(serviceSource, /generateAssetVariantVideoFromImage/);
  assert.match(serviceSource, /视频生成缺少新主图，不能使用母素材参考图/);
  assert.doesNotMatch(serviceSource, /input\.row\?\.product\?\.imageUrl/);
  assert.match(serviceSource, /widgetName: "raShowcase"/);
  assert.match(serviceSource, /type: "billboard"/);
  assert.match(serviceSource, /version: 0\.3/);
  assert.match(serviceSource, /srcMobile: mainImage/);
  assert.match(serviceSource, /richTextContent/);
});

test("ai variant text tasks validate exact target model and reject source contamination", () => {
  assert.match(serviceSource, /function assertVariantTextMatchesTarget\(fieldKey, output, context = {}\)/);
  assert.match(serviceSource, /function normalizeVariantTags\(tags = \[\], context = {}\)/);
  assert.match(serviceSource, /cleaned\.unshift\(`#\$\{target\}`\)/);
  assert.match(serviceSource, /target_model_mismatch/);
  assert.match(serviceSource, /source_model_contamination/);
  assert.match(serviceSource, /vehicleTextContainsModelInText\(text, target\)/);
  assert.match(serviceSource, /function vehicleTextContainsModel\(normalizedText = "", normalizedModel = ""\)/);
  assert.match(serviceSource, /function vehicleTextContainsModelInText\(value = "", normalizedModel = ""\)/);
  assert.match(serviceSource, /function alignVariantTargetText\(value = "", context = \{\}\)/);
  assert.match(serviceSource, /function replaceVehicleModel\(text = "", fromModel = "", toModel = ""\)/);
  assert.match(serviceSource, /function resolveSourceVehicleModel\(context = \{\}\)/);
  assert.match(serviceSource, /function extractVehicleModel\(value = ""\)/);
  assert.match(serviceSource, /function extractVehicleModels\(value = ""\)/);
  assert.match(serviceSource, /sourceContext\?\.variantTarget/);
  assert.match(serviceSource, /sourceModel: sourceContext\?\.sourceModel \|\| sourceContext\?\.source_model/);
  assert.match(serviceSource, /use the exact target vehicle model string/);
});

test("ai variant description stays plain text while rich text owns JSON", () => {
  assert.match(serviceSource, /function plainDescriptionText\(\.\.\.values\)/);
  assert.match(serviceSource, /function isPlainDescription\(value = ""\)/);
  assert.match(serviceSource, /allowJsonFallback: false/);
  assert.match(serviceSource, /"richJson"\\s\*:/);
  assert.match(serviceSource, /function fallbackVariantDescription\(context = \{\}\)/);
  assert.doesNotMatch(serviceSource, /richJson: fields\.richJson \|\| fields\.rich_json/);
  assert.match(serviceSource, /Description output must be natural plain text only/);
  assert.match(serviceSource, /fields: \{ summary: "string" \}/);
});

test("ai variant rich text requires generated title description and main image", () => {
  assert.match(serviceSource, /if \(!mainImage\) throw new Error\("富文本生成缺少新主图"\)/);
  assert.match(serviceSource, /if \(!title\) throw new Error\("富文本生成缺少新标题"\)/);
  assert.match(serviceSource, /if \(!description\) throw new Error\("富文本生成缺少新描述"\)/);
  assert.doesNotMatch(serviceSource, /input\.description \|\| row\.description \|\| row\.originalDescription/);
});

test("ai generation tasks recover running tasks on server startup", () => {
  assert.match(serviceSource, /UPDATE ai_generation_tasks SET status = 'queued', started_at = NULL WHERE status IN \('running', 'provider_pending'\)/);
  assert.match(serverSource, /recoverAiGenerationTasks/);
  assert.match(runtimeServicesSource, /recoverAiGenerationTasksOnStartup/);
  assert.match(serviceSource, /status IN \('running', 'provider_pending'\)/);
});

test("ai variant rich text does not fall back to mother material fields", () => {
  const richTextSource = serviceSource.slice(
    serviceSource.indexOf("async function generateRichTextOutput"),
    serviceSource.indexOf("function normalizeTextList")
  );
  assert.doesNotMatch(richTextSource, /input\.title \|\| row\.title \|\| product\.title/);
  assert.doesNotMatch(richTextSource, /row\.generatedMainImageUrl \|\| product\.imageUrl/);
  assert.match(serviceSource, /\["title", "tags", "description", "richText"\]\.includes\(fieldKey\)/);
  assert.match(serviceSource, /input\.variantTarget \|\| input\.variant_target/);
});

test("ai variant draft save writes rich text JSON to explicit draft fields", () => {
  assert.match(listingAutomationSource, /richContentJson/);
  assert.match(listingAutomationSource, /patch\.rich_content_json \|\| patch\.richContentJson \|\| patch\.richTextContent \|\| patch\.richText/);
  assert.match(listingAutomationSource, /next\.rich_content_json = richContentJson/);
  assert.match(listingAutomationSource, /attribute_id: 11254/);
});

test("ai variant tags drop other vehicle model tags before saving", () => {
  assert.match(serviceSource, /!extractVehicleModel\(tag\)/);
  assert.match(serviceSource, /cleaned\.unshift\(`#\$\{target\}`\)/);
});

test("ai variant description fallback does not leak Chinese category text", () => {
  const description = aiTaskInternals.fallbackVariantDescription({
    targetModel: "HAVAL F7",
    categoryName: "汽车用品 / 汽车改装和外部装饰 / 汽车装饰贴片",
    productType: "汽车用品 / 汽车改装和外部装饰 / 汽车装饰贴片",
    material: ["Нержавеющая", "Сталь"]
  });

  assert.equal(aiTaskInternals.hasCjkText(description), false);
  assert.match(description, /HAVAL F7/);
  assert.doesNotMatch(description, /汽车用品/);
});

test("ai variant target validation distinguishes HAVAL F7 from HAVAL F7X", () => {
  assert.throws(() => aiTaskInternals.assertVariantTextMatchesTarget(
    "description",
    "Автоаксессуар для HAVAL F7X помогает защитить пороги.",
    { targetModel: "HAVAL F7" }
  ), /非目标车型|目标车型|车型/);

  assert.doesNotThrow(() => aiTaskInternals.assertVariantTextMatchesTarget(
    "description",
    "Автоаксессуар для HAVAL F7 помогает защитить пороги.",
    { targetModel: "HAVAL F7" }
  ));
});

test("ai variant tags remove compact source vehicle tags", () => {
  const tags = aiTaskInternals.normalizeVariantTags([
    "#HAVALF7X",
    "#TENETT4",
    "#аксессуарыTENETT4",
    "#автоаксессуар"
  ], {
    targetModel: "HAVAL F7X",
    sourceContext: { sourceModel: "TENET T4" }
  });

  assert(tags.some((tag) => /HAVALF7X|HAVAL F7X/i.test(tag)));
  assert.equal(tags.some((tag) => /TENETT4|TENET T4/i.test(tag)), false);
});

test("ai variant tags keep up to 25 target-safe tags", () => {
  const tags = aiTaskInternals.normalizeVariantTags([
    "#haval_f7",
    "#haval_f7_accessories",
    "#haval_f7_parts",
    "#haval_f7_trim",
    "#for_haval_f7",
    "#door_sill_guards",
    "#door_sill_trim",
    "#scuff_plate",
    "#sill_protection",
    "#car_accessories",
    "#interior_trim",
    "#scratch_protection",
    "#body_protection",
    "#easy_install",
    "#self_adhesive",
    "#no_drilling",
    "#durable_abs",
    "#gloss_black",
    "#piano_black",
    "#set_of_4",
    "#abs_plastic",
    "#car_styling",
    "#threshold_cover",
    "#entry_guard",
    "#auto_parts",
    "#extra_tag"
  ], {
    targetModel: "HAVAL F7",
    sourceContext: { sourceModel: "TENET T4" }
  });

  assert.equal(tags.length, 25);
  assert.equal(tags.includes("#extra_tag"), false);
  assert(tags.some((tag) => /haval[_ ]?f7/i.test(tag)));
});

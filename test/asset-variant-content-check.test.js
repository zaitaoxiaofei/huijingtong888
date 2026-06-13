import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { inspectAssetVariantListingContent } from "../src/services/asset-variant-engine.js";

const assetVariantSource = readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");

test("asset variant content check accepts clean product content without shop-name requirements", () => {
  const result = inspectAssetVariantListingContent({
    title: "Накладка на ремень безопасности, мягкая плечевая подушка, черная, 2 шт.",
    categoryName: "Аксессуары для ремней безопасности",
    shopName: "ViberMart",
    tags: [
      "#накладка",
      "#ремень_безопасности",
      "#плечевая_подушка",
      "#мягкая",
      "#черная",
      "#комфорт",
      "#daily_use"
    ],
    description: "Накладка на ремень безопасности помогает сделать поездку комфортнее и уменьшает давление ремня на плечо.",
    richContent: JSON.stringify({
      content: [{
        widgetName: "raShowcase",
        blocks: [{
          text: { items: [{ content: "Мягкая накладка подходит для ремня безопасности." }] }
        }]
      }]
    })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("asset variant content check blocks non-key product with key-case terms", () => {
  const result = inspectAssetVariantListingContent({
    title: "Накладка на ремень безопасности",
    categoryName: "Аксессуары для ремней безопасности",
    shopName: "ViberMart",
    tags: ["#ViberMart", "#car_key_case", "#key_cover", "#ремень_безопасности"],
    description: "Описание ViberMart для мягкой накладки на ремень безопасности.",
    richContent: ""
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Non-key product content contains key-case related terms/);
});

test("asset variant content check allows Cyrillic key products to use key-case terms", () => {
  const result = inspectAssetVariantListingContent({
    title: "Защитный чехол для ключей TENET T4/T4L",
    categoryName: "Автоаксессуары для ключей",
    shopName: "RuVibe Mart",
    tags: ["#RuVibeMart", "#key_cover", "#чехол", "#ключей", "#TENET", "#T4", "#T4L", "#TPU"],
    description: "RuVibe Mart предлагает защитный чехол для автомобильных ключей TENET T4/T4L.",
    richContent: ""
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("asset variant templates keep Ozon hashtag attributes editable", () => {
  assert.match(assetVariantSource, /attribute_id: 23171/);
  assert.match(assetVariantSource, /type: "multiselect"/);
  assert.match(assetVariantSource, /sourceRaw\.tags \|\| sourceRaw\.hashtags/);
  assert.match(assetVariantSource, /tags,/);
});

test("selection listing generation keeps key lanyards separate from key cases", () => {
  assert.match(assetVariantSource, /function looksLikeKeyLanyard\(text = ""\)/);
  assert.match(assetVariantSource, /手绳\|挂绳\|钥匙扣/);
  assert.match(assetVariantSource, /Брелок-ремешок для автомобильного ключа/);
  assert.match(assetVariantSource, /брелок_для_ключей/);
  assert.match(assetVariantSource, /ремешок_для_ключей/);
});

test("selection listing generation respects manual listing tags without appending shop tag", () => {
  assert.match(assetVariantSource, /const manualTags = normalizeTags\(cleanRussianListingText\(material\.listingTagsRu, 800\)\);/);
  assert.match(assetVariantSource, /if \(manualTags\.length\) \{\s+return normalizeListingTags\(manualTags, 40\);/);
  assert.doesNotMatch(assetVariantSource, /return normalizeListingTags\(\[\.\.\.manualTags, generatedShopTag\], 40\);/);
});

test("selection listing generation builds a product facts layer from manual Russian fields", () => {
  assert.match(assetVariantSource, /function buildListingProductFacts\(material = \{\}, shop = \{\}\)/);
  assert.match(assetVariantSource, /listingTitleRu: cleanRussianListingText\(raw\.listingTitleRu \|\| raw\.listing_title_ru/);
  assert.match(assetVariantSource, /listingTagsRu: cleanRussianListingText\(raw\.listingTagsRu \|\| raw\.listing_tags_ru/);
  assert.match(assetVariantSource, /listingDescriptionRu: cleanRussianListingText\(raw\.listingDescriptionRu \|\| raw\.listing_description_ru/);
  assert.match(assetVariantSource, /hasManualRussianTitle/);
  assert.match(assetVariantSource, /authoritativeFields/);
  assert.match(assetVariantSource, /const productFacts = buildListingProductFacts\(material, shop\);/);
});

test("selection listing generation infers package quantity from manual title and description", () => {
  const quantityFunction = assetVariantSource.match(/function assetVariantQuantity\(value, context = \{\}\)[\s\S]*?\n}/)?.[0] || "";
  assert.match(assetVariantSource, /manualTitleRu/);
  assert.match(assetVariantSource, /manualDescriptionRu/);
  assert.match(assetVariantSource, /件套\|件装\|个装/);
  assert.match(assetVariantSource, /quantityText = productFacts\.quantity/);
  assert.match(assetVariantSource, /function assetVariantQuantity\(value, context = \{\}\)/);
  assert.doesNotMatch(quantityFunction, /\|\| 1/);
});

test("asset variant template reuses generated videos as video covers", () => {
  assert.match(assetVariantSource, /video_urls: videoUrls/);
  assert.match(assetVariantSource, /video_cover_urls: videoUrls/);
});

test("asset variant job errors distinguish missing tail templates from product images", () => {
  assert.match(assetVariantSource, /lower\.includes\("asset-tail-templates"\)/);
  assert.match(assetVariantSource, /code: "tail_template_missing"/);
  assert.match(assetVariantSource, /message: "店铺尾图模板文件不存在，无法生成上架素材"/);
});

test("asset variant tail template lookup falls back to public uploads storage", () => {
  assert.match(assetVariantSource, /resolveAssetTailTemplateFile/);
  assert.match(assetVariantSource, /"public", "uploads", "asset-tail-templates"/);
});

test("asset variant precheck reads generated rich content and videos from Ozon attributes", () => {
  assert.match(assetVariantSource, /function extractAssetVariantVideosForCheck\(firstItem = \{\}, payload = \{\}\)/);
  assert.match(assetVariantSource, /extractAssetVariantComplexAttributeValues\(firstItem, 21841\)/);
  assert.match(assetVariantSource, /function extractAssetVariantRichContentForCheck\(firstItem = \{\}, payload = \{\}, template = \{\}\)/);
  assert.match(assetVariantSource, /attributeValueForCheck\(firstItem\.attributes, 11254\)/);
});

test("asset variant Ozon precheck uses shop-aware publish validation", () => {
  assert.match(assetVariantSource, /validateListingTemplatePublishForShop/);
  assert.match(assetVariantSource, /await validateListingTemplatePublishForShop\(template, shopId, session\)/);
});

test("asset variant generation does not auto-multiply listing prices", () => {
  assert.doesNotMatch(assetVariantSource, /internalPrice\s*\*\s*2/);
  assert.doesNotMatch(assetVariantSource, /internalPrice\s*\*\s*4/);
  assert.doesNotMatch(assetVariantSource, /internal_price\)[^,\n]*\*\s*2/);
  assert.doesNotMatch(assetVariantSource, /internal_price\)[^,\n]*\*\s*4/);
});

test("asset variant precheck does not require shop names in tags, description, or rich content", () => {
  assert.doesNotMatch(assetVariantSource, /Product tags must include shop tag/);
  assert.doesNotMatch(assetVariantSource, /Description must mention shop name/);
  assert.doesNotMatch(assetVariantSource, /Rich content text should mention shop name/);
  assert.doesNotMatch(assetVariantSource, /ensureShopBoundDescription/);
  assert.doesNotMatch(assetVariantSource, /Добро пожаловать за покупками/);
});

test("asset variant generation separates text and image concurrency without automatic video", () => {
  assert.match(assetVariantSource, /const ASSET_TEXT_CONCURRENCY = envInt\("ASSET_TEXT_CONCURRENCY", 10/);
  assert.match(assetVariantSource, /const ASSET_VARIANT_IMAGE_CONCURRENCY = envInt\("ASSET_VARIANT_IMAGE_CONCURRENCY", 3/);
  assert.match(assetVariantSource, /mapWithConcurrency\(shops, ASSET_TEXT_CONCURRENCY/);
  assert.match(assetVariantSource, /mapWithConcurrency\(textPlans, ASSET_VARIANT_IMAGE_CONCURRENCY/);
  const generateSection = assetVariantSource.match(/export async function generateAssetVariants[\s\S]*?export async function saveAiOptimizationGeneratedAsset|export async function generateAssetVariants[\s\S]*?export async function generateAssetVariantVideoFromImage/)?.[0] || "";
  assert.doesNotMatch(generateSection, /ensureAssetVariantVideoFromImages\(null, storedVariant/);
  assert.match(generateSection, /const videos = \[\]/);
});

test("asset variant on-demand video generation has a bounded timeout", () => {
  assert.match(assetVariantSource, /const SERVER_VIDEO_GENERATION_TIMEOUT_MS = envInt\("SERVER_VIDEO_GENERATION_TIMEOUT_MS", 70000/);
  assert.match(assetVariantSource, /function withTimeout\(promise, timeoutMs/);
  assert.match(assetVariantSource, /withTimeout\(ensureAssetVariantVideoFromImages\(null, variant/);
  assert.match(assetVariantSource, /视频生成超时，请稍后重试或先保存草稿/);
});

test("asset variant on-demand video reports unreadable source images as validation errors", () => {
  const videoSection = assetVariantSource.match(/export async function generateAssetVariantVideoFromImage[\s\S]*?export async function generateListingVariantMediaFromImage/)?.[0] || "";
  assert.match(videoSection, /buildAssetVariantJobErrorPayload\(error\)/);
  assert.match(videoSection, /local_image_missing/);
  assert.match(videoSection, /remote_image_unavailable/);
  assert.match(videoSection, /normalized\.status = 400/);
  assert.match(videoSection, /normalized\.validation = payload/);
  assert.match(assetVariantSource, /远程图片下载失败：\$\{response\.status\}/);
});

test("asset variant on-demand video accepts public preview images without public sync", () => {
  assert.match(assetVariantSource, /withoutLeadingSlash\.startsWith\("preview-assets\/"\)/);
  assert.match(assetVariantSource, /path\.resolve\(root, "public", withoutLeadingSlash\)/);
  assert.match(assetVariantSource, /skipPublicSync:\s*true/);
  assert.match(assetVariantSource, /skipPublicSync:\s*context\.skipPublicSync \|\| context\.skip_public_sync \|\| false/);
});

test("asset variant video reads generated AI file API images from local storage", () => {
  assert.match(assetVariantSource, /function isLocalFileApiSource\(value = ""\)/);
  assert.match(assetVariantSource, /isLocalFileApiSource\(text\)/);
  assert.match(assetVariantSource, /api\\\/ai\\\/file\\\/\[\^\/\]\+\\\/\(\?:generated\|cropped\)\\\/\.\+/);
  assert.match(assetVariantSource, /const AI_GENERATED_ROOT = path\.resolve\(ROOT_DIR, process\.env\.AI_IMAGE_OUTPUT_DIR \|\| "uploads\/ai-generated"\)/);
  assert.match(assetVariantSource, /const AI_CROPPED_ROOT = path\.resolve\(ROOT_DIR, process\.env\.AI_CROP_OUTPUT_DIR \|\| "uploads\/ai-cropped"\)/);
  assert.match(assetVariantSource, /function aiFileRootCandidates\(scope = "generated"\)/);
  assert.match(assetVariantSource, /path\.resolve\(root, "dist", "preview", "uploads", folder\)/);
  assert.match(assetVariantSource, /path\.resolve\(root, "dist", "deploy", "uploads", folder\)/);
  assert.match(assetVariantSource, /candidates\.find\(\(candidate\) => fsSync\.existsSync\(candidate\)\)/);
});

test("asset variant rich text can publish internal generated images before embedding them", () => {
  assert.match(assetVariantSource, /export async function ensureAssetVariantImagePublishUrl\(source = "", context = {}\)/);
  assert.match(assetVariantSource, /source_module: context\.sourceModule \|\| context\.source_module \|\| "ai_variant_rich_text"/);
  assert.match(assetVariantSource, /role: context\.role \|\| "rich_text_image"/);
  assert.match(assetVariantSource, /status: publishUrl \? "public_ready" : "local_ready"/);
});

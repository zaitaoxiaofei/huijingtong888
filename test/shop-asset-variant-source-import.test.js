import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ShopAssetVariantCenter.vue", import.meta.url), "utf8");
const optimizationSource = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");
const variantSource = readFileSync(new URL("../frontend/admin/views/listing/AssetVariantCenter.vue", import.meta.url), "utf8");

test("collector source image import is bounded and timed out", () => {
  assert.match(source, /const SOURCE_DETAIL_IMAGE_LIMIT = 24/);
  assert.match(source, /const SOURCE_IMAGE_META_CONCURRENCY = 4/);
  assert.match(source, /const SOURCE_IMAGE_META_TIMEOUT_MS = 4500/);
  assert.match(source, /async function imageMetasFromUrls\(urls = \[\]\)/);
  assert.match(source, /slice\(0, SOURCE_DETAIL_IMAGE_LIMIT\)/);
  assert.match(source, /Math\.min\(SOURCE_IMAGE_META_CONCURRENCY, limitedUrls\.length\)/);
  assert.match(source, /window\.setTimeout/);
});

test("asset variant imports preserve category metadata from nested source payloads", () => {
  for (const fileSource of [source, variantSource]) {
    assert.match(fileSource, /function categoryMetaFromPayloads\(payloads = \[\]\)/);
    assert.match(fileSource, /objectValue\(item\.editPayload\)|parseMaybeJson\(item\.editPayload\)/);
    assert.match(fileSource, /"category_ids", "categoryIds"/);
    assert.match(fileSource, /descriptionCategoryId && typeId \? `\$\{descriptionCategoryId\}:\$\{typeId\}` : ""/);
  }
  assert.match(optimizationSource, /AiOptimizationWorkbenchRuntime/);
  assert.match(source, /material\.ozonCategoryId = categoryMeta\.ozonCategoryId/);
  assert.match(source, /material\.ozonCategoryName = categoryMeta\.categoryName/);
  assert.match(variantSource, /ozonCategoryId: categoryMeta\.ozonCategoryId/);
});

test("collector source import does not load every detail image at once", () => {
  assert.doesNotMatch(source, /detailImages\.map\(\(url, index\) => imageMetaFromUrl\(url, `详情图 \$\{index \+ 1\}`\)\)/);
  assert.match(source, /material\.detailImages = await imageMetasFromUrls\(detailImages\)/);
});

test("asset variant source import gives user assets highest image priority", () => {
  assert.match(source, /function sourceAssetImages\(payloads = \[\]\)/);
  assert.match(source, /const editVariantImages = normalizeSourceImageList/);
  assert.match(source, /sourceAssetImages\(payloads\),\s*editVariantImages,\s*edit\.images,\s*edit\.image_urls,\s*edit\.imageUrls,\s*templateSnapshotImagesFromSource\(product\)/s);
  assert.match(variantSource, /const userAssetImages = sourceAssetImages\(payloads\)/);
  assert.match(variantSource, /const editedVariantAssetImages = editableVariantAssetImages\(row\)/);
  assert.match(variantSource, /const editedAssetImages = payloadImages\(editableAssetPayloads\(row\), \["images"/);
  assert.match(variantSource, /const imageList = userAssetImages\.length\s*\?\s*userAssetImages/s);
  assert.match(variantSource, /const allImages = userAssetImages\.length\s*\?\s*userAssetImages/s);
});

test("asset variant import candidate lists use paged lightweight source APIs", () => {
  assert.match(variantSource, /new URLSearchParams\(\{ paged: "1", page: "1", pageSize: "12" \}\)/);
});

test("asset variant draft import hydrates full draft detail before template fallback", () => {
  const hydrateImportProduct = variantSource.match(/async function hydrateImportProduct\(product, index\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(hydrateImportProduct, /\/api\/listing\/drafts\/\$\{encodeURIComponent\(product\.sourceId\)\}/);
  assert.match(hydrateImportProduct, /\/api\/listing\/templates\/\$\{encodeURIComponent\(product\.raw\.template_id\)\}/);
  assert.match(hydrateImportProduct, /template_snapshot: draftDetail\?\.template_snapshot \|\| draftDetail\?\.template \|\| template/);
  assert.match(hydrateImportProduct, /\.\.\.\(draftDetail \|\| \{\}\)/);
});

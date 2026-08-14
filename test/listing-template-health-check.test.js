import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const listingAutomationViewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const ozonCategorySelectSource = readFileSync(new URL("../frontend/admin/components/listing/OzonCategorySelect.vue", import.meta.url), "utf8");
const assetVariantEngineSource = readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");

test("listing template health check service summarizes templates and publish records", () => {
  assert.match(listingSource, /export async function listingTemplateHealthCheck/);
  assert.match(listingSource, /listingTemplateMappingDiagnostics/);
  assert.match(listingSource, /listingPublishRecordDetail/);
  assert.match(listingSource, /summarizeHealthCheckRows/);
  assert.match(listingSource, /by_source_type/);
});

test("listing template health check does not scan online products unless explicitly enabled", () => {
  assert.match(listingSource, /const includeOnlineProducts = String\(query\.online_products \|\| query\.onlineProducts \|\| ""\)\.toLowerCase\(\) === "1"/);
  assert.match(listingSource, /LIMIT \?/);
  assert.match(listingSource, /Math\.min\(limit, 10\)/);
});

test("listing template health check is exposed through runtime service and API route", () => {
  assert.match(runtimeSource, /listingTemplateHealthCheck/);
  assert.match(routeSource, /GET \/api\/listing\/template-health-check/);
  assert.match(routeSource, /services\.listingTemplateHealthCheck\(req\.query \|\| \{\}, req\._session\)/);
});

test("listing publish validation includes category cache diagnostics", () => {
  assert.match(listingSource, /export async function listingCategoryPublishDiagnostics/);
  assert.match(listingSource, /buildListingCategoryPublishDiagnostics/);
  assert.match(listingSource, /shouldIncludeCategoryPublishDiagnostics/);
  assert.match(listingSource, /include_category_health/);
  assert.match(listingSource, /Missing cached required Ozon attributes/);
  assert.match(listingSource, /Required dictionary values are not cached/);
  assert.match(runtimeSource, /listingCategoryPublishDiagnostics/);
  assert.match(routeSource, /POST \/api\/listing\/templates\/category-diagnostics/);
});

test("listing automation view exposes a common template health panel", () => {
  assert.match(listingAutomationViewSource, /templateHealthFilters = reactive\(\{/);
  assert.match(listingAutomationViewSource, /onlineProducts: false/);
  assert.match(listingAutomationViewSource, /\/api\/listing\/template-health-check\?\$\{buildTemplateHealthQuery\(\)\.toString\(\)\}/);
  assert.match(listingAutomationViewSource, /公共上架模板体检/);
  assert.match(listingAutomationViewSource, /path: "\/listing-records\/edit"/);
  assert.match(listingAutomationViewSource, /path: "\/online-products"/);
});

test("listing automation publish drawer renders category diagnostics", () => {
  assert.match(listingAutomationViewSource, /publishCategoryHealth = computed/);
  assert.match(listingAutomationViewSource, /categoryHealthTitle/);
  assert.match(listingAutomationViewSource, /类目诊断/);
  assert.match(listingAutomationViewSource, /publishCategoryHealth\.dictionary_attributes/);
  assert.match(listingAutomationViewSource, /缺失 Ozon 必填属性/);
});

test("listing automation view does not restore stale local drafts for routed sources", () => {
  assert.match(listingAutomationViewSource, /const hasBootstrap = hasListingBootstrapParams\(\);/);
  assert.match(listingAutomationViewSource, /localStorage\.removeItem\(listingWorkbenchDraftStorageKey\.value\);/);
  assert.match(listingAutomationViewSource, /if \(!hasBootstrap && hasLocalDraft && restoreListingWorkbenchDraft\(\)\) return;/);
});

test("listing automation locks collected attributes until a real Ozon category is selected", () => {
  assert.match(listingAutomationViewSource, /const hasValidOzonCategory = computed\(\(\) => \{/);
  assert.match(listingAutomationViewSource, /descriptionCategoryId > 0 && typeId > 0 && !categoryId\.startsWith\("frontend:"\)/);
  assert.match(listingAutomationViewSource, /title="产品的 Ozon 类目未填写完整，商品属性暂不可编辑"/);
  assert.match(listingAutomationViewSource, /:class="\{ 'category-attributes-locked': categoryAttributesLocked \}"/);
  assert.match(listingAutomationViewSource, /:inert="categoryAttributesLocked"/);
  assert.match(listingAutomationViewSource, /\.category-attributes-locked :deep\(\.el-table__body-wrapper\) \{ pointer-events: none;/);
});

test("listing automation view hides raw dict ids and avoids saving unknown dict placeholders", () => {
  assert.match(listingAutomationViewSource, /return dictId \? "待同步字典值" : localizeAttributeDisplayText\(attributeOptionText\(option\), field\)/);
  assert.match(listingAutomationViewSource, /if \(matchedById\) return displayAttributeOptionLabel\(matchedById, field\);/);
  assert.doesNotMatch(listingAutomationViewSource, /field\.raw\?\.value\?\.values/);
  assert.doesNotMatch(listingAutomationViewSource, /field\.raw\?\.attribute_values/);
  assert.doesNotMatch(listingAutomationViewSource, /`字典值\s+\$\{dictId\}`/);
});

test("listing automation view uses dictionary labels in variant attribute cells", () => {
  assert.match(listingAutomationViewSource, /function variantAttributeSelectModelValue/);
  assert.match(listingAutomationViewSource, /function updateVariantAttributeSelectValue/);
  assert.match(listingAutomationViewSource, /class="flat-attribute-control"/);
  assert.match(listingAutomationViewSource, /:model-value="variantAttributeSelectModelValue\(row, field\)"/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateVariantAttributeSelectValue\(row, field, \$event\)"/);
});

test("listing automation view renders multiselect labels without heavy tag slots", () => {
  assert.match(listingAutomationViewSource, /field\.type === "multiselect" \? displayAttributeOptionLabel\(option, field\) : attributeOptionModelValue\(option\)/);
  assert.doesNotMatch(listingAutomationViewSource, /<template #tag=/);
  assert.doesNotMatch(listingAutomationViewSource, /attributeSelectTagLabel\(field, data\)/);
});

test("listing automation merges Ozon attributes into the SKU table only", () => {
  assert.match(listingAutomationViewSource, /Ozon 商品表格/);
  assert.match(listingAutomationViewSource, /const flatSkuAttributeFields = computed/);
  assert.match(listingAutomationViewSource, /const flatSkuProductAttributeFields = computed/);
  assert.match(listingAutomationViewSource, /const flatSkuOtherAttributeFields = computed/);
  assert.match(listingAutomationViewSource, /function shouldSkipFlatSkuAttributeField\(field = \{\}\)/);
  assert.match(listingAutomationViewSource, /shouldSkipFlatSkuAttributeField\(field\)/);
  assert.match(listingAutomationViewSource, /if \(isOriginCountryAttribute\(field\) \|\| isMaterialAttribute\(field\)\) return false/);
  assert.match(listingAutomationViewSource, /const mergedAttributeSource = \[/);
  assert.match(listingAutomationViewSource, /template\.category_attributes/);
  assert.match(listingAutomationViewSource, /dedupeAttributeFields\(normalizeEditorAttributes/);
  assert.match(listingAutomationViewSource, /template\.description_category_id \|\| template\.descriptionCategoryId/);
  assert.match(listingAutomationViewSource, /template\.type_id \|\| template\.typeId/);
  assert.match(listingAutomationViewSource, /const ozonCategoryParts = String\(ozonCategoryValue \|\| ""\)\.split\(":"\)/);
  assert.match(listingAutomationViewSource, /ozonCategoryParts\[0\]/);
  assert.match(listingAutomationViewSource, /ozonCategoryParts\[1\]/);
  assert.match(listingAutomationViewSource, /function ensureFullCategoryAttributesLoaded\(\)/);
  assert.match(listingAutomationViewSource, /await hydrateLoadedCategorySchema\(\)/);
  assert.match(listingAutomationViewSource, /@click="syncFullCategorySchema">同步 Ozon 字段<\/el-button>/);
  assert.doesNotMatch(listingAutomationViewSource, /class="ozon-attribute-table"/);
  assert.doesNotMatch(listingAutomationViewSource, /class="form-shell attribute-table-shell"/);
  assert.doesNotMatch(listingAutomationViewSource, /class="editor-block product-attributes-block"/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-table-column label="来源"/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-form-item label="JSON富内容"/);
});

test("listing automation keeps only workflow fields in the top main info block", () => {
  assert.match(listingAutomationViewSource, /<el-form-item label="上架店铺">/);
  assert.match(listingAutomationViewSource, /<el-form-item label="文案变体">/);
  assert.match(listingAutomationViewSource, /<el-form-item label="产品类目" required>/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-form-item label="标题" required>/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-form-item label="品牌" required>/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-form-item label="包装重量" required>/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-form-item label="包装尺寸" required>/);
  assert.doesNotMatch(listingAutomationViewSource, /这里展示当前 Ozon 类目同步到的全部字段，每个字段独立一行编辑。/);
});

test("listing automation renders all synced Ozon attributes without optional pagination", () => {
  assert.match(listingAutomationViewSource, /const hiddenAttributeFields = computed\(\(\) => dedupeAttributeFields\(templateEditor\.attributes\)\.sort\(sortSchemaAttributeFields\)/);
  assert.match(listingAutomationViewSource, /const mainAttributeFields = computed\(\(\) => optionalSchemaAttributeFields\.value\)/);
  assert.doesNotMatch(listingAutomationViewSource, /OPTIONAL_ATTRIBUTE_PAGE_SIZE/);
  assert.doesNotMatch(listingAutomationViewSource, /optionalAttributeVisibleLimit/);
  assert.doesNotMatch(listingAutomationViewSource, /继续显示/);
  assert.doesNotMatch(listingAutomationViewSource, /showMoreAttributes\.value \? 72 : 40/);
  assert.doesNotMatch(listingAutomationViewSource, /\(\) => JSON\.stringify\(materialSearch\)/);
});

test("listing automation edits variant dictionary attributes lazily", () => {
  assert.match(listingAutomationViewSource, /function variantAttributeDisplayText\(row = \{\}, field = \{\}\)/);
  assert.match(listingAutomationViewSource, /function flatSkuAttributeOptions\(row = \{\}, field = \{\}\)/);
  assert.match(listingAutomationViewSource, /@visible-change="ensureAttributeValuesLoaded\(field, \$event\)"/);
  assert.doesNotMatch(listingAutomationViewSource, /SKU属性编辑/);
  assert.doesNotMatch(listingAutomationViewSource, /variantAttributeDrawer/);
  assert.match(listingAutomationViewSource, /const ATTRIBUTE_OPTION_LOAD_LIMIT = 2000/);
  assert.match(listingAutomationViewSource, /limit: String\(colorField \? COLOR_ATTRIBUTE_OPTION_LOAD_LIMIT : ATTRIBUTE_OPTION_LOAD_LIMIT\)/);
  assert.doesNotMatch(listingAutomationViewSource, /function attributeHasMoreOptions/);
  assert.doesNotMatch(listingAutomationViewSource, /\.slice\(0, ATTRIBUTE_OPTION_RENDER_LIMIT\)/);
  assert.doesNotMatch(listingAutomationViewSource, /仅显示前 \$\{ATTRIBUTE_OPTION_RENDER_LIMIT\}/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-option v-for="option in variantAttributeOptions\(row, field\)"/);
});

test("listing Ozon attribute values API allows large dictionary dropdowns", () => {
  assert.match(listingSource, /Math\.min\(Math\.max\(Number\(query\.limit \|\| 80\), 1\), 2000\)/);
});

test("listing dictionary localization never treats Russian fallback text as Chinese", () => {
  assert.match(listingSource, /display_value_zh NOT REGEXP '\[А-Яа-яЁё\]'/);
  assert.match(listingSource, /storedDisplayValue && !hasCyrillicText\(storedDisplayValue\)/);
  assert.match(listingSource, /return hasCyrillicText\(text\) \? "" : text/);
  assert.match(listingAutomationViewSource, /const dictionaryOptions = attributeValueLoading\[attributeFieldKey\(field\)\][\s\S]*selectedAttributeOptions\(field\)[\s\S]*renderedAttributeOptions\(field\)/);
  assert.match(listingAutomationViewSource, /return Boolean\(attributeValueLoading\[attributeFieldKey\(field\)\]\)/);
  const dedupeSource = listingAutomationViewSource.match(/function dedupeAttributeOptions\(options = \[\]\)[\s\S]*?function dedupeVariantAttributeFields/)?.[0] || "";
  assert.match(dedupeSource, /const byKey = new Map\(\)/);
  assert.match(dedupeSource, /attributeOptionZhScore\(option\) > attributeOptionZhScore\(previous\)/);
});

test("listing automation renders SKU variants in an Ozon-like flat table", () => {
  assert.match(listingAutomationViewSource, /const flatSkuAttributeFields = computed/);
  assert.match(listingAutomationViewSource, /const hasFlatSkuVariantFeatureColumns = computed/);
  assert.match(listingAutomationViewSource, /const hasFlatSkuMainAttributeColumns = computed/);
  assert.match(listingAutomationViewSource, /function fixedFlatSkuFieldDisplayText\(key, row = \{\}\)/);
  assert.doesNotMatch(listingAutomationViewSource, /class="editor-block product-attributes-block"/);
  assert.match(listingAutomationViewSource, /Ozon 商品表格/);
  assert.match(listingAutomationViewSource, /label="商品信息"/);
  assert.match(listingAutomationViewSource, /label="媒体"/);
  assert.match(listingAutomationViewSource, /label="变体特征"/);
  assert.match(listingAutomationViewSource, /label="价格"/);
  assert.doesNotMatch(listingAutomationViewSource, /v-if="hasFlatSkuMainAttributeColumns" label="主要属性"/);
  assert.match(listingAutomationViewSource, /flatSkuAttributeGroupLabel\(field\) }} · {{ field\.name/);
  assert.doesNotMatch(listingAutomationViewSource, /v-if="flatSkuProductAttributeFields\.length" label="产品属性"/);
  assert.doesNotMatch(listingAutomationViewSource, /v-if="flatSkuOtherAttributeFields\.length" label="其它属性"/);
  assert.match(listingAutomationViewSource, /<span><em>\*<\/em> 货号 \/ offer_id<\/span>/);
  assert.match(listingAutomationViewSource, /<span>SKU 名称<\/span>/);
  assert.match(listingAutomationViewSource, /<span>视频封面<\/span>/);
  assert.match(listingAutomationViewSource, /<span>划线价<\/span>/);
  assert.match(listingAutomationViewSource, /<span>品牌<\/span>/);
  assert.match(listingAutomationViewSource, /<span>型号名称<\/span>/);
  assert.match(listingAutomationViewSource, /<span>#产品标签<\/span>/);
  assert.match(listingAutomationViewSource, /<span>简介<\/span>/);
  assert.match(listingAutomationViewSource, /@click="applyFirstFlatSharedField">同首行<\/el-button>/);
  assert.match(listingAutomationViewSource, /@click="applyFirstVariantAttribute\(field\)">同首行<\/el-button>/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateFixedField\('brand', \$event\)"/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateVariantModelValue\(row, \$event\)"/);
  assert.match(listingAutomationViewSource, /class="flat-dimensions-cell"/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateFixedTags"/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateFixedField\('summary', \$event\)"/);
  assert.match(listingAutomationViewSource, /class="flat-attribute-control"/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateVariantAttributeSelectValue\(row, field, \$event\)"/);
  assert.match(listingAutomationViewSource, /function generateVariantRichContentJson\(row = \{\}, field = \{\}, position = "last"\)/);
  assert.match(listingAutomationViewSource, /@click="generateVariantRichContentJson\(row, field, 'first'\)">首图生成/);
  assert.match(listingAutomationViewSource, /@click="generateVariantRichContentJson\(row, field, 'last'\)">尾图生成/);
  assert.match(listingAutomationViewSource, /const fixedVariantAttributeDefinitions = \{/);
  assert.match(listingAutomationViewSource, /function toggleFixedVariantAttributeField\(key\)/);
  assert.match(listingAutomationViewSource, /isFixedVariantAttributeFieldEnabled\('summary'\)/);
  assert.match(listingAutomationViewSource, /\.copy-form \{ display: flex; flex-direction: column; \}/);
  assert.match(listingAutomationViewSource, /\.variants-block \{ order: 2;/);

  const offerIndex = listingAutomationViewSource.indexOf("货号 / offer_id");
  const nameIndex = listingAutomationViewSource.indexOf("SKU 名称", offerIndex);
  const imageIndex = listingAutomationViewSource.indexOf("<span><em>*</em> 图片</span>", nameIndex);
  const coverIndex = listingAutomationViewSource.indexOf("视频封面", imageIndex);
  const colorIndex = listingAutomationViewSource.indexOf("<span>颜色</span>", coverIndex);
  const priceIndex = listingAutomationViewSource.indexOf("<span>售价</span>", colorIndex);
  assert.ok(offerIndex < nameIndex);
  assert.ok(nameIndex < imageIndex);
  assert.ok(imageIndex < coverIndex);
  assert.ok(coverIndex < colorIndex);
  assert.ok(colorIndex < priceIndex);
});

test("listing model names stay variant-specific and generated identifiers can be overwritten", () => {
  assert.match(listingAutomationViewSource, /function seedVariantModelValue\(row = \{\}, source = \{\}, fallback = fixedForm\.value\.model\)/);
  assert.match(listingAutomationViewSource, /source\.model_name, source\.modelName, source\.model/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateVariantModelValue\(row, \$event\)"/);
  assert.match(listingAutomationViewSource, /@click="generateAllVariantModelNames">一键生成<\/el-button>/);
  assert.match(listingAutomationViewSource, /@click="generateVariantModelName\(row\)">生成<\/el-button>/);
  assert.match(listingAutomationViewSource, /function generateAllVariantOfferIds\(\)/);
  assert.match(listingAutomationViewSource, /const existingIds = new Set\(\);/);
  assert.doesNotMatch(listingAutomationViewSource, /missingVariantOfferIds/);
});

test("listing dictionary dropdowns keep Chinese labels clean and tags beside media summary", () => {
  assert.match(listingAutomationViewSource, /function removeRawDictionaryAliases\(options = \[\]\)/);
  assert.match(listingAutomationViewSource, /findAttributeOptionByValue\(field, text\) \|\| \(text \? \{ value: text/);
  assert.match(listingAutomationViewSource, /entry\.selected_values = dedupeAttributeOptions\(selectedOptions\)/);
  assert.match(listingAutomationViewSource, /delete entry\.selectedValues/);
  assert.match(listingAutomationViewSource, /<el-table[\s\S]*?stripe[\s\S]*?class="variant-table dense-variant-table"/);
  assert.match(listingAutomationViewSource, /\.variant-table \{[^}]*border-radius: 12px/);

  const mediaIndex = listingAutomationViewSource.indexOf('<el-table-column label="媒体">');
  const summaryIndex = listingAutomationViewSource.indexOf("<span>简介</span>", mediaIndex);
  const tagsIndex = listingAutomationViewSource.indexOf("<span>#产品标签</span>", summaryIndex);
  const featureIndex = listingAutomationViewSource.indexOf('label="变体特征"', tagsIndex);
  assert.ok(mediaIndex < summaryIndex);
  assert.ok(summaryIndex < tagsIndex);
  assert.ok(tagsIndex < featureIndex);
});

test("listing automation does not render variant media previews on first paint", () => {
  assert.match(listingAutomationViewSource, /if \(!row\?\._mediaPreviewEnabled\) return \[\];/);
  assert.match(listingAutomationViewSource, /row\._mediaPreviewEnabled = true;/);
  assert.match(listingAutomationViewSource, /return images\.filter\(\(item\) => editorImageKey\(item\)\)\.slice\(0, 1\);/);
});

test("listing automation safe opens routed templates without full page blocking work", () => {
  assert.match(listingAutomationViewSource, /await applyTemplateFromRoute\(routeTemplate, \{ safeOpen: true \}\);/);
  assert.match(listingAutomationViewSource, /function fillTemplateEditor\(template, options = \{\}\)/);
  assert.match(listingAutomationViewSource, /const safeOpen = Boolean\(options\.safeOpen\);/);
  assert.match(listingAutomationViewSource, /if \(!safeOpen\) \{/);
  assert.doesNotMatch(listingAutomationViewSource, /class="copy-page" v-loading="loading"/);
  assert.match(listingAutomationViewSource, /class="route-loading-strip"/);
});

test("listing automation hydrates one shared Ozon schema for every routed source", () => {
  assert.match(listingAutomationViewSource, /async function hydrateLoadedCategorySchema\(\)/);
  assert.match(listingAutomationViewSource, /apiClient\.get\(`\/api\/listing\/ozon-category-attributes\?/);
  assert.match(listingAutomationViewSource, /await applyRecordDraftFromRoute\(\)/);
  assert.match(listingAutomationViewSource, /async function applyListingDraftFromRoute[\s\S]*await hydrateLoadedCategorySchema\(\)/);
  assert.match(listingAutomationViewSource, /async function applyPublishRecordFromRoute[\s\S]*await hydrateLoadedCategorySchema\(\)/);
  assert.match(listingAutomationViewSource, /name: item\?\.name_zh \|\| item\?\.nameZh \|\| item\?\.name \|\| ""/);
  assert.match(listingAutomationViewSource, /values: mergeAttributeOptions\(schema\.values \|\| \[\], existing\?\.values \|\| \[\]\)/);
});

test("listing automation publish payload keeps only selected dictionary values", () => {
  assert.match(listingAutomationViewSource, /function normalizeAttributeForPayload\(item = \{\}\)/);
  assert.match(listingAutomationViewSource, /const \{ selected_values, selectedValues, values, raw, \.\.\.payloadItem \} = item;/);
  assert.match(listingAutomationViewSource, /return \{ \.\.\.payloadItem, value, values: selectedPayloadValues \};/);
  assert.doesNotMatch(listingAutomationViewSource, /existingValues/);
  assert.doesNotMatch(listingAutomationViewSource, /mergedValues/);
});

test("listing automation never displays dictionary candidates as selected variant values", () => {
  assert.match(listingAutomationViewSource, /const selected = normalizeArray\(variantEntry\.selected_values \|\| variantEntry\.selectedValues\);/);
  assert.doesNotMatch(listingAutomationViewSource, /variantEntry\.selected_values \|\| variantEntry\.selectedValues \|\| variantEntry\.values/);
});

test("listing automation publish payload forces product tags to Ozon attribute 23171", () => {
  assert.match(listingAutomationViewSource, /Number\(payloadItem\.attribute_id \|\| payloadItem\.id \|\| 0\) === 23171 \|\| isTopicTagAttribute\(payloadItem\)/);
  assert.match(listingAutomationViewSource, /attribute_id: 23171/);
  assert.match(listingAutomationViewSource, /type: "multiselect"/);
  assert.match(listingAutomationViewSource, /setAttributeByIdsOrNames\(\[23171\]/);
});

test("listing automation coerces Ozon attribute values to strings before import", () => {
  assert.match(listingSource, /function sanitizeOzonPayloadAttributes\(attributes = \[\]\)/);
  assert.match(listingSource, /else clean = String\(raw \?\? ""\)\.trim\(\)/);
  assert.match(listingSource, /attributes: sanitizeOzonPayloadAttributes\(item\.attributes\)/);
  assert.match(listingSource, /function normalizeOzonComplexAttributesForPublish\(groups = \[\]\)/);
  assert.match(listingSource, /\? \{ \.\.\.value, value: String\(raw \?\? ""\)\.trim\(\) \}/);
});

test("listing automation keeps heavy overlays lazy without changing the main editor", () => {
  assert.match(listingAutomationViewSource, /<div class="copy-layout">/);
  assert.match(listingAutomationViewSource, /<el-drawer v-if="attributeDrawer\.visible" v-model="attributeDrawer\.visible"/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-drawer v-if="variantAttributeDrawer\.visible" v-model="variantAttributeDrawer\.visible"/);
  assert.match(listingAutomationViewSource, /<el-dialog v-if="variantImageEditor\.visible" v-model="variantImageEditor\.visible"/);
  assert.match(listingAutomationViewSource, /<el-drawer v-if="publishValidation\.visible" v-model="publishValidation\.visible"/);
  assert.doesNotMatch(listingAutomationViewSource, /safe-editor-shell/);
});

test("listing automation keeps selected SKU images draggable for sorting", () => {
  assert.match(listingAutomationViewSource, /draggingImageIndex:\s*-1/);
  assert.match(listingAutomationViewSource, /dragOverImageIndex:\s*-1/);
  assert.match(listingAutomationViewSource, /function reorderVariantImage\(fromIndex, toIndex\)/);
  assert.match(listingAutomationViewSource, /draggable="true"/);
  assert.match(listingAutomationViewSource, /@dragstart="startVariantImageDrag\(imageIndex\)"/);
  assert.match(listingAutomationViewSource, /@dragover\.prevent="variantImageEditor\.dragOverImageIndex = imageIndex"/);
  assert.match(listingAutomationViewSource, /@drop="reorderVariantImage\(variantImageEditor\.draggingImageIndex, imageIndex\)"/);
  assert.match(listingAutomationViewSource, /@dragend="finishVariantImageDrag"/);
  assert.match(listingAutomationViewSource, /selected-card\.drag-over/);
});

test("listing automation lets operators preview selected SKU images", () => {
  assert.match(listingAutomationViewSource, /function variantSelectedPreviewList\(\)/);
  assert.match(listingAutomationViewSource, /<el-image[\s\S]*class="variant-selected-image"[\s\S]*:preview-src-list="variantSelectedPreviewList\(\)"[\s\S]*preview-teleported/);
  assert.doesNotMatch(listingAutomationViewSource, /class="variant-selected-image" @click="toggleVariantImageSelection\(image\)"/);
});

test("ozon category selector does not fetch the category tree on mount", () => {
  assert.match(ozonCategorySelectSource, /function openSearchPanel\(\)/);
  assert.match(ozonCategorySelectSource, /loadBrowseLevel\("", 0\);/);
  assert.match(ozonCategorySelectSource, /mode: "browse"/);
  assert.match(ozonCategorySelectSource, /await loadBrowseLevel\(node\.path, columnIndex \+ 1\)/);
  assert.doesNotMatch(ozonCategorySelectSource, /BROWSE_CATEGORY_LIMIT/);
  assert.doesNotMatch(ozonCategorySelectSource, /@mouseenter="handleBrowseNode/);
  assert.doesNotMatch(ozonCategorySelectSource, /onMounted\(\(\) => \{[\s\S]*loadCategories\(props\.modelValue \|\| ""/);
});

test("ozon category browse API returns one complete hierarchy level without a row limit", () => {
  const browseBranch = listingSource.match(/if \(String\(query\.mode[\s\S]*?return \{ parent_path: parentPath, nodes: \[\.\.\.nodes\.values\(\)\] \};/)?.[0] || "";
  assert.match(browseBranch, /parent_path/);
  assert.match(browseBranch, /has_children/);
  assert.match(browseBranch, /ozon_category_mappings/);
  assert.doesNotMatch(browseBranch, /LIMIT/);
});

test("ozon category picker only exposes publishable category pairs", () => {
  assert.match(listingSource, /WHERE status = 'active' AND description_category_id > 0 AND type_id > 0/);
  assert.match(listingSource, /ozon_category_id: descriptionCategoryId && typeId/);
  assert.match(assetVariantEngineSource, /if \(!row\.descriptionCategoryId \|\| !row\.typeId\) continue;/);
});

test("switching category replaces stale attributes with the current Ozon schema", () => {
  assert.match(listingAutomationViewSource, /templateEditor\.attributes = merged;/);
  assert.match(listingAutomationViewSource, /pruneVariantDynamicAttributesToSchema\(merged\)/);
  assert.doesNotMatch(listingAutomationViewSource, /templateEditor\.attributes = \[\.\.\.merged, \.\.\.extras\]/);
});

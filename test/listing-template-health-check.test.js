import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const listingAutomationViewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const ozonCategorySelectSource = readFileSync(new URL("../frontend/admin/components/listing/OzonCategorySelect.vue", import.meta.url), "utf8");

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

test("listing automation view exposes a common template health panel", () => {
  assert.match(listingAutomationViewSource, /templateHealthFilters = reactive\(\{/);
  assert.match(listingAutomationViewSource, /onlineProducts: false/);
  assert.match(listingAutomationViewSource, /\/api\/listing\/template-health-check\?\$\{buildTemplateHealthQuery\(\)\.toString\(\)\}/);
  assert.match(listingAutomationViewSource, /公共上架模板体检/);
  assert.match(listingAutomationViewSource, /path: "\/listing-records\/edit"/);
  assert.match(listingAutomationViewSource, /path: "\/online-products"/);
});

test("listing automation view does not restore stale local drafts for routed sources", () => {
  assert.match(listingAutomationViewSource, /const hasBootstrap = hasListingBootstrapParams\(\);/);
  assert.match(listingAutomationViewSource, /localStorage\.removeItem\(listingWorkbenchDraftStorageKey\.value\);/);
  assert.match(listingAutomationViewSource, /const restored = hasBootstrap \? false : restoreListingWorkbenchSnapshot\(\);/);
});

test("listing automation view hides raw dict ids and avoids saving unknown dict placeholders", () => {
  assert.match(listingAutomationViewSource, /return dictId \? "待同步字典值" : translateAttributeValueForDisplay/);
  assert.match(listingAutomationViewSource, /return dictId \? "" : attributeOptionText\(item\);/);
  assert.match(listingAutomationViewSource, /if \(matchedById\) return displayAttributeOptionLabel\(matchedById, field\);/);
  assert.doesNotMatch(listingAutomationViewSource, /field\.raw\?\.value\?\.values/);
  assert.doesNotMatch(listingAutomationViewSource, /field\.raw\?\.attribute_values/);
  assert.doesNotMatch(listingAutomationViewSource, /`字典值\s+\$\{dictId\}`/);
});

test("listing automation view uses dictionary labels in variant attribute cells", () => {
  assert.match(listingAutomationViewSource, /function variantAttributeSelectModelValue/);
  assert.match(listingAutomationViewSource, /function updateVariantAttributeSelectValue/);
  assert.match(listingAutomationViewSource, /:model-value="variantAttributeSelectModelValue\(variantAttributeDrawer\.row, variantAttributeDrawer\.field\)"/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateVariantAttributeSelectValue\(variantAttributeDrawer\.row, variantAttributeDrawer\.field, \$event\)"/);
});

test("listing automation view renders multiselect labels without heavy tag slots", () => {
  assert.match(listingAutomationViewSource, /field\.type === "multiselect" \? displayAttributeOptionLabel\(option, field\) : attributeOptionModelValue\(option\)/);
  assert.doesNotMatch(listingAutomationViewSource, /<template #tag=/);
  assert.doesNotMatch(listingAutomationViewSource, /attributeSelectTagLabel\(field, data\)/);
});

test("listing automation keeps Ozon attribute rows lightweight and edits one field in drawer", () => {
  assert.match(listingAutomationViewSource, /function attributeDisplayText\(field = \{\}\)/);
  assert.match(listingAutomationViewSource, /class="field-with-tools attribute-summary-row"/);
  assert.match(listingAutomationViewSource, /class="attribute-summary-value"/);
  assert.match(listingAutomationViewSource, /function attributeEditorModelValue\(field = \{\}\)/);
  assert.match(listingAutomationViewSource, /attributeDrawer\.field\.type === 'multiselect'/);
});

test("listing automation pages optional attributes conservatively", () => {
  assert.match(listingAutomationViewSource, /const OPTIONAL_ATTRIBUTE_PAGE_SIZE = 12;/);
  assert.match(listingAutomationViewSource, /sort\(\(a, b\) => Number\(hasAttributeValue\(b\)\) - Number\(hasAttributeValue\(a\)\)\)/);
  assert.match(listingAutomationViewSource, /optionalAttributeVisibleLimit\.value = OPTIONAL_ATTRIBUTE_PAGE_SIZE;/);
  assert.match(listingAutomationViewSource, /optionalAttributeVisibleLimit \+= OPTIONAL_ATTRIBUTE_PAGE_SIZE/);
  assert.doesNotMatch(listingAutomationViewSource, /optionalAttributeVisibleLimit \+= 24/);
  assert.doesNotMatch(listingAutomationViewSource, /showMoreAttributes\.value \? 72 : 40/);
  assert.doesNotMatch(listingAutomationViewSource, /\(\) => JSON\.stringify\(materialSearch\)/);
});

test("listing automation edits variant dictionary attributes lazily", () => {
  assert.match(listingAutomationViewSource, /function variantAttributeDisplayText\(row = \{\}, field = \{\}\)/);
  assert.match(listingAutomationViewSource, /function openVariantAttributeEditor\(row = \{\}, field = \{\}\)/);
  assert.match(listingAutomationViewSource, /class="variant-attribute-summary"/);
  assert.match(listingAutomationViewSource, /v-model="variantAttributeDrawer\.visible"/);
  assert.doesNotMatch(listingAutomationViewSource, /<el-option v-for="option in variantAttributeOptions\(row, field\)"/);
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

test("listing automation publish payload keeps only selected dictionary values", () => {
  assert.match(listingAutomationViewSource, /function normalizeAttributeForPayload\(item = \{\}\)/);
  assert.match(listingAutomationViewSource, /const \{ selected_values, selectedValues, values, raw, \.\.\.payloadItem \} = item;/);
  assert.match(listingAutomationViewSource, /return \{ \.\.\.payloadItem, value, values: selectedPayloadValues \};/);
  assert.doesNotMatch(listingAutomationViewSource, /existingValues/);
  assert.doesNotMatch(listingAutomationViewSource, /mergedValues/);
});

test("listing automation keeps heavy overlays lazy without changing the main editor", () => {
  assert.match(listingAutomationViewSource, /<div class="copy-layout">/);
  assert.match(listingAutomationViewSource, /<el-drawer v-if="attributeDrawer\.visible" v-model="attributeDrawer\.visible"/);
  assert.match(listingAutomationViewSource, /<el-drawer v-if="variantAttributeDrawer\.visible" v-model="variantAttributeDrawer\.visible"/);
  assert.match(listingAutomationViewSource, /<el-dialog v-if="variantImageEditor\.visible" v-model="variantImageEditor\.visible"/);
  assert.match(listingAutomationViewSource, /<el-drawer v-if="publishValidation\.visible" v-model="publishValidation\.visible"/);
  assert.doesNotMatch(listingAutomationViewSource, /safe-editor-shell/);
});

test("ozon category selector does not fetch the category tree on mount", () => {
  assert.match(ozonCategorySelectSource, /function openSearchPanel\(\)/);
  assert.match(ozonCategorySelectSource, /loadCategories\("", \{ limit: BROWSE_CATEGORY_LIMIT \}\);/);
  assert.doesNotMatch(ozonCategorySelectSource, /onMounted\(\(\) => \{[\s\S]*loadCategories\(props\.modelValue \|\| ""/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listingAutomationViewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const listingAutomationServiceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const systemRulesSource = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

test("listing category sync keeps its batch helper available", () => {
  assert.match(listingAutomationServiceSource, /function chunkArray\(items = \[\], size = 1\)/);
  assert.match(listingAutomationServiceSource, /for \(const chunk of chunkArray\(validRows, 300\)\)/);
});

test("listing automation selected SKU images keep drag sorting", () => {
  assert.match(listingAutomationViewSource, /draggingImageIndex:\s*-1/);
  assert.match(listingAutomationViewSource, /dragOverImageIndex:\s*-1/);
  assert.match(listingAutomationViewSource, /function reorderVariantImage\(fromIndex, toIndex\)/);
  assert.match(listingAutomationViewSource, /draggable="true"/);
  assert.match(listingAutomationViewSource, /@dragstart="startVariantImageDrag\(imageIndex\)"/);
  assert.match(listingAutomationViewSource, /@dragover\.prevent="variantImageEditor\.dragOverImageIndex = imageIndex"/);
  assert.match(listingAutomationViewSource, /@drop="reorderVariantImage\(variantImageEditor\.draggingImageIndex, imageIndex\)"/);
  assert.match(listingAutomationViewSource, /@dragend="finishVariantImageDrag"/);
  assert.match(listingAutomationViewSource, /item\.sort_order = index \+ 1/);
  assert.match(listingAutomationViewSource, /selected-card\.drag-over/);
});

test("listing automation media repair keeps SKU image editing workflow intact", () => {
  assert.match(listingAutomationViewSource, /function repairAllListingMedia\(\)/);
  assert.match(listingAutomationViewSource, /function repairCurrentVariantMedia\(\)/);
  assert.match(listingAutomationViewSource, /apiClient\.post\("\/api\/listing\/media\/repair"/);
  assert.match(listingAutomationViewSource, /@click="repairAllListingMedia">修复素材地址/);
  assert.match(listingAutomationViewSource, /@click="repairCurrentVariantMedia">修复地址/);
  assert.match(listingAutomationViewSource, /uploadVariantImagesRequest\(variantImageEditor\.row\)/);
  assert.match(listingAutomationViewSource, /@click="useTemplateImagesForVariant"/);
  assert.match(listingAutomationViewSource, /@click="addVariantImageLink"/);
  assert.match(listingAutomationViewSource, /draggable="true"/);
  assert.match(listingAutomationViewSource, /@drop="reorderVariantImage\(variantImageEditor\.draggingImageIndex, imageIndex\)"/);
});

test("listing automation SKU image library keeps tab sources separated", () => {
  assert.match(listingAutomationViewSource, /function variantImageLibrarySources\(tab = "sku"\)/);
  assert.match(listingAutomationViewSource, /if \(tab === "sku"\) return currentImages\.filter\(\(image, index\) => isSkuImageCandidate/);
  assert.match(listingAutomationViewSource, /if \(tab === "detail"\) return templateDetailImageCandidates\(\)/);
  assert.match(listingAutomationViewSource, /if \(tab === "ai"\) return aiGeneratedImageCandidates\(\)/);
  assert.match(listingAutomationViewSource, /function isDetailImageCandidate/);
  assert.match(listingAutomationViewSource, /generatedDetailImages/);
});

test("listing automation SKU image editor saves only the visible selected image list", () => {
  const openEditorStart = listingAutomationViewSource.indexOf("function openVariantImageEditor(row)");
  const confirmEditorStart = listingAutomationViewSource.indexOf("function confirmVariantImageEditor()");
  const syncDraftStart = listingAutomationViewSource.indexOf("function syncDraftImagesFromVariantImages()");
  assert.ok(openEditorStart > 0);
  assert.ok(confirmEditorStart > openEditorStart);
  assert.ok(syncDraftStart > confirmEditorStart);
  const imageEditorSource = listingAutomationViewSource.slice(openEditorStart, syncDraftStart);
  assert.match(imageEditorSource, /function isVariantImageSelected\(image\)[\s\S]*ensureVariantOwnImages\(variantImageEditor\.row\)\.some/);
  assert.match(imageEditorSource, /function toggleVariantImageSelection\(image\)[\s\S]*images\.push\(\{/);
  assert.match(imageEditorSource, /variantImageEditor\.row\.images = dedupeImages\(ensureVariantOwnImages\(variantImageEditor\.row\)\)/);
  assert.doesNotMatch(imageEditorSource, /ownUrls/);
  assert.doesNotMatch(imageEditorSource, /finalUrls/);
  assert.doesNotMatch(imageEditorSource, /\[\.\.\.ownUrls,\s*\.\.\.variantImageEditor\.selectedUrls\]/);
  assert.match(listingAutomationViewSource, /@click="addCurrentLibraryImagesToVariant"/);
  assert.match(listingAutomationViewSource, /@click="clearVariantImages"/);
});

test("listing automation SKU image editor keeps large image libraries scrollable", () => {
  assert.match(listingAutomationViewSource, /variant-image-dialog[\s\S]*el-dialog__footer[\s\S]*flex: 0 0 auto/);
  assert.match(listingAutomationViewSource, /variant-image-workbench[\s\S]*height: min\(640px, max\(360px, calc\(100vh - 190px\)\)\)/);
  assert.match(listingAutomationViewSource, /variant-image-panel[\s\S]*overflow-y: auto/);
  assert.match(listingAutomationViewSource, /variant-image-library[\s\S]*overflow-y: auto/);
  assert.match(listingAutomationViewSource, /library-tabs[\s\S]*position: sticky/);
  assert.match(listingAutomationViewSource, /library-grid[\s\S]*repeat\(auto-fill, minmax\(118px, 1fr\)\)/);
});

test("listing draft save does not overwrite manually selected SKU images from template", () => {
  assert.match(listingAutomationViewSource, /const draftImagesManuallyEdited = ref\(false\)/);
  assert.match(listingAutomationViewSource, /function syncDraftImagesFromTemplateIfEmpty\(\)/);
  assert.match(listingAutomationViewSource, /if \(draftImagesManuallyEdited\.value\) return/);
  assert.match(listingAutomationViewSource, /if \(draftForm\.source_images\.length\) return/);
  const createDraftStart = listingAutomationViewSource.indexOf("async function createDraft()");
  const saveCurrentStart = listingAutomationViewSource.indexOf("async function saveCurrentToDraft()");
  const generateCopiesStart = listingAutomationViewSource.indexOf("async function generateCopies()");
  assert.ok(createDraftStart > 0);
  assert.ok(saveCurrentStart > createDraftStart);
  assert.ok(generateCopiesStart > saveCurrentStart);
  const createDraftSource = listingAutomationViewSource.slice(createDraftStart, saveCurrentStart);
  const saveCurrentSource = listingAutomationViewSource.slice(saveCurrentStart, generateCopiesStart);
  assert.match(createDraftSource, /await saveCurrentTemplateSnapshot\(\)/);
  assert.match(createDraftSource, /syncDraftImagesFromTemplateIfEmpty\(\)/);
  assert.doesNotMatch(createDraftSource, /applyTemplateToDraft\(\)/);
  assert.match(saveCurrentSource, /syncDraftImagesFromTemplateIfEmpty\(\)/);
  assert.doesNotMatch(saveCurrentSource, /applyTemplateToDraft\(\)/);
});

test("listing draft edit updates existing draft and syncs SKU image selections", () => {
  assert.match(listingAutomationViewSource, /function syncDraftImagesFromVariantImages\(\)/);
  assert.match(listingAutomationViewSource, /syncDraftImagesFromVariantImages\(\);\s*\n\s*variantImageEditor\.visible = false/);
  assert.match(listingAutomationViewSource, /draftForm\.source_images = sourceImages/);
  assert.match(listingAutomationViewSource, /draftImagesManuallyEdited\.value = true/);
  assert.match(listingAutomationViewSource, /function markVariantImagesEdited\(row\)/);
  assert.match(listingAutomationViewSource, /row\.images_manually_edited = true/);
  assert.match(listingAutomationViewSource, /const hasEditedVariantImages = templateEditor\.variants\.some/);
  assert.match(listingAutomationViewSource, /function syncEditorImagesFromSavedDraft\(draft = \{\}\)/);
  assert.match(listingAutomationViewSource, /const templatePayload = draft\.template_payload \|\| draft\.templatePayload \|\| \{\}/);
  assert.match(listingAutomationViewSource, /templatePayload\.images/);
  assert.match(listingAutomationViewSource, /editablePayload\.images/);
  assert.match(listingAutomationViewSource, /syncEditorImagesFromSavedDraft\(created\)/);
  assert.match(listingAutomationViewSource, /function syncVariantImageLink\(image\)[\s\S]*syncDraftImagesFromVariantImages\(\);/);
  assert.match(listingAutomationViewSource, /function removeVariantImage\(index\)[\s\S]*syncDraftImagesFromVariantImages\(\);/);
  assert.match(listingAutomationViewSource, /function syncDraftImagesFromTemplateForExistingDraft\(\)/);
  assert.match(listingAutomationViewSource, /if \(!Number\(draftForm\.id \|\| state\.selectedDraftId \|\| route\.query\.draftId \|\| 0\)\) return/);
  assert.match(listingAutomationViewSource, /syncDraftImagesFromTemplateIfEmpty\(\);\s*\n\s*syncDraftImagesFromTemplateForExistingDraft\(\);/);
  assert.match(listingAutomationViewSource, /const currentDraftId = Number\(draftForm\.id \|\| state\.selectedDraftId \|\| route\.query\.draftId \|\| 0\)/);
  assert.match(listingAutomationViewSource, /apiClient\.put\(`\/api\/listing\/drafts\/\$\{currentDraftId\}`,\s*draftPayload\)/);
  assert.match(listingAutomationViewSource, /apiClient\.post\("\/api\/listing\/drafts",\s*draftPayload\)/);
});

test("listing automation treats Ozon attribute 4191 as the fixed description field", () => {
  assert.match(listingAutomationViewSource, /id === "4191" \|\| \/\^简介\$\|description\|аннотац\|описан\/\.test\(name\)/);
  assert.match(listingAutomationViewSource, /getAttributeByIdsOrNames\(\[4191\], \["简介", "Description", "Аннотация", "Описание"\]/);
  assert.match(listingAutomationViewSource, /setAttributeByIdsOrNames\(\[4191\], \["简介", "Description", "Аннотация", "Описание"\]/);
  assert.match(listingAutomationViewSource, /summary: \{\s*ids: \[4191\]/);
  assert.match(listingAutomationViewSource, /defaults: \{ name: "简介", attribute_id: 4191, type: "textarea", source: "fixed_form" \}/);
});

test("listing automation P0 guards keep publish and routed draft behavior safe", () => {
  assert.match(listingAutomationViewSource, /const hasBootstrap = hasListingBootstrapParams\(\);/);
  assert.match(listingAutomationViewSource, /localStorage\.removeItem\(listingWorkbenchDraftStorageKey\.value\);/);
  assert.match(listingAutomationViewSource, /function normalizeAttributeForPayload\(item = \{\}\)/);
  assert.match(listingAutomationViewSource, /const \{ selected_values, selectedValues, values, raw, \.\.\.payloadItem \} = item;/);
  assert.match(listingAutomationViewSource, /\.map\(\(item\) => normalizeAttributeForPayload\(item\)\)/);
  assert.match(listingAutomationViewSource, /dynamic_attributes: Object\.fromEntries/);
  assert.match(listingAutomationViewSource, /function displayAttributeOptionLabel\(option = \{\}, field = \{\}\)/);
  assert.match(listingAutomationViewSource, /return dictId \? "待同步字典值" : localizeAttributeDisplayText\(attributeOptionText\(option\), field\);/);
});

test("listing automation P1 guards keep heavy attribute editing lazy", () => {
  assert.match(listingAutomationViewSource, /const OPTIONAL_ATTRIBUTE_PAGE_SIZE = 12;/);
  assert.match(listingAutomationViewSource, /optionalAttributeVisibleLimit \+= OPTIONAL_ATTRIBUTE_PAGE_SIZE/);
  assert.match(listingAutomationViewSource, /function variantAttributeDisplayText\(row = \{\}, field = \{\}\)/);
  assert.match(listingAutomationViewSource, /class="flat-attribute-control"/);
  assert.doesNotMatch(listingAutomationViewSource, /class="variant-attribute-summary"/);
  assert.doesNotMatch(listingAutomationViewSource, /v-if="variantAttributeDrawer\.visible" v-model="variantAttributeDrawer\.visible"/);
  assert.match(listingAutomationViewSource, /v-if="attributeDrawer\.visible" v-model="attributeDrawer\.visible"/);
  assert.match(listingAutomationViewSource, /v-if="publishValidation\.visible" v-model="publishValidation\.visible"/);
  assert.match(listingAutomationViewSource, /@update:model-value="updateVariantAttributeSelectValue\(row, field, \$event\)"/);
});

test("listing automation protected workflow is documented in AGENTS", () => {
  assert.match(systemRulesSource, /Listing Automation Protected Workflow/);
  assert.match(systemRulesSource, /SKU image editing must keep image upload, manual URL entry, template-image reuse, image preview, selected-image deletion, and drag-and-drop sorting/);
  assert.match(systemRulesSource, /Drag-and-drop sorting in the selected SKU image area is a protected behavior/);
  assert.match(systemRulesSource, /Publish payloads must include only selected dictionary values/);
  assert.match(systemRulesSource, /Routed entry points from drafts, publish records, online products, or collector data must not restore stale local listing drafts/);
  assert.match(systemRulesSource, /Keep Ozon optional attributes paged in small batches/);
});

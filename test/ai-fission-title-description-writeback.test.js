import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

function functions(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
    .map(node => node.declaration || node).filter(node => node.type === "FunctionDeclaration")
    .map(node => source.slice(node.start, node.end)).join("\n");
}
const backendFunctions = functions(readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8"));
const view = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const editorFunctions = functions(view.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1]);
const clone = value => JSON.parse(JSON.stringify(value));
const sourceTitle = "Накладки HAVAL H3", targetTitle = "Накладки HAVAL F7";
const sourceDescription = "Описание HAVAL H3", targetDescription = "Описание HAVAL F7";
const entry = (id, value) => ({ attribute_id: id, name: id === 4180 ? "Название" : "Description", value,
  values: [{ value }], selected_values: [{ value }], selectedValues: [{ value }], label: value,
  display_value_zh: value, displayValueZh: value, type: "text" });
function fixture() {
  const context = vm.createContext({ LOCAL_DICTIONARY_DISPLAY_ZH: new Map(), PRICE_STRATEGY_FINALIZED: "finalized", PRICE_STRATEGY_MULTIPLY_ON_PUBLISH: "multiply_on_publish" });
  vm.runInContext(backendFunctions, context);
  const original = { title: sourceTitle, name: sourceTitle, images: [], description: sourceDescription,
    attributes: [entry(4180, sourceTitle), entry(4191, sourceDescription)],
    dynamic_attributes: { "4180": entry(4180, sourceTitle) },
    variants: [{ sku: "VAR-F7", name: sourceTitle, title: sourceTitle, images: [],
      attributes: [entry(4180, sourceTitle), entry(4191, sourceDescription)],
      dynamic_attributes: { "4180": entry(4180, sourceTitle), "4191": entry(4191, sourceDescription) },
      dynamicAttributes: { legacy_name: entry(4180, sourceTitle), legacy_description: entry(4191, sourceDescription) }
    }, { sku: "SIBLING", name: sourceTitle, title: sourceTitle, dynamic_attributes: { "4180": entry(4180, sourceTitle) } }] };
  return { context, original };
}
const plainAttribute = (owner, id) => owner.attributes.find(item => Number(item.attribute_id || item.id) === id);
function assertDynamicCopy(map, id, expected) {
  const entries = Object.values(map).filter(item => Number(item.attribute_id || item.id) === id);
  assert.ok(entries.length);
  for (const item of entries) {
    assert.equal(item.value, expected);
    for (const key of ["values", "selected_values", "selectedValues"]) {
      for (const option of item[key] || []) assert.equal(option.value, expected, key);
    }
    for (const key of ["label", "display_value_zh", "displayValueZh"]) assert.equal(item[key], expected, key);
  }
}

test("AI fission synchronizes existing title 4180 copies and every description alias", () => {
  const { context, original } = fixture(), before = JSON.stringify(original);
  const result = context.applyAiVariantDraftPatch(original, { title: targetTitle, description: targetDescription });
  for (const owner of [result, result.variants[0]]) {
    assert.equal(owner.title, targetTitle);
    assert.equal(owner.name, targetTitle);
    assert.equal(plainAttribute(owner, 4180).value, targetTitle);
    assert.equal(plainAttribute(owner, 4191).value, targetDescription);
    assertDynamicCopy(owner.dynamic_attributes, 4180, targetTitle);
    assertDynamicCopy(owner.dynamicAttributes, 4180, targetTitle);
  }
  assertDynamicCopy(result.variants[0].dynamic_attributes, 4191, targetDescription);
  assertDynamicCopy(result.variants[0].dynamicAttributes, 4191, targetDescription);
  assert.deepEqual(clone(result.variants[1]), original.variants[1]);
  assert.equal(JSON.stringify(original), before);
});

test("no title patch preserves title attributes and templates without 4180 never gain that field", () => {
  const { context, original } = fixture();
  const result = context.applyAiVariantDraftPatch(original, { description: targetDescription });
  assert.equal(plainAttribute(result, 4180).value, sourceTitle);
  assert.equal(plainAttribute(result.variants[0], 4180).value, sourceTitle);
  assert.deepEqual(clone(result.variants[0].dynamic_attributes[4180]), original.variants[0].dynamic_attributes[4180]);
  const withoutTitleField = { title: sourceTitle, attributes: [], variants: [{ sku: "NEW", title: sourceTitle, attributes: [], dynamic_attributes: {} }] };
  const changed = context.applyAiVariantDraftPatch(withoutTitleField, { title: targetTitle });
  for (const owner of [changed, changed.variants[0]]) {
    assert.ok(!owner.attributes.some(item => Number(item.attribute_id || item.id) === 4180));
    assert.ok(!Object.values(owner.dynamic_attributes || {}).some(item => Number(item.attribute_id || item.id) === 4180));
  }
});

function editor(patched, draftIds = []) {
  const templateEditor = { title: patched.title, description: patched.description, attributes: patched.attributes, images: [], rawJson: "{}" };
  const front = vm.createContext({ templateEditor, fixedForm: { value: { summary: patched.description, richJson: "{}", tags: [] } },
    draftForm: { shop_ids: [] }, routeDraftIds: { value: draftIds }, collectorSourceSku: { value: "" }, sourceRawOmitted: { value: true },
    variantFieldMode: { tags: true, weight: true, dimensions: true } });
  vm.runInContext(editorFunctions, front);
  Object.assign(front, { findVariantDictionaryAttribute: () => null, normalizeVariantVideoFields: () => ({}),
    extractVariantDynamicAttribute: () => "", isParentModelSpecValue: () => false, normalizeColorValuesForField: () => [],
    sanitizeVariantColorFields: () => {}, seedVariantModelValue: () => {}, applyOzonAttributeMappings: () => {}, normalizeColorForPayload: () => "" });
  return front;
}

test("title attributes survive real editor normalization, save and publish preview with the target name", () => {
  const { context, original } = fixture();
  const patched = clone(context.applyAiVariantDraftPatch(original, { title: targetTitle, description: targetDescription }));
  const front = editor(patched);
  front.templateEditor.variants = front.normalizeEditorVariants(patched.variants);
  const template = clone(front.buildTemplatePayload());
  const preview = context.buildOzonImportPreviewPayload({ title: template.title, description: template.description,
    attributes: template.attributes, tags: [], images: [], variants: template.editable_payload.variants, price: {}, dimensions: {} });
  assert.equal(preview.items[0].name, targetTitle);
  assert.deepEqual(clone(preview.items[0].attributes.find(item => Number(item.id) === 4180).values), [{ value: targetTitle }]);
  const reviewedTitle = "Накладки HAVAL F7 после проверки";
  front.templateEditor.variants[0].name = reviewedTitle;
  const saved = clone(front.buildTemplatePayload());
  const reviewed = context.buildOzonImportPreviewPayload({ title: saved.title, description: saved.description,
    attributes: saved.attributes, tags: [], images: [], variants: saved.editable_payload.variants, price: {}, dimensions: {} });
  assert.equal(reviewed.items[0].name, reviewedTitle);
  assert.deepEqual(clone(reviewed.items[0].attributes.find(item => Number(item.id) === 4180).values), [{ value: reviewedTitle }]);
});

test("batch drafts with an ordinary-only 4180 keep each target title through editing and publishing", () => {
  const { context, original } = fixture();
  delete original.dynamic_attributes;
  delete original.variants[0].dynamic_attributes;
  delete original.variants[0].dynamicAttributes;
  original.variants = [original.variants[0]];
  const titles = ["Накладки HAVAL F7", "Накладки HAVAL H9"];
  const copies = titles.map(title => clone(context.applyAiVariantDraftPatch(original, { title, description: title })));
  const front = editor(copies[0], [701, 702]);
  front.templateEditor.variants = copies.map((copy, index) => front.batchDraftVariant({ id: 701 + index, template_id: 501,
    product_name: titles[index], internal_code: `VAR-${index}`, template_payload: { title: titles[index], attributes: copy.attributes, editable_payload: copy } }));
  const items = clone(front.buildBatchDraftUpdateItems());
  items.forEach((item, index) => {
    const template = item.template_payload;
    assert.equal(plainAttribute(template, 4180).value, titles[index]);
    const preview = context.buildOzonImportPreviewPayload({ title: template.title, description: template.description,
      attributes: template.attributes, tags: [], images: [], variants: template.editable_payload.variants, price: {}, dimensions: {} });
    assert.equal(preview.items[0].name, titles[index]);
    assert.deepEqual(clone(preview.items[0].attributes.find(attribute => Number(attribute.id) === 4180).values), [{ value: titles[index] }]);
  });
});

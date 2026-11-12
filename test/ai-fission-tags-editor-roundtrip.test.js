import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

const backendSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
function functions(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
    .map(node => node.declaration || node).filter(node => node.type === "FunctionDeclaration")
    .map(node => source.slice(node.start, node.end)).join("\n");
}
const backendFunctions = functions(backendSource);
const editorFunctions = functions(viewSource.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1]);
const clone = value => JSON.parse(JSON.stringify(value));
const main = "https://media.example/source.jpg", targetMain = "https://media.example/target.jpg";
const tagAttribute = tags => ({ attribute_id: 23171, name: "产品标签", type: "multiselect", value: tags, values: tags.map(value => ({ value })) });

function backend() {
  const ctx = vm.createContext({ LOCAL_DICTIONARY_DISPLAY_ZH: new Map(), PRICE_STRATEGY_FINALIZED: "finalized", PRICE_STRATEGY_MULTIPLY_ON_PUBLISH: "multiply_on_publish" });
  vm.runInContext(backendFunctions, ctx);
  return ctx;
}
function source() {
  const tags = ["#HAVAL_H3", "#защита_порогов"];
  return { title: "Накладки на пороги HAVAL H3", description: "Защитные накладки для HAVAL H3.", images: [main], attributes: [tagAttribute(tags)], variants: [{
    id: "first", sku: "SOURCE-H3", name: "Накладки на пороги HAVAL H3", images: [main],
    main_tags: tags, dynamic_attributes: { "23171": tagAttribute(tags) }
  }, { id: "sibling", sku: "KEEP-SIBLING", name: "Другой вариант", main_tags: ["#соседний_SKU"], images: [main], dynamic_attributes: {} }] };
}
function editor(editable, draftIds = []) {
  const templateEditor = { title: editable.title, description: editable.description, attributes: clone(editable.attributes), images: clone(editable.images), rawJson: "{}" };
  const ctx = vm.createContext({ templateEditor, draftForm: { shop_ids: [] }, collectorSourceSku: { value: "" },
    routeDraftIds: { value: draftIds }, variantFieldMode: { tags: true, weight: true, dimensions: true }, sourceRawOmitted: { value: true },
    fixedForm: { value: { tags: clone(editable.hashtags), summary: editable.description, richJson: "{}" } } });
  vm.runInContext(editorFunctions, ctx);
  // The actual SKU/tag projection and save builders run unchanged. Only the
  // unrelated category/color/video lookups are supplied without a mounted UI.
  Object.assign(ctx, { findVariantDictionaryAttribute: () => null, normalizeVariantVideoFields: () => ({}),
    extractVariantDynamicAttribute: () => "", isParentModelSpecValue: () => false, normalizeColorValuesForField: () => [],
    sanitizeVariantColorFields: () => {}, seedVariantModelValue: () => {}, applyOzonAttributeMappings: () => {}, normalizeColorForPayload: () => "" });
  return ctx;
}
function patch(ctx, target) {
  const original = source(), before = JSON.stringify(original);
  const tags = [`#${target.replace(/\s+/g, "_")}`, "#защита_порогов"];
  const title = `Накладки на пороги ${target}`, description = `Защитные накладки для ${target} помогают сохранить дверные проемы и поверхность автомобиля от повседневного износа.`;
  const result = ctx.applyAiVariantDraftPatch(original, { offer_id: `VAR-${target}`, title, description, tags, images: [targetMain] });
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(clone(result.variants[1]), original.variants[1], "patch must preserve sibling SKU content");
  return { result: clone(result), tags, title, description };
}
function preview(ctx, template) {
  const editable = template.editable_payload;
  return ctx.buildOzonImportPreviewPayload({ title: template.title, description: template.description,
    tags: ctx.splitTagValue(ctx.attributeValueByNames(template.attributes, [], [23171])),
    attributes: template.attributes, images: template.images, variants: editable.variants,
    price: editable.price || {}, dimensions: editable.dimensions || {} }, template);
}
const publishedTags = item => item.attributes.filter(attribute => Number(attribute.id) === 23171)
  .flatMap(attribute => attribute.values.flatMap(option => String(option.value).split(/[\s,]+/))).filter(Boolean);

test("AI target tags survive the real single-draft editor projection, save and publish preview", () => {
  const ctx = backend(), { result, tags, title, description } = patch(ctx, "HAVAL F7");
  const front = editor(result);
  front.templateEditor.variants = front.normalizeEditorVariants(result.variants);
  const template = clone(front.buildTemplatePayload());
  assert.deepEqual(template.editable_payload.variants[0].main_tags, tags);
  const payload = clone(preview(ctx, template)), first = payload.items[0];
  assert.equal(first.name, title);
  assert.equal(first.description, description);
  assert.equal(first.primary_image, targetMain);
  assert.deepEqual(first.tags, tags);
  assert.deepEqual(publishedTags(first), tags);
  assert.deepEqual(template.editable_payload.variants[1].main_tags, result.variants[1].main_tags);
});

test("batch draft rows retain each target's own tags through loading, per-draft save and preview", () => {
  const ctx = backend(), targets = ["HAVAL F7", "HAVAL H9"];
  const children = targets.map((target, index) => ({ ...patch(ctx, target), id: 600 + index }));
  const front = editor(children[0].result, children.map(child => child.id));
  front.templateEditor.variants = children.map(child => front.batchDraftVariant({ id: child.id, template_id: 100 + child.id,
    internal_code: `VAR-${child.id}`, template_payload: { title: child.title, attributes: child.result.attributes,
      editable_payload: { ...child.result, variants: [child.result.variants[0]] } } }));
  const items = clone(front.buildBatchDraftUpdateItems());
  assert.deepEqual(items.map(item => item.id), children.map(child => child.id));
  items.forEach((item, index) => {
    assert.equal(item.template_payload.editable_payload.variants.length, 1);
    assert.deepEqual(item.template_payload.editable_payload.variants[0].main_tags, children[index].tags);
    const first = clone(preview(ctx, item.template_payload)).items[0];
    assert.equal(first.name, children[index].title);
    assert.equal(first.primary_image, targetMain);
    assert.deepEqual(first.tags, children[index].tags);
    assert.deepEqual(publishedTags(first), children[index].tags);
  });
});

test("duplicate required tag attributes cannot restore mother tags during editor field deduplication", () => {
  const ctx = backend(), original = source();
  original.attributes.push({ ...tagAttribute(["#HAVAL_H3", "#защита_порогов"]), required: true });
  const tags = ["#HAVAL_F7", "#защита_порогов"];
  const result = clone(ctx.applyAiVariantDraftPatch(original, { title: "Накладки HAVAL F7",
    description: "Защитные накладки для HAVAL F7.", tags, images: [targetMain] }));
  const front = editor(result);
  front.templateEditor.attributes = front.dedupeAttributeFields(front.normalizeEditorAttributes(result.attributes));
  const field = front.templateEditor.attributes.find(attribute => Number(attribute.attribute_id) === 23171);
  assert.deepEqual(clone(ctx.normalizeCleanOzonTagList(field.value)), tags);
  assert.deepEqual(clone(field.selected_values).map(option => option.value), tags);
  front.templateEditor.variants = front.normalizeEditorVariants(result.variants);
  const template = clone(front.buildTemplatePayload());
  const saved = template.attributes.find(attribute => Number(attribute.attribute_id) === 23171);
  assert.deepEqual(saved.values.map(option => option.value), tags);
  const first = clone(preview(ctx, template)).items[0];
  assert.deepEqual(first.tags, tags);
  assert.deepEqual(publishedTags(first), tags);
});

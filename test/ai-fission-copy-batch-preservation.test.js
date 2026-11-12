import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";

function declarations(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" }).body
    .map(node => node.declaration || node).filter(node => node.type === "FunctionDeclaration")
    .map(node => source.slice(node.start, node.end)).join("\n");
}
const source = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const editorFunctions = declarations(source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1]);
const backendFunctions = declarations(readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8"));
const clone = value => JSON.parse(JSON.stringify(value));
const entry = (id, value) => ({ attribute_id: id, name: id === 4191 ? "Description" : "rich_content_json",
  value, values: [{ value }], selected_values: [], type: id === 4191 ? "textarea" : "rich_json" });
const rich = (model, description, image) => JSON.stringify({ content: [{ widgetName: "custom-layout", blocks: [
  { img: { src: image, srcMobile: image, alt: model }, text: { items: [{ type: "text", content: description }] } }
] }], version: 0.3, custom_metadata: model });
function draft(model, id) {
  const title = `Накладки на пороги ${model}`, description = `Защитные накладки для ${model}.`;
  const image = `https://media.example/${id}.jpg`, richJson = rich(model, description, image);
  const attributes = [entry(4191, description), entry(11254, richJson)];
  return { id, template_id: 100 + id, product_name: title, internal_code: `VAR-${id}`, effective_images: [image],
    template_payload: { title, description, attributes: clone(attributes), images: [image],
      editable_payload: { title, description, rich_content_json: richJson, attributes: clone(attributes), images: [image], variants: [{
        id: `sku-${id}`, sku: `VAR-${id}`, offer_id: `VAR-${id}`, title, name: title, description,
        rich_content_json: richJson, images: [image], dynamic_attributes: { "4191": entry(4191, description), "11254": entry(11254, richJson) }
      }] } } };
}
function editor(drafts) {
  const first = drafts[0].template_payload;
  const templateEditor = { title: first.title, description: first.description, attributes: clone(first.attributes),
    images: first.images.map(url => ({ url })), variants: [], rawJson: "{}" };
  let fixed = { summary: first.description, richJson: first.editable_payload.rich_content_json, tags: [] };
  const fixedForm = {};
  Object.defineProperty(fixedForm, "value", { get: () => fixed, set: value => {
    fixed = value;
    for (const [id, key] of [[4191, "summary"], [11254, "richJson"]]) templateEditor.attributes.find(attr => attr.attribute_id === id).value = value[key];
  } });
  const ctx = vm.createContext({ templateEditor, fixedForm, draftForm: { shop_ids: [] },
    routeDraftIds: { value: drafts.map(item => item.id) }, collectorSourceSku: { value: "" }, sourceRawOmitted: { value: true },
    variantFieldMode: { tags: true, weight: true, dimensions: true }, flatSkuAttributeOptionsCache: new Map(), ElMessage: { success() {} } });
  vm.runInContext(editorFunctions, ctx);
  Object.assign(ctx, { findVariantDictionaryAttribute: () => null, normalizeVariantVideoFields: () => ({}),
    extractVariantDynamicAttribute: () => "", isParentModelSpecValue: () => false, normalizeColorValuesForField: () => [],
    sanitizeVariantColorFields: () => {}, seedVariantModelValue: () => {}, applyOzonAttributeMappings: () => {},
    normalizeColorForPayload: () => "", isColorAttributeField: () => false });
  return ctx;
}
function published(template) {
  const ctx = vm.createContext({ LOCAL_DICTIONARY_DISPLAY_ZH: new Map(), PRICE_STRATEGY_FINALIZED: "finalized", PRICE_STRATEGY_MULTIPLY_ON_PUBLISH: "multiply_on_publish" });
  vm.runInContext(backendFunctions, ctx);
  return clone(ctx.buildOzonImportPreviewPayload({ title: template.title, description: template.description, tags: [],
    attributes: template.attributes, variants: template.editable_payload.variants, images: template.images,
    dimensions: {}, price: {} })).items[0];
}
function assertCopy(template, expectedDescription, expectedRich, expectedImage) {
  const editable = template.editable_payload, variant = editable.variants[0];
  assert.equal(template.description, expectedDescription);
  assert.equal(editable.description, expectedDescription);
  assert.equal(variant.description, expectedDescription);
  assert.equal(editable.rich_content_json, expectedRich);
  assert.equal(variant.rich_content_json, expectedRich);
  for (const attributes of [template.attributes, editable.attributes]) {
    assert.equal(attributes.find(attr => +attr.attribute_id === 4191).value, expectedDescription);
    assert.equal(attributes.find(attr => +attr.attribute_id === 11254).value, expectedRich);
  }
  assert.equal(variant.images[0].url, expectedImage);
  const item = published(template);
  assert.equal(item.description, expectedDescription);
  assert.equal(item.primary_image, expectedImage);
  assert.deepEqual(JSON.parse(item.attributes.find(attr => +attr.id === 11254).values[0].value), JSON.parse(expectedRich));
}

test("batch draft save preserves each draft's description, custom rich content and generated main image", () => {
  const drafts = [draft("HAVAL F7", 101), draft("HAVAL H9", 102)], before = JSON.stringify(drafts);
  const ctx = editor(drafts);
  ctx.templateEditor.variants = drafts.map(item => ctx.batchDraftVariant(item));
  const items = clone(ctx.buildBatchDraftUpdateItems());
  assert.equal(items[1].template_payload.description, drafts[1].template_payload.description);
  items.forEach((item, index) => assertCopy(item.template_payload, drafts[index].template_payload.description,
    drafts[index].template_payload.editable_payload.rich_content_json, drafts[index].effective_images[0]));
  assert.equal(JSON.stringify(drafts), before);
});

test("single draft normalization retains dynamic-only copy and explicit empty values", () => {
  const current = draft("HAVAL H9", 102), ctx = editor([current]);
  const variant = clone(current.template_payload.editable_payload.variants[0]);
  delete variant.description;
  delete variant.rich_content_json;
  ctx.templateEditor.variants = ctx.normalizeEditorVariants([variant]);
  const template = clone(ctx.buildTemplatePayload());
  assertCopy(template, current.template_payload.description, current.template_payload.editable_payload.rich_content_json, current.effective_images[0]);
  ctx.updateVariantAttributeSelectValue(ctx.templateEditor.variants[0], { attribute_id: 4191, type: "textarea" }, "");
  assert.equal(clone(ctx.buildTemplatePayload()).editable_payload.variants[0].description, "");
});

test("editing one row's description and rich content updates only that draft's saved copy", () => {
  const drafts = [draft("HAVAL F7", 101), draft("HAVAL H9", 102)], ctx = editor(drafts);
  ctx.templateEditor.variants = drafts.map(item => ctx.batchDraftVariant(item));
  const description = "Описание только для HAVAL H9.", image = drafts[1].effective_images[0];
  const richJson = rich("HAVAL H9", description, image);
  ctx.updateVariantAttributeSelectValue(ctx.templateEditor.variants[1], { attribute_id: 4191, type: "textarea" }, description);
  ctx.updateVariantAttributeSelectValue(ctx.templateEditor.variants[1], { attribute_id: 11254, type: "rich_json" }, richJson);
  const items = clone(ctx.buildBatchDraftUpdateItems());
  assertCopy(items[0].template_payload, drafts[0].template_payload.description, drafts[0].template_payload.editable_payload.rich_content_json, drafts[0].effective_images[0]);
  assertCopy(items[1].template_payload, description, richJson, image);
});

test("an explicit common copy edit is applied to every draft without changing each main image", () => {
  const drafts = [draft("HAVAL F7", 101), draft("HAVAL H9", 102)], ctx = editor(drafts);
  ctx.templateEditor.variants = drafts.map(item => ctx.batchDraftVariant(item));
  const description = "Общее описание, выбранное оператором.", richJson = rich("Common", description, "https://media.example/common.jpg");
  ctx.updateFixedField("summary", description);
  ctx.updateFixedField("richJson", richJson);
  const items = clone(ctx.buildBatchDraftUpdateItems());
  items.forEach((item, index) => assertCopy(item.template_payload, description, richJson, drafts[index].effective_images[0]));
});

test("an absent shared rich-content field does not regenerate over existing per-draft rich layouts", () => {
  const drafts = [draft("HAVAL F7", 101), draft("HAVAL H9", 102)], ctx = editor(drafts);
  ctx.templateEditor.variants = drafts.map(item => ctx.batchDraftVariant(item));
  ctx.fixedForm.value = { ...ctx.fixedForm.value, richJson: "" };
  ctx.richContentImageUrl = () => drafts[0].effective_images[0];
  ctx.generateRichContentJson = () => { throw new Error("shared automatic generation must not overwrite each draft"); };
  const items = clone(ctx.buildBatchDraftUpdateItems());
  items.forEach((item, index) => assertCopy(item.template_payload, drafts[index].template_payload.description,
    drafts[index].template_payload.editable_payload.rich_content_json, drafts[index].effective_images[0]));
});

test("common copy edits replace legacy aliases and their stale selections before save", () => {
  const drafts = [draft("HAVAL F7", 101), draft("HAVAL H9", 102)], ctx = editor(drafts);
  for (const current of drafts) {
    const dynamic = current.template_payload.editable_payload.variants[0].dynamic_attributes;
    dynamic.legacy_description = dynamic[4191]; delete dynamic[4191];
    dynamic.legacy_rich = dynamic[11254]; delete dynamic[11254];
  }
  ctx.templateEditor.variants = drafts.map(item => ctx.batchDraftVariant(item));
  const description = "Общее описание после проверки.", richJson = rich("Common", description, "https://media.example/common.jpg");
  ctx.updateFixedField("summary", description);
  ctx.updateFixedField("richJson", richJson);
  const items = clone(ctx.buildBatchDraftUpdateItems());
  items.forEach((item, index) => assertCopy(item.template_payload, description, richJson, drafts[index].effective_images[0]));
  for (const row of ctx.templateEditor.variants) {
    assert.equal(row.dynamic_attributes.legacy_description.value, description);
    assert.equal(row.dynamic_attributes.legacy_rich.value, richJson);
    assert.deepEqual(clone(row.dynamic_attributes.legacy_description.selected_values), []);
  }
});

test("returning a copy field to common mode removes every same-ID alias", () => {
  const drafts = [draft("HAVAL F7", 101), draft("HAVAL H9", 102)], ctx = editor(drafts);
  ctx.templateEditor.variants = drafts.map(item => ctx.batchDraftVariant(item));
  for (const row of ctx.templateEditor.variants) {
    row.dynamic_attributes.legacy_description = clone(row.dynamic_attributes[4191]);
    row.dynamic_attributes.legacy_rich = clone(row.dynamic_attributes[11254]);
  }
  ctx.moveVariantFieldBackToCommon("attr:4191");
  ctx.moveVariantFieldBackToCommon("attr:11254");
  const items = clone(ctx.buildBatchDraftUpdateItems());
  items.forEach((item, index) => assertCopy(item.template_payload, drafts[0].template_payload.description,
    drafts[0].template_payload.editable_payload.rich_content_json, drafts[index].effective_images[0]));
});
